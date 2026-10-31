import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && importMetaUrl === pathToFileURL(process.argv[1]).href;
}

/**
 * Runs a PreToolUse check. `check(input)` returns { decision: 'allow' | 'ask' | 'deny', reason }.
 * Any error exits 2, which blocks the tool call: guardrails fail closed.
 */
export function runPreToolUse(check) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const { decision, reason } = check(input);
    if (decision !== 'allow') {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: reason,
          },
        }),
      );
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`guardrail hook error, blocking to be safe: ${err?.message ?? err}\n`);
    process.exit(2);
  }
}

export const allow = { decision: 'allow' };
export const deny = (reason) => ({ decision: 'deny', reason });
export const ask = (reason) => ({ decision: 'ask', reason });
