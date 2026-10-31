# Agent-driven CI/CD pipeline: design

Date: 2026-10-31
Status: approved, ready for implementation planning

## Goal

Every deployment of a small full-stack app passes four gates first: AI code review, AI
security audit, Playwright E2E tests, and smoke tests. The app exists to give the pipeline
something real to gate; the pipeline is the product.

## Decisions

| Topic | Decision |
|---|---|
| App | Notes app (list, create, delete) built in this repo |
| Hosting | AWS, infrastructure in CDK (TypeScript) |
| CI system | GitHub Actions, deploying to AWS via OIDC (no long-lived keys) |
| Review agent auth | `CLAUDE_CODE_OAUTH_TOKEN` (Claude subscription) via `anthropics/claude-code-action` |
| Review gate | Blocks only on critical findings |
| Security gate | cloudflare/security-audit-skill, tiered: `quick` diff-scoped per PR (blocking), `standard` weekly (non-blocking) |
| Environments | Staging, then prod; smoke tests gate promotion |
| Stack depth | SPA + API + DynamoDB |
| Agent guardrails | Claude Code hooks 1-4 plus CI hardening (see below) |
| Repo visibility | Public (GitHub Free lacks branch protection on private repos). Workflows from external contributors need approval; audit details are encrypted (see "Public repo constraints") |
| Runtime | Node 22 (Node 20 reached end of life in April 2026) |

## 1. App and AWS architecture

```
Browser -> CloudFront -+- /*     -> S3 (private, OAC)                 SPA assets
                       +- /api/* -> API Gateway HTTP API -> Lambda -> DynamoDB
```

Repo layout (npm workspaces):

```
web/      Vite + React + TS SPA
api/      Lambda handlers (TS, Node 22), bundled with esbuild via CDK
infra/    CDK app: one parameterized stack, deployed as egm-staging and egm-prod
e2e/      Playwright specs (PR time, full UI flows)
smoke/    Playwright smoke specs (post-deploy, fast, read-mostly)
.claude/  settings, hooks, vendored security-audit skill
.github/workflows/  pr.yml, deploy.yml, security-weekly.yml
```

- One CloudFront domain for SPA and API: no CORS, one URL for tests.
- DynamoDB on-demand with TTL enabled (smoke data expires on its own); point-in-time
  recovery on prod only.
- Lambda role scoped to its own table. S3 bucket private, readable only via OAC.
- `/api/health` returns `{ status, version, dbOk }`; `version` is the git SHA injected at
  deploy time.
- Stack outputs the CloudFront URL for the workflows.
- `egm-github-oidc` bootstrap stack: GitHub OIDC provider plus a deploy role assumable only
  by this repo's `main` branch in the `staging` and `prod` GitHub Environments. Deployed
  manually, once.
- Expected cost: a few dollars a month or less; every component scales to zero.

## 2. Pipeline flow

All gates run on the PR. Branch protection makes them required and requires the branch to
be up to date with `main`, so the merged code is exactly the code that passed.

### `pr.yml` (parallel jobs)

| Job | What it does | Fails when |
|---|---|---|
| `build` | install, typecheck, lint, unit tests, `cdk synth`, hook tests | any step fails |
| `code-review` | `claude-code-action` reviews the diff, posts inline comments, writes `review-verdict.json` | any critical finding |
| `security-audit` | vendored skill in full audit mode, `quick` profile, scoped to `base...head`, then a `jq` gate on `findings.json` | any `confirmed` record with `severity.overall_severity` of `high` or `critical`, or `run_status` not complete |
| `e2e` | build SPA, run API locally against DynamoDB Local (service container), Playwright on Chromium | any test fails |

`needs_validation` security records are listed in the job summary but do not block.

### `deploy.yml` (push to `main`, `concurrency: deploy`)

```
build artifacts once (tagged with git SHA)
  -> deploy egm-staging   [Environment: staging, OIDC role]
  -> smoke vs staging URL
  -> deploy egm-prod      [Environment: prod]
  -> smoke vs prod URL
  -> move git tag prod-good to this SHA
```

Staging and prod ship the same artifact.

### `security-weekly.yml` (cron + `workflow_dispatch`)

`standard` full-repo audit of `main`. Uploads the encrypted report as an artifact and opens or
updates a GitHub issue (counts and run link only) when anything is confirmed. Never blocks
deploys.

### Smoke suite (under ~1 minute)

1. Poll `/api/health` until `version` equals the deployed SHA (up to ~2 minutes), then
   assert `status` ok and `dbOk` true.
2. SPA loads and renders the notes list.
3. API round-trip: create a note tagged `smoke-<sha>` with a 1-hour TTL, read it, delete it.

### Security-audit skill integration

- Vendored to `.claude/skills/security-audit/`, pinned to upstream commit
  `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (MIT). Never fetched from `main` in CI.
- The CI prompt explicitly requests full audit mode, the profile, and the diff scope; the
  skill defaults to guidance mode otherwise.
- Output directory is outside the checkout (the skill requires this). It is uploaded only as
  an encrypted artifact (see "Public repo constraints").
- CI runners lack the OS-level sandbox the skill requires for executing target code, so the
  audit is source-only. Runtime behavior is covered by E2E and smoke tests.

## 3. Failure handling and rollback

- **Agent failures fail closed.** No valid verdict (rate limit, timeout, malformed output)
  means a red check; re-run the job. An `incomplete` security run is a failure.
- **Timeouts:** `code-review` 15 min, `security-audit` 45 min, weekly audit 3 h.

| Failure | Outcome |
|---|---|
| Staging deploy or staging smoke fails | Prod untouched; run red |
| Prod deploy fails partway | CloudFormation rolls back the stack |
| Prod smoke fails | Rollback job: check out `prod-good`, rebuild, redeploy prod, smoke again. Run stays red |

- Rollback covers code and infrastructure, not data. Rule: **DynamoDB changes are additive
  only** (no renames or removals in the same release).
- Flakiness: E2E retries 2 with trace on first retry and HTML report uploaded; smoke retries 1.

## 4. Agent guardrails

Hooks are guardrails against mistakes and instruction drift, not a security boundary: they
match on text and can be bypassed by indirection. Hard limits come from IAM, token scopes,
and branch protection.

### Claude Code hooks (`.claude/settings.json` + `.claude/hooks/*.mjs`)

Simple patterns go in `permissions.deny`; logic goes in Node hook scripts (no `jq`
dependency).

1. **Dangerous-command guard** (PreToolUse `Bash`), denies: `git push --force`, push to
   `main`, `git reset --hard`, `git clean -fdx`, `rm -rf` outside scratch; `cdk deploy`,
   `cdk destroy`, mutating `aws` calls (`delete-*`, `put-*`, `update-*`),
   `secretsmanager get-secret-value`; `gh repo delete`, `gh pr merge`, `gh secret`,
   `gh api -X DELETE`; `curl ... | sh`; `npm publish`.
2. **Protected-files guard** (PreToolUse `Edit`/`Write`): deny edits to
   `.claude/settings*.json`, `.claude/hooks/**`, `.claude/skills/security-audit/**`, the
   OIDC bootstrap stack, `.env*`. Ask (not deny) for `.github/workflows/**`.
3. **Secret scanner** (PreToolUse `Edit`/`Write`): deny content matching AWS access keys,
   `sk-ant-` keys, `gho_`/`ghp_` tokens, or private-key blocks.
4. **Audit log** (PostToolUse, all tools): append each call to `.claude/audit.jsonl`
   (gitignored); CI uploads it as an artifact.

Deferred: a Stop hook that blocks completion when typecheck or tests fail. Add once the
suite is stable.

`.claude/hooks/test.mjs` feeds sample tool-call JSON to each hook and asserts allow/deny. It
runs in the `build` job.

### CI hardening

- Review and audit jobs restore `.claude/` from `main` before the agent runs, so a PR cannot
  disable the hooks that review it.
- Review and audit jobs get no AWS credentials. Only `deploy.yml` assumes the OIDC role.
- Minimal `GITHUB_TOKEN` permissions: `contents: read`, `pull-requests: write` for review jobs.
- Agents run with an explicit read-only tool allowlist (Read, Grep, Glob, read-only git).
- Branch protection blocks force pushes and direct pushes to `main`.

### Public repo constraints

Logs, job summaries, artifacts, and issues are world-readable. Secrets are not, and fork PRs
never receive them.

- **Never use `pull_request_target`.** It hands secrets to fork PR code. Workflows use
  `pull_request` only.
- Workflow runs from external contributors require maintainer approval (repo setting).
- Fork PRs run without `CLAUDE_CODE_OAUTH_TOKEN`, so `code-review` and `security-audit` fail
  closed on them. A maintainer reviews such PRs and re-pushes them from a branch.
- **Audit details are never public.** Job summaries and issues show only counts by severity
  and verdict. The full audit output plus `.claude/audit.jsonl` is tarred and encrypted with
  [age](https://github.com/FiloSottile/age) to the public key in
  `.github/audit-recipient.txt`, then uploaded as an artifact. The private key stays on the
  maintainer's machine. Decrypt with `age -d -i <key> report.tar.gz.age | tar xz`.
- The review agent's PR comments are public. That is acceptable: they describe the PR's own
  unmerged diff, which is already public.

### Known residual risk

A malicious PR could attempt prompt injection against the review agent. Accepted for a
private repo with trusted contributors; tests and the independent security gate are backstops.

## 5. One-time setup (documented in `docs/setup.md`)

1. Choose AWS account and region; `cdk bootstrap`; deploy `egm-github-oidc` locally.
2. Create GitHub Environments `staging` and `prod`; set the deploy role ARN as an
   environment variable.
3. `claude setup-token`; store as repo secret `CLAUDE_CODE_OAUTH_TOKEN`.
3a. `age-keygen -o ~/.config/egm/audit-key.txt`; commit the printed public key to
    `.github/audit-recipient.txt`. Never commit or share the private key.
4. Branch protection on `main`: required checks `build`, `code-review`, `security-audit`,
   `e2e`; up to date before merge; no force pushes.

## 6. Testing

- Unit: Vitest for API handlers and validation.
- Infra: CDK assertion tests (TTL enabled, Lambda role limited to its table ARN).
- E2E: Playwright full UI flows. Smoke: as above.
- Hooks: `.claude/hooks/test.mjs`.
- **Gate verification:** throwaway PRs, each built to trip exactly one gate:

| PR | Expected |
|---|---|
| Deliberate bug (unchecked delete, injection-prone query) | `code-review` red |
| Unauthenticated bulk-read endpoint or IAM wildcard | `security-audit` red |
| Broken "create note" button | `e2e` red |
| Health endpoint returns wrong version (manual deploy from branch) | staging smoke red, prod untouched |
| PR that only removes hooks from `.claude/settings.json` | review still runs with `main`'s hooks |

## Build order

1. Monorepo scaffold and app
2. Infra stack and OIDC bootstrap stack
3. `pr.yml` with `build` and `e2e`
4. Hooks and hook tests
5. `code-review` gate
6. `security-audit` gate (vendor skill)
7. `deploy.yml` with smoke and rollback
8. `security-weekly.yml`
9. Gate-verification PRs

## Out of scope (v1)

Canary or blue/green deploys, security-gate override label, Slack notifications,
multi-region, per-PR preview stacks.
