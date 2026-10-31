#!/usr/bin/env bash
# Usage: security-gate.sh <run-dir> <skill-dir>
# Passes only if the audit completed, findings.json is schema-valid, and no confirmed
# finding is high or critical. Prints counts only: this repo's job summaries are public.
set -euo pipefail

run_dir="$1"
skill_dir="$2"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

fail() {
  echo "::error::Security gate: $1"
  echo "**Security gate failed:** $1" >> "$summary"
  exit 1
}

[ -f "$run_dir/run-metadata.json" ] || fail "no run-metadata.json (audit did not run)"
[ -f "$run_dir/findings.json" ] || fail "no findings.json"
node "$skill_dir/validate-findings.cjs" "$run_dir/findings.json" > /dev/null || fail "findings.json failed schema validation"

status=$(jq -r '.run_status' "$run_dir/run-metadata.json")
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

[ "$status" = "complete" ] || fail "run_status is '$status', not 'complete'"
blocking=$(jq '[.[] | select(.verdict=="confirmed" and (.severity.overall_severity=="high" or .severity.overall_severity=="critical"))] | length' "$run_dir/findings.json")
[ "$blocking" -eq 0 ] || fail "$blocking confirmed high/critical finding(s)"
echo "Security gate passed." >> "$summary"
