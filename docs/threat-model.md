# Threat model

## What the app is

An owner-only Kanban board (projects, columns, cards, labels; design in
`docs/plans/2026-10-31-kanban-board-design.md`). The board API stores everything in the
`Board` table. The retired `Notes` table stays in the stack, but no code or role can reach
it. Only the owner's allowlisted IPv4 addresses, and CI smoke tests carrying a secret token,
can reach staging or prod; everyone else gets 403 at the edge. Within that boundary there
are no user accounts: anyone admitted may read, create, change, and delete any board item.
Board items must not contain personal data; the UI does not ask for any.

## Intended behavior (not findings)

- No per-user authentication: an admitted request may read/create/change/delete any
  project, column, card, or label.
- Board data does not expire, except: a card in its project's done column expires 7 days
  after entering it, and everything in a smoke project (named `smoke-` when created)
  expires 1 hour after the project was created. The board API treats items past
  `expiresAt` as absent. Growth is bounded by soft caps instead: 50 projects (smoke
  projects not counted); per project 20 columns, 1000 cards, 30 labels. Concurrent
  creates may exceed a cap by one.
- Board writes are last-write-wins, with no transactions: a project delete removes
  children first and the project last, and a label delete leaves its ID on cards, which
  reads ignore.
- `/api/health` reveals the deployed git SHA to admitted callers (the repo is public anyway).
- The raw execute-api URL exists but returns 403: the Lambda accepts only requests carrying
  CloudFront's `x-origin-verify` header.
- Only IPv4 is allowlisted; IPv6 is disabled on both distributions.

## Trust boundaries that matter

| Boundary | Expectation |
|---|---|
| Internet -> CloudFront | The `owner-only` CloudFront Function admits only `ip:<addr>` keys or a matching `x-egm-smoke-token` from the environment's KeyValueStore, and fails closed. Any fail-open path is a finding. |
| CloudFront -> API origin | The Lambda rejects requests without the `x-origin-verify` secret (Secrets Manager, resolved at deploy). |
| Browser -> API | All input untrusted. Body <= 16 KB; project name 1-80, column name 1-40, card title 1-200, description 0-2000, label name 1-30 (Unicode code points, trimmed); label color one of 8 fixed names, never raw CSS; rank 1-64 chars of the fractional-indexing alphabet; `labelIds` <= 30, unique. Every ID must belong to the project in the path. IDs, `expiresAt`, and `doneAt` are set by the server only. |
| API -> DynamoDB | Lambda role limited to the `Board` table. No other AWS access; any access to `Notes` is a finding. |
| User text -> browser | Every board name, title, description, and label name is rendered as text only. Any HTML/script execution is a vulnerability (stored XSS). |
| Internet -> cost | API Gateway throttles at 10 rps / burst 20; board caps bound stored data. Unbounded spend paths are findings. |
| PR author -> CI | PR content must not reach secrets, AWS credentials, or the deploy role. Workflows use `pull_request`, never `pull_request_target`. |
| CI -> AWS | Only `deploy.yml` jobs in `staging`/`prod` environments may assume `egm-github-deploy`. |
| Agents -> repo/infra | `.claude/` hooks block dangerous commands and edits to guardrail files. |

## In scope for findings

Injection, XSS, IAM wider than needed, secrets exposure, CI privilege escalation,
supply-chain risks in workflows, data exposure beyond the board table, unbounded cost.

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
   NAT). Since board data does not expire, they can read or delete long-lived projects.
   Accepted for a demo. Mitigations: the owner removes stale IPs with
   `npm run access -- remove`; the UI asks for confirmation before deletes; the `Board`
   table has point-in-time recovery in prod.
4. **Smoke token leak.** Anyone with the token bypasses the IP check. Mitigations: it lives
   only in a GitHub environment secret and the KeyValueStore; the edge strips the header
   before the origin; `npm run access` never prints it; smoke failure reports are encrypted
   before upload. Rotate with `npm run access -- rotate-smoke-token <env>`.
5. **A prod rollback to a commit without the lock re-opens prod** until a fix ships. Only
   the first locked deploy can hit this: once its prod smoke passes, `prod-good` moves to a
   locked commit. The KeyValueStore exists in both versions, so its data survives.
6. **Origin secret visible to account admins.** The resolved `x-origin-verify` value appears
   in the Lambda and CloudFront configuration. Only the owner has account access.
