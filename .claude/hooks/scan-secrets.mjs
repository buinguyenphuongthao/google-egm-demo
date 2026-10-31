import { allow, deny, isMain, runPreToolUse } from './lib.mjs';

const PATTERNS = [
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS access key ID'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/\bgh[opsu]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
];

export function findSecret(text) {
  for (const [pattern, label] of PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

export function contentOf(toolInput) {
  return [toolInput.content, toolInput.new_string, toolInput.new_source, ...(toolInput.edits ?? []).map((e) => e.new_string)]
    .filter((s) => typeof s === 'string')
    .join('\n');
}

if (isMain(import.meta.url)) {
  runPreToolUse((input) => {
    const label = findSecret(contentOf(input.tool_input ?? {}));
    return label ? deny(`Content looks like a secret (${label}). Never write credentials to files.`) : allow;
  });
}
