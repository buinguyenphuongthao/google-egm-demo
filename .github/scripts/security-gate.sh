#!/usr/bin/env bash
# Usage: security-gate.sh <run-dir> <skill-dir> <expected-profile> <expected-sha>
# Passes only if the audit completed with the expected profile against the expected commit,
# findings.json and coverage-ledger.json are schema-valid, and no confirmed finding is high
# or critical. Prints counts only: this repo's job summaries are public.
set -euo pipefail

[ "$#" -eq 4 ] || { echo "usage: security-gate.sh <run-dir> <skill-dir> <expected-profile> <expected-sha>" >&2; exit 2; }
run_dir="$1"
skill_dir="$2"
expected_profile="$3"
expected_sha="$4"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

fail() {
  echo "::error::Security gate: $1"
  echo "**Security gate failed:** $1" >> "$summary"
  exit 1
}

meta="$run_dir/run-metadata.json"
[ -f "$meta" ] || fail "no run-metadata.json (audit did not run)"
[ -f "$run_dir/findings.json" ] || fail "no findings.json"
[ -f "$run_dir/coverage-ledger.json" ] || fail "no coverage-ledger.json"
# Validator output echoes field values (finding details); never let it reach public logs.
node "$skill_dir/validate-findings.cjs" "$run_dir/findings.json" > /dev/null 2>&1 || fail "findings.json failed schema validation"
node "$skill_dir/validate-coverage-ledger.cjs" "$run_dir/coverage-ledger.json" > /dev/null 2>&1 || fail "coverage-ledger.json failed validation"

# Agent-written strings are untrusted: only ever print values from a fixed allowlist.
raw_status=$(jq -r '.run_status // ""' "$meta" 2> /dev/null) || fail "run-metadata.json is not valid JSON"
case "$raw_status" in
  complete | incomplete | in_progress) status="$raw_status" ;;
  *) status="unknown" ;;
esac
profile=$(jq -r '.profile // ""' "$meta")
source_ref=$(jq -r '.source_ref // "" | if type == "string" then . else tojson end' "$meta")

counts=$(jq -r '
  def n(f): [.[] | select(f)] | length;
  "| critical | high | medium | low | info | needs validation |\n|---|---|---|---|---|---|\n| \(n(.verdict=="confirmed" and .severity.overall_severity=="critical")) | \(n(.verdict=="confirmed" and .severity.overall_severity=="high")) | \(n(.verdict=="confirmed" and .severity.overall_severity=="medium")) | \(n(.verdict=="confirmed" and .severity.overall_severity=="low")) | \(n(.verdict=="confirmed" and .severity.overall_severity=="informational")) | \(n(.verdict=="needs_validation")) |"
' "$run_dir/findings.json")

{
  echo "### Security audit"
  echo
  echo "Run status: \`$status\`"
  echo
  echo -e "$counts"
  echo
  echo "Details are in the encrypted \`security-audit-report\` artifact."
} >> "$summary"

[ "$profile" = "$expected_profile" ] || fail "run profile is not '$expected_profile'"
[ -n "$expected_sha" ] && [[ "$source_ref" == *"$expected_sha"* ]] || fail "source_ref does not match the checked-out commit"
[ "$status" = "complete" ] || fail "run_status is '$status', not 'complete'"
blocking=$(jq '[.[] | select(.verdict=="confirmed" and (.severity.overall_severity=="high" or .severity.overall_severity=="critical"))] | length' "$run_dir/findings.json")
[ "$blocking" -eq 0 ] || fail "$blocking confirmed high/critical finding(s)"
echo "Security gate passed." >> "$summary"
