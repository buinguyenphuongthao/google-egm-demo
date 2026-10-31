# Threat model

## What the app is

A public, anonymous notes board. **By design**, anyone on the internet may list, create, and
delete any note. There are no user accounts. Notes must not contain personal data; the UI
does not ask for any.

## Intended behavior (not findings)

- Unauthenticated list/create/delete of notes.
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
