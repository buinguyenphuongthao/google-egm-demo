import { execFileSync } from 'node:child_process';
import { allow, deny, isMain, runPreToolUse } from './lib.mjs';

// Pattern guardrails. They stop mistakes and instruction drift, not a determined attacker;
// IAM, token scopes, and branch protection are the real boundary.
const RULES = [
  [/\bgit\s+reset\s+[^;&|]*--hard\b/, 'git reset --hard discards work. Ask the user first.'],
  [/\bgit\s+clean\s+[^;&|]*-[a-zA-Z]*f/, 'git clean -f deletes untracked files. Ask the user first.'],
  [/\b(npx\s+)?cdk\s+(deploy|destroy)\b/, 'Deploys run only in deploy.yml or by the user. Ask the user to run it with `!`.'],
  [
    /\baws\s+\S+\s+(delete|put|update|create|remove|terminate|attach|detach|modify|disable|stop)-/,
    'Mutating AWS CLI calls are blocked. Change infrastructure through CDK and the pipeline.',
  ],
  [/\baws\s+s3\s+(rm|rb|mv|sync|cp)\b/, 'Mutating S3 commands are blocked. Ask the user.'],
  [/\b(batch-)?get-secret-value\b/, 'Reading secret values is blocked. Use {{resolve:secretsmanager:...}} with asm-exec.'],
  [/\bgh\s+repo\s+(delete|archive|edit|rename)\b/, 'Repository settings changes are blocked. Ask the user.'],
  [/\bgh\s+pr\s+merge\b/, 'Merging is a human decision after all gates pass.'],
  [/\bgh\s+(secret|variable)\b/, 'Secrets and variables are managed by the user. Ask them to run it with `!`.'],
  [/\bgh\s+api\b[^;&|]*(-X|--method)\s*(DELETE|PUT|PATCH|POST)\b/i, 'Mutating GitHub API calls are blocked. Ask the user.'],
  [
    /\bgh\s+api\b(?![^;&|]*(-X|--method)\s*GET)[^;&|]*\s(-f|-F|--field|--raw-field|--input)\b/,
    'gh api with fields sends a POST. Mutating GitHub API calls are blocked. Ask the user.',
  ],
  [/\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'Piping downloads into a shell is blocked.'],
  [/\bnpm\s+publish\b/, 'Publishing packages is blocked.'],
];

// Case-insensitive because the default macOS filesystem is: `.Claude/Settings.json` is the same file.
const PROTECTED_PATH = /\.claude\/(settings[\w.-]*\.json|hooks\/|skills\/security-audit\/)|infra\/lib\/github-oidc-stack\.ts|\.github\/audit-recipient\.txt/i;
const WRITE_OP = /(>|\bsed\s+-i|\btee\b|\bmv\b|\brm\b|\bcp\b|\bchmod\b|\bln\b|\btruncate\b|\bgit\s+(checkout|restore|rm)\b)/;
const SAFE_RM_TARGET = /^(\.\/)?([\w.-]+\/)*(node_modules|dist|cdk\.out|test-results|playwright-report|coverage)\/?$/;
const PROTECTED_BRANCHES = new Set(['main', 'master']);

function checkRm(args) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const recursive = tokens.some((t) => t === '--recursive' || /^-[a-zA-Z]*[rR]/.test(t));
  if (!recursive) return null;
  const targets = tokens.filter((t) => !t.startsWith('-'));
  if (targets.length > 0 && targets.every((t) => SAFE_RM_TARGET.test(t))) return null;
  return 'Recursive rm is limited to build output (node_modules, dist, cdk.out, test-results, playwright-report, coverage). Ask the user.';
}

function checkPush(args, currentBranch) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.some((t) => t === '--force' || t === '--mirror' || t.startsWith('--force-with-lease') || /^-[a-zA-Z]*f/.test(t))) {
    return 'Force pushes are blocked. Open a PR instead.';
  }
  const positional = tokens.filter((t) => !t.startsWith('-'));
  const refspecs = positional.slice(1);
  if (refspecs.some((r) => r.startsWith('+'))) return 'Force pushes are blocked. Open a PR instead.';
  const destinations = refspecs.length
    ? refspecs.map((r) => (r.includes(':') ? r.split(':').pop() : r).replace(/^refs\/heads\//, ''))
    : [currentBranch];
  const resolved = destinations.map((d) => (d === 'HEAD' ? currentBranch : d));
  if (resolved.some((d) => PROTECTED_BRANCHES.has(d))) {
    return 'Pushing to main is blocked. Push a feature branch and open a PR.';
  }
  return null;
}

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function checkCommand(command, { currentBranch = '' } = {}) {
  for (const [pattern, reason] of RULES) {
    if (pattern.test(command)) return deny(reason);
  }
  for (const m of command.matchAll(/\brm\s+([^;&|\n]*)/g)) {
    const reason = checkRm(m[1]);
    if (reason) return deny(reason);
  }
  // Allow for git global options before the subcommand, e.g. `git -C dir push` or `git -c k=v push`.
  for (const m of command.matchAll(/\bgit\s+(?:(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?)\s+)*push\b([^;&|\n]*)/g)) {
    const reason = checkPush(m[1], currentBranch);
    if (reason) return deny(reason);
  }
  if (PROTECTED_PATH.test(command) && WRITE_OP.test(command)) {
    return deny('Guardrail files are protected. Ask the user to change them.');
  }
  return allow;
}

if (isMain(import.meta.url)) {
  runPreToolUse((input) =>
    checkCommand(input.tool_input?.command ?? '', { currentBranch: gitBranch(input.cwd) }),
  );
}
