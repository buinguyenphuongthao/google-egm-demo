# Threat model

## What the app is

An owner-only notes board. Only the owner's allowlisted IPv4 addresses, and CI smoke tests
carrying a secret token, can reach staging or prod; everyone else gets 403 at the edge.
Within that boundary there are no user accounts: anyone admitted may list, create, and
delete any note. Notes must not contain personal data; the UI does not ask for any.

## Intended behavior (not findings)

- No per-user authentication: an admitted request may list/create/delete any note.
- Notes expire after 7 days (DynamoDB TTL; smoke-test notes after 1 hour). TTL deletion is
  eventual, so an expired note may still be listed for a while.
- List returns at most 1000 notes, newest first among those scanned. Past that cap a note
  may exist but not be listed.
- `/api/health` reveals the deployed git SHA to admitted callers (the repo is public anyway).
- The raw execute-api URL exists but returns 403: the Lambda accepts only requests carrying
  CloudFront's `x-origin-verify` header.
- Only IPv4 is allowlisted; IPv6 is disabled on both distributions.

## Trust boundaries that matter

| Boundary | Expectation |
|---|---|
| Internet -> CloudFront | The `owner-only` CloudFront Function admits only `ip:<addr>` keys or a matching `x-egm-smoke-token` from the environment's KeyValueStore, and fails closed. Any fail-open path is a finding. |
| CloudFront -> API origin | The Lambda rejects requests without the `x-origin-verify` secret (Secrets Manager, resolved at deploy). |
| Browser -> API | All input untrusted. Body <= 4 KB, text <= 500 chars, tag `[a-z0-9-]{1,40}`. |
| API -> DynamoDB | Lambda role limited to its own table. No other AWS access. |
| Note text -> other viewers' browsers | Rendered as text only. Any HTML/script execution is a vulnerability (stored XSS). |
| Internet -> cost | API Gateway throttles at 10 rps / burst 20. Unbounded spend paths are findings. |
| PR author -> CI | PR content must not reach secrets, AWS credentials, or the deploy role. Workflows use `pull_request`, never `pull_request_target`. |
| CI -> AWS | Only `deploy.yml` jobs in `staging`/`prod` environments may assume `egm-github-deploy`. |
| Agents -> repo/infra | `.claude/` hooks block dangerous commands and edits to guardrail files. |

## In scope for findings

Injection, XSS, IAM wider than needed, secrets exposure, CI privilege escalation,
supply-chain risks in workflows, data exposure beyond the notes table, unbounded cost.

## Residual risks (accepted, with mitigations)

These are known and accepted. Report them only if a change makes them worse or removes a
listed mitigation.

1. **PR-controlled gate definitions.** `pull_request` workflows run from the PR's own files,
   so a PR can edit workflows, composite actions, `.github/scripts/`, or `.claude/` and make
   the required checks pass. Mitigations:
   - Workflow runs from all external contributors need maintainer approval (repo setting).
   - The maintainer reviews, line by line, any change under `.github/` or `.claude/`, and
     any change to `CLAUDE.md` or `docs/threat-model.md`, before merging.
   - The `build` job prints a warning and a step summary listing changed gate/guardrail
     paths, and the code-review agent posts a 🟡 Warning on such diffs.
   - Branch protection applies to admins too (`enforce_admins`), so nobody merges around
     the checks.
   - Review and audit jobs restore `.claude/`, `CLAUDE.md`, `docs/threat-model.md`,
     `.mcp.json`, and the audit recipient from the base branch, and delete nested
     `CLAUDE.md` files, so an unmodified workflow cannot be steered by PR-supplied guardrails.
2. **Prompt injection against CI agents.** The repo is public, so any PR text, code, or
   comment can try to steer the review or audit agent. Mitigations:
   - Agents run with a read-only tool allowlist (the audit agent may write only under its
     output directory) and have no AWS credentials.
   - Checkouts for agent jobs do not persist git credentials.
   - CI agents are denied reading `.git` and `/proc`, so they cannot recover tokens from git
     config or process environments.
   - Public output is counts only; full audit output is encrypted. The review verdict is a
     schema-constrained count, and only critical findings fail the check.
3. **IP allowlisting admits everyone behind the owner's IP** (shared office Wi-Fi, carrier
   NAT). Accepted for a demo; the owner removes stale IPs with `npm run access -- remove`.
4. **Smoke token leak.** Anyone with the token bypasses the IP check. Mitigations: it lives
   only in a GitHub environment secret and the KeyValueStore; the edge strips the header
   before the origin; `npm run access` never prints it; smoke failure reports are encrypted
   before upload. Rotate with `npm run access -- rotate-smoke-token <env>`.
5. **Origin secret visible to account admins.** The resolved `x-origin-verify` value appears
   in the Lambda and CloudFront configuration. Only the owner has account access.
