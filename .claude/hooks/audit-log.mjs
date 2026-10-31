import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from './lib.mjs';

const MAX_INPUT = 2000;

export function auditRecord(input, now = new Date()) {
  const raw = JSON.stringify(input.tool_input ?? {});
  return {
    ts: now.toISOString(),
    session_id: input.session_id,
    tool: input.tool_name,
    input: raw.length > MAX_INPUT ? `${raw.slice(0, MAX_INPUT)}…` : raw,
  };
}

if (isMain(import.meta.url)) {
  // PostToolUse cannot block, and logging must never break a session.
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
    appendFileSync(path.join(projectDir, '.claude', 'audit.jsonl'), `${JSON.stringify(auditRecord(input))}\n`);
  } catch {
    // ignore
  }
  process.exit(0);
}
