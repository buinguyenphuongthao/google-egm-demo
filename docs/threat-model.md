# Threat model

## What the app is

A public, anonymous notes board. **By design**, anyone on the internet may list, create, and
delete any note. There are no user accounts. Notes must not contain personal data; the UI
does not ask for any.

## Intended behavior (not findings)

- Unauthenticated list/create/delete of notes.
- Notes expire after 7 days (DynamoDB TTL; smoke-test notes after 1 hour). TTL deletion is
  eventual, so an expired note may still be listed for a while.
- List returns at most 1000 notes, newest first among those scanned. Past that cap a note
  may exist but not be listed.
- `/api/health` publicly reveals the deployed git SHA (the repo is public anyway).
- The API is reachable both via CloudFront `/api/*` and the raw execute-api URL.

## Trust boundaries that matter

| Boundary | Expectation |
|---|---|
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
