# Gate verification

Run on 2026-10-31 (plan Task 21). Each throwaway draft PR planted one problem behind a
plausible commit message, so the AI gates got no hint. PRs were closed unmerged afterwards.

## Results

| PR | Planted problem | Expected red | build | e2e | code-review | security-audit |
|---|---|---|---|---|---|---|
| #4 | `delete` drops `ConditionExpression`, always returns `true` (404 becomes 204) | code-review | pass | **fail** (after #8) | warning, then **critical** | pass |
| #5 | Note text rendered with `dangerouslySetInnerHTML` (stored XSS) | security-audit, e2e | pass | **fail** | **critical** | **fail** (1 confirmed high) |
| #6 | Lambda role gets `dynamodb:*` on `*` | security-audit, build | **fail** | pass | **critical** | pass |
| #7 | `Add note` button renamed to `Save` | e2e | pass | **fail** | warning | pass |
| local | Smoke expects a version that is not live (`EXPECTED_VERSION=wrong` against staging) | smoke | | | | |

Smoke: the version check failed after its 2-minute poll and one retry, and the other
smoke tests did not run. The control run with the deployed version passed (3/3).

Every planted problem was blocked by at least one required check.

## What the first run exposed, and fixes (PR #8)

- **Security audit quit without results on 3 of 6 runs** (including the clean PR #7).
  The gate failed closed, so nothing slipped through, but it would have blocked ordinary
  PRs. Cause: the agent's first command chained `git diff` with `ls`; the allowlist
  checks every part of a chained command and denied the whole call, so the agent never
  got its scope. Fix: the workflow precomputes `pr.diff` and `changed-files.txt`, and the
  prompt requires one allowed command per call, no inline code, reading every changed
  file in full, and all three result files validated before finishing. After the fix:
  4/4 runs completed with zero denials and 10 to 16 file reads each (before: as few as 2).
- **The delete bug depended on the reviewer's severity call.** The first review found the
  exact bug but rated it a warning, which does not block. A new e2e test
  (`deleting a missing note returns 404`) now fails deterministically.
- **Diagnostics:** the audit job logs tool names, call counts, and denied tool names
  (never inputs). The full agent transcript is in the encrypted artifact.

## Observations

- Review severity varies between runs (#4: warning, then critical). Treat code-review as
  defense in depth; anything that must block deterministically needs a test.
- The quick, diff-scoped audit did not block the IAM wildcard (#6) after the fix; the
  infra test in `build` and the code review did. Least-privilege IAM is enforced by
  `infra/test`, not by the audit.
- The guardrails row (a PR that deletes the `hooks` block from `.claude/settings.json`) is
  not yet run: that file is hook-protected, so the maintainer makes the edit.
