# google-egm-demo

Demo of an agent-driven CI/CD pipeline. A small Notes app (SPA + API + DynamoDB on AWS)
exists mainly to give the pipeline something real to gate. Every deploy must pass four gates:
AI code review, AI security audit, Playwright E2E tests, and post-deploy smoke tests.

> Status: design in progress (brainstorming). The design doc will live in
> `docs/plans/`. Directories below are planned, not yet scaffolded. Update this file
> as pieces land; keep it describing what IS, not what was planned.

## Architecture

```
Browser -> CloudFront -+- /*     -> S3 (private, OAC)                 SPA assets
                       +- /api/* -> API Gateway HTTP API -> Lambda -> DynamoDB
```

- One CloudFront domain serves both SPA and API: no CORS, one URL for tests.
- One parameterized CDK stack, deployed twice: `egm-staging` and `egm-prod`.
- `egm-github-oidc` is a one-time bootstrap stack (GitHub OIDC provider + deploy role
  restricted to this repo's `main` branch and the `staging`/`prod` environments).
  It is deployed manually, never by CI.
- `/api/health` returns `{ status, version, dbOk }`; `version` is the git SHA injected
  at deploy time. Smoke tests rely on this to prove the right build is live.

## Repo layout (npm workspaces)

| Path | Contents |
|---|---|
| `web/` | Vite + React + TypeScript SPA |
| `api/` | Lambda handlers (TypeScript, Node 20), bundled by CDK via esbuild |
| `infra/` | CDK app (TypeScript) |
| `e2e/` | Playwright specs run on PRs against a local build + DynamoDB Local |
| `smoke/` | Playwright smoke specs run after each deploy against the live URL |
| `.claude/skills/security-audit/` | Vendored copy of cloudflare/security-audit-skill |
| `.github/workflows/` | `pr.yml`, `deploy.yml`, `security-weekly.yml` |
| `docs/plans/` | Design docs and implementation plans |

## Pipeline

- **`pr.yml`** (required checks via branch protection; branch must be up to date):
  - `build`: typecheck, lint, unit tests, `cdk synth`
  - `code-review`: `anthropics/claude-code-action` with `CLAUDE_CODE_OAUTH_TOKEN`. Posts
    inline comments and writes `review-verdict.json`. Fails only on critical findings.
  - `security-audit`: security-audit skill, full audit mode, `quick` profile, scoped to
    the PR diff. Fails on any `confirmed` finding with `overall_severity` high or critical.
    `needs_validation` items are reported, not blocking.
  - `e2e`: Playwright (Chromium) against local SPA + API + DynamoDB Local.
- **`deploy.yml`** (push to `main`, serialized): build once -> deploy staging -> smoke
  staging -> deploy prod -> smoke prod. Staging and prod ship the same artifact.
- **`security-weekly.yml`** (cron + manual): `standard` full-repo audit; opens/updates an
  issue on confirmed findings. Never blocks deploys.

## Conventions

- TypeScript everywhere, `strict` mode on.
- All AWS infrastructure goes through CDK in `infra/`. No click-ops, no ad hoc CLI changes.
- AWS resource names and descriptions use hyphens, never em dashes.
- Least privilege: the Lambda role gets access to its own table only; the deploy role is
  scoped to this repo via OIDC. No long-lived AWS keys anywhere.
- Secrets live in GitHub Actions secrets (`CLAUDE_CODE_OAUTH_TOKEN`). Never commit `.env`
  files, tokens, or AWS account IDs in plain text where avoidable.
- Smoke tests must be safe against prod: they only create data tagged `smoke-<sha>` with a
  short DynamoDB TTL, and clean up after themselves.
- E2E tests own the full UI flows; smoke tests stay small (under ~1 minute) and read-mostly.

## Security-audit skill

- Vendored from https://github.com/cloudflare/security-audit-skill (MIT), pinned to
  commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`. Do not fetch it from `main` in CI.
- To upgrade: review the upstream diff, replace the vendored copy, update the pinned SHA here.
- Audit output goes outside the repo checkout (the skill requires this); CI uploads it as
  a workflow artifact.

## Git

- `main` is protected; all changes go through PRs that pass every gate.
- Remote: `github.com/buinguyenphuongthao/google-egm-demo` (private).
