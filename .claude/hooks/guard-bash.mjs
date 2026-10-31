import { execFileSync } from 'node:child_process';
import { allow, deny, isMain, runPreToolUse } from './lib.mjs';

// Pattern guardrails. They stop mistakes and instruction drift, not a determined attacker;
// IAM, token scopes, and branch protection are the real boundary.
// AWS CLI global options may precede the service (`aws --region x --profile p dynamodb ...`).
// Regex backtracking decides whether a word after an option is its value or the service name.
const AWS = String.raw`\baws(?:\s+--?[\w-]+(?:[=\s]+(?!-)[^\s;&|]+)?)*\s+`;

const RULES = [
  [/\bgit\s+reset\s+[^;&|]*--hard\b/, 'git reset --hard discards work. Ask the user first.'],
  [/\bgit\s+clean\s+[^;&|]*-[a-zA-Z]*f/, 'git clean -f deletes untracked files. Ask the user first.'],
  [
    /\bgit\b[^;&|\n]*\s--output(?:-directory)?(?=[=\s]|$)|\bgit\b[^;&|\n]*\sformat-patch\b[^;&|\n]*\s-o/m,
    'git --output / format-patch -o writes files and can bypass the protected-path check. Redirect stdout instead.',
  ],
  // Options may come before the subcommand: `npx cdk -a "x" deploy`, `cdk --profile p destroy`.
  [
    /(?:^|[\s;&|(/])cdk\s(?:[^;&|\n]*\s)?(deploy|destroy)(?=$|[\s;&|)])/m,
    'Deploys run only in deploy.yml or by the user. Ask the user to run it with `!`.',
  ],
  [
    new RegExp(
      AWS + String.raw`[a-z0-9-]+\s+(?:(delete|put|update|create|remove|terminate|attach|detach|modify|disable|stop)-|deploy(?=$|[\s;&|)]))`,
      'm',
    ),
    'Mutating AWS CLI calls are blocked. Change infrastructure through CDK and the pipeline.',
  ],
  [new RegExp(AWS + String.raw`s3\s+(rm|rb|mv|sync|cp)\b`), 'Mutating S3 commands are blocked. Ask the user.'],
  [/\b(batch-)?get-secret-value\b/, 'Reading secret values is blocked. Use {{resolve:secretsmanager:...}} with asm-exec.'],
  [/\bgh\s+repo\s+(delete|archive|edit|rename)\b/, 'Repository settings changes are blocked. Ask the user.'],
  [/\bgh\s+pr\s+merge\b/, 'Merging is a human decision after all gates pass.'],
  // Only `list`/`ls` immediately after the noun is allowed; anything else (set, delete, flags first) is denied.
  [
    /\bgh\s+(secret|variable)\b(?!\s+(list|ls)(?=$|[\s;&|)]))/m,
    'Secrets and variables are managed by the user. Ask them to run it with `!`.',
  ],
  [/\bgh\s+api\b[^;&|]*(-X|--method)\s*(DELETE|PUT|PATCH|POST)\b/i, 'Mutating GitHub API calls are blocked. Ask the user.'],
  [
    /\bgh\s+api\b(?![^;&|]*(-X|--method)\s*GET)[^;&|]*\s(-f|-F|--field|--raw-field|--input)\b/,
    'gh api with fields sends a POST. Mutating GitHub API calls are blocked. Ask the user.',
  ],
  [/\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'Piping downloads into a shell is blocked.'],
  [/\bnpm\s+publish\b/, 'Publishing packages is blocked.'],
];

// Case-insensitive because the default macOS filesystem is: `.Claude/Settings.json` is the same file.
// The OIDC stack and audit recipient match by file name so `cd infra && ... > lib/github-oidc-stack.ts` is caught.
const PROTECTED_PATH =
  /\.claude\/(settings[\w.-]*\.json|hooks\b|skills\/security-audit\b|audit\.jsonl)|github-oidc-stack\.ts|audit-recipient\.txt/i;
// Directories whose move/removal/chmod would take protected files with them.
const PROTECTED_ANCESTOR = /(^|\/)(\.claude|\.claude\/skills|\.github|infra|infra\/lib)\/?$/i;
// A directory that, once cd'ed into, makes every relative write target suspect.
const PROTECTED_DIR = /(^|\/)\.(claude|github)(\/|$)/i;
// Sample protected paths that glob arguments (`rm .claude/*/x`) are matched against.
const GLOB_CANDIDATES = [
  '.claude', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks', '.claude/hooks/guard-bash.mjs',
  '.claude/hooks/guard-files.mjs', '.claude/hooks/lib.mjs', '.claude/skills', '.claude/skills/security-audit',
  '.claude/skills/security-audit/SKILL.md', '.claude/audit.jsonl', 'infra', 'infra/lib',
  'infra/lib/github-oidc-stack.ts', '.github', '.github/audit-recipient.txt',
];

// Commands that write to (or remove, relink, re-permission) their path arguments. For cp/mv/ln/rsync/install
// we do not try to tell source from destination: any protected argument is denied.
const WRITE_CMDS = new Set([
  'cp', 'mv', 'ln', 'tee', 'install', 'rsync', 'rm', 'rmdir', 'unlink', 'chmod', 'chown', 'chgrp', 'truncate',
  'touch', 'dd', 'shred', 'patch',
]);
const GIT_WRITE_SUBCMDS = new Set(['checkout', 'restore', 'rm', 'mv']);
// Commands whose real work is hidden in a string or stdin: deny when the whole command mentions a protected path.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'perl', 'ruby', 'deno', 'bun', 'osascript']);
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'nice', 'nohup', 'time', 'exec', 'stdbuf']);

// Output redirections: `>`, `>>`, `>|`, `N>`, `>&`, `N>&M`, `&>`, `&>>`. The target is captured when present.
const REDIRECT = /(?:&>>?|\d*>>?(?:&|\|)?)[ \t]*("[^"]*"|'[^']*'|[^\s;&|<>()]+)?/g;
const NON_FILE_TARGET = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;
const SEGMENT_SPLIT = /&&|\|\||\$\(|[;&|\n()`]/;
const DYNAMIC = /[$`]/;
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

const base = (word) => word.split('/').pop();

function words(segment) {
  return segment
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/['"]/g, '').replace(/^\\/, ''));
}

// Drops leading env assignments and wrappers (`sudo`, `env`, `timeout 10`, ...) so `sudo /bin/rm x` yields ['rm', 'x'].
function unwrap(ws) {
  let i = 0;
  while (i < ws.length) {
    const name = base(ws[i]);
    if (/^[A-Za-z_]\w*=/.test(ws[i])) {
      i++;
    } else if (WRAPPERS.has(name) || name === 'timeout') {
      i++;
      while (i < ws.length && ws[i].startsWith('-')) i++;
      if (name === 'timeout') i++;
    } else {
      break;
    }
  }
  const rest = ws.slice(i);
  if (rest.length) rest[0] = base(rest[0]);
  return rest;
}

function globToSource(glob) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '[' || ch === ']') re += ch;
    else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return re;
}

// Matches the glob, and each tail of it with two or more components (so `/abs/repo/.claude/*/x` is
// caught), against sample protected paths.
function globMatchesProtected(glob) {
  const parts = glob.split('/').filter(Boolean);
  const tails = [parts.join('/')];
  for (let k = 1; k <= parts.length - 2; k++) tails.push(parts.slice(k).join('/'));
  try {
    return tails.some((tail) => {
      const pattern = new RegExp(`^${globToSource(tail)}/?$`, 'i');
      return GLOB_CANDIDATES.some((c) => pattern.test(c));
    });
  } catch {
    return true; // Unparseable glob: assume the worst.
  }
}

function isProtectedArg(arg, inProtectedDir) {
  const a = arg.replace(/^(\.\/)+/, '');
  if (PROTECTED_PATH.test(a) || PROTECTED_ANCESTOR.test(a)) return true;
  if (inProtectedDir && !a.startsWith('-') && !/^[/~]/.test(a)) return true;
  return /[*?[]/.test(a) && globMatchesProtected(a);
}

function gitSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(a)) i++;
    else if (!a.startsWith('-')) return a;
  }
  return '';
}

// `cat <<EOF ... EOF` bodies are data (commit messages, file contents piped elsewhere), not commands.
// Heredocs fed to anything else (`bash <<EOF`) are kept and analysed line by line.
function stripCatHeredocs(command) {
  return command.replace(
    /<<-?[ \t]*(['"]?)([\w-]+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g,
    (match, _q, _tag, rest, offset) => {
      const line = command.slice(command.lastIndexOf('\n', offset - 1) + 1, offset);
      const parts = line.split(SEGMENT_SPLIT);
      return unwrap(words(parts[parts.length - 1]))[0] === 'cat' ? ` ${rest}\n` : match;
    },
  );
}

const PROTECTED_REASON = 'Guardrail files are protected. Ask the user to change them.';

// Target-aware: reading protected files is fine; only redirections into them and write commands that
// name them are denied. Opaque commands (`bash -c`, `node -e`, `xargs rm`, ...) are denied whenever the
// command mentions a protected path at all.
function checkProtectedWrites(command) {
  const mentionsProtected = PROTECTED_PATH.test(command);
  const redirects = [];
  const masked = stripCatHeredocs(command).replace(REDIRECT, (op, target) => {
    redirects.push({ op, target: target?.replace(/['"]/g, '') });
    return ` \u0000${redirects.length - 1}\u0000 `;
  });

  let inProtectedDir = false;
  for (const segment of masked.split(SEGMENT_SPLIT)) {
    const ws = [];
    for (const w of words(segment)) {
      const marker = /^\u0000(\d+)\u0000$/.exec(w);
      if (!marker) {
        ws.push(w);
        continue;
      }
      const { op, target } = redirects[Number(marker[1])];
      if (!target || (op.endsWith('&') && /^(\d+|-)$/.test(target)) || NON_FILE_TARGET.test(target)) continue;
      if (isProtectedArg(target, inProtectedDir) || (DYNAMIC.test(target) && mentionsProtected)) {
        return PROTECTED_REASON;
      }
    }

    const [name, ...args] = unwrap(ws);
    if (!name) continue;
    if (name === 'cd' || name === 'pushd') {
      inProtectedDir = args.some((a) => PROTECTED_DIR.test(a) || PROTECTED_PATH.test(a));
      continue;
    }

    let writes = false;
    let opaque = false;
    if (WRITE_CMDS.has(name)) {
      writes = true;
    } else if (name === 'sed' || name === 'perl') {
      writes = args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
      opaque = name === 'perl' && args.some((a) => /^-[a-zA-Z]*[eE]/.test(a));
    } else if (name === 'git') {
      writes = GIT_WRITE_SUBCMDS.has(gitSubcommand(args));
    } else if (name === 'find') {
      writes = args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a));
    } else if (SHELLS.has(name)) {
      opaque = args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    } else if (INTERPRETERS.has(name)) {
      opaque = args.some((a) => /^-[a-zA-Z]*[ecEpi][a-zA-Z]*$|^--(eval|print|command)\b/.test(a));
    } else if (name === 'eval' || name === 'source' || name === '.') {
      opaque = true;
    } else if (name === 'xargs') {
      opaque = args.some((a) => {
        const n = base(a);
        return WRITE_CMDS.has(n) || SHELLS.has(n) || INTERPRETERS.has(n) || ['sed', 'git', 'find'].includes(n);
      });
    }

    if (opaque && mentionsProtected) return PROTECTED_REASON;
    if (writes) {
      if (args.some((a) => isProtectedArg(a, inProtectedDir))) return PROTECTED_REASON;
      if (mentionsProtected && args.some((a) => DYNAMIC.test(a))) return PROTECTED_REASON;
    }
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
  const reason = checkProtectedWrites(command);
  return reason ? deny(reason) : allow;
}

if (isMain(import.meta.url)) {
  runPreToolUse((input) =>
    checkCommand(input.tool_input?.command ?? '', { currentBranch: gitBranch(input.cwd) }),
  );
}
