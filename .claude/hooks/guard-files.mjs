import path from 'node:path';
import { allow, ask, deny, isMain, runPreToolUse } from './lib.mjs';

// Matched against the absolute path, so user-level ~/.claude settings are covered too.
// Patterns are case-insensitive because the default macOS filesystem is.
const ANYWHERE = [
  [/(^|\/)\.claude\/settings(\.local)?\.json$/i, 'Claude settings are protected so agents cannot disable guardrails. Ask the user.'],
  [/(^|\/)\.env(\.[\w-]+)?$/i, '.env files may hold secrets and are protected.'],
];

// Matched against the project-relative path.
const PROJECT_DENY = [
  [/^\.claude\/hooks\//i, 'Hook scripts are protected so agents cannot disable their own guardrails. Ask the user.'],
  [/^\.claude\/skills\/security-audit\//i, 'The security-audit skill is vendored and pinned. The user upgrades it per CLAUDE.md.'],
  [/^\.claude\/audit\.jsonl$/i, 'The audit log is append-only and written by hooks.'],
  [/^infra\/lib\/github-oidc-stack\.ts$/i, 'The OIDC trust stack is protected. Ask the user.'],
  [/^\.github\/audit-recipient\.txt$/i, 'The audit encryption key is protected. Ask the user.'],
];
const PROJECT_ASK = [[/^\.github\/workflows\//i, 'Workflow changes affect the deployment gates. Confirm this edit.']];

export function checkFileWrite({ filePath, projectDir, writeRoot }) {
  const abs = path.resolve(projectDir, filePath);
  for (const [pattern, reason] of ANYWHERE) {
    if (pattern.test(abs)) return deny(reason);
  }
  if (writeRoot) {
    const root = path.resolve(writeRoot);
    return abs === root || abs.startsWith(root + path.sep)
      ? allow
      : deny(`This CI job may only write under ${root}.`);
  }
  const rel = path.relative(projectDir, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) return allow;
  for (const [pattern, reason] of PROJECT_DENY) {
    if (pattern.test(rel)) return deny(reason);
  }
  for (const [pattern, reason] of PROJECT_ASK) {
    if (pattern.test(rel)) return ask(reason);
  }
  return allow;
}

if (isMain(import.meta.url)) {
  runPreToolUse((input) => {
    const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (typeof filePath !== 'string') throw new Error('no file path in tool input');
    return checkFileWrite({
      filePath,
      projectDir: process.env.CLAUDE_PROJECT_DIR ?? input.cwd,
      writeRoot: process.env.AGENT_WRITE_ROOT,
    });
  });
}
