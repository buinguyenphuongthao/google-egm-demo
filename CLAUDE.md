# google-egm-demo

Demo of an agent-driven CI/CD pipeline. A small Notes app (SPA + API + DynamoDB on AWS)
exists mainly to give the pipeline something real to gate. Every deploy must pass four gates:
AI code review, AI security audit, Playwright E2E tests, and post-deploy smoke tests.

> Status: implemented. Design: `docs/plans/2026-10-31-agent-cicd-pipeline-design.md`.
> Setup: `docs/setup.md`. Keep this file describing what IS, not what was planned.

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
| `api/` | Lambda handler (TypeScript, Node 22 runtime), bundled by CDK via esbuild; local dev server |
| `infra/` | CDK app (TypeScript): app stack and `egm-github-oidc` bootstrap stack |
| `e2e/` | Playwright specs run on PRs against a local build + DynamoDB Local |
| `smoke/` | Playwright smoke specs run after each deploy against the live URL |
| `.claude/hooks/`, `.claude/settings.json` | Agent guardrail hooks (see below) |
| `.claude/skills/security-audit/` | Vendored copy of cloudflare/security-audit-skill |
| `.github/workflows/` | `pr.yml`, `deploy.yml` (+ reusable `_deploy-stage.yml`), `security-weekly.yml` |
| `.github/actions/` | Composite actions: `setup`, `base-guardrails`, `encrypt-upload` |
| `.github/scripts/` | `security-gate.sh` (audit verdict gate) and its tests |
| `docs/` | `setup.md` (one-time setup), `threat-model.md`, `plans/` (design + plan) |

## Commands

```
npm run db:local     # start DynamoDB Local (Docker)
npm run dev -w api   # API on :3001
npm run dev -w web   # SPA with /api proxy
npm test             # unit, infra, gate-script, and hook tests
npm run test:e2e     # Playwright against local build + DynamoDB Local
npm run synth -w infra
```

## Pipeline

- **`pr.yml`** (required checks via branch protection; branch must be up to date):
  - `build`: typecheck, lint, `npm test`, SPA build, `cdk synth`
  - `code-review`: `anthropics/claude-code-action` with `CLAUDE_CODE_OAUTH_TOKEN`. Posts
    inline comments and writes `review-verdict.json`. Fails only on critical findings.
  - `security-audit`: security-audit skill, full audit mode, `quick` profile, scoped to
    the PR diff. Fails on any `confirmed` finding with `overall_severity` high or critical.
    `needs_validation` items are reported, not blocking.
  - `e2e`: Playwright (Chromium) against local SPA + API + DynamoDB Local.
- **`deploy.yml`** (push to `main`, serialized): build once -> deploy staging -> smoke
  staging -> deploy prod -> smoke prod. Staging and prod ship the same artifact.
- **`security-weekly.yml`** (cron + manual): `standard` full-repo audit; opens/updates an
  issue (counts only) on confirmed findings. Never blocks deploys.

## Public repo rules

This repo is public: logs, job summaries, artifacts, and issues are world-readable.

- Never use `pull_request_target` in any workflow. It exposes secrets to fork PR code.
- Never print security finding details (titles, traces, file paths) to logs, summaries,
  issues, or PR comments. Publish counts only. Full audit output is encrypted with age to
  `.github/audit-recipient.txt` before upload.
- Never read, print, or commit the age private key (`~/.config/egm/audit-key.txt`).

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
- DynamoDB changes are additive only (new attributes/indexes; no renames or removals in the
  same release). Rollback redeploys code, not data, so the previous version must still work.

## Failure handling

- Agent gates fail closed: no valid verdict means a red check. An `incomplete` security
  run is a failure, not a pass.
- If prod smoke fails, `deploy.yml` redeploys the commit at git tag `prod-good`. The tag
  moves only after a successful prod smoke run. Never move it by hand.

## Agent guardrails

- Hooks in `.claude/settings.json` and `.claude/hooks/` block dangerous commands, edits to
  protected files (including the hooks themselves), and secrets in written content; every
  tool call is logged to `.claude/audit.jsonl` (gitignored).
- Hooks are guardrails, not a security boundary. Do not try to work around a blocked
  action; stop and ask the user instead.
- If a hook blocks something you need, stop and ask the user. Hook and settings changes
  are made by the user, not agents.
- Hook scripts (and `security-gate.sh`) are tested by `npm run test:guards`, which
  `npm test` also runs.
- In CI, review and audit jobs restore `.claude/` from `main`, run with a read-only tool
  allowlist, and have no AWS credentials. Only `deploy.yml` can touch AWS.

## Security-audit skill

- Vendored from https://github.com/cloudflare/security-audit-skill (MIT), pinned to
  commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`. Do not fetch it from `main` in CI.
- To upgrade: review the upstream diff, replace the vendored copy, update the pinned SHA here.
- Audit output goes outside the repo checkout (the skill requires this); CI uploads it as
  a workflow artifact.

## Git

- `main` is protected; all changes go through PRs that pass every gate.
- Remote: `github.com/buinguyenphuongthao/google-egm-demo` (public). Workflow runs from
  external contributors require maintainer approval.
