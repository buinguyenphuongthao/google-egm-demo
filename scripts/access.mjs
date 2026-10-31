#!/usr/bin/env node
// Owner-only access list for the egm-staging and egm-prod CloudFront KeyValueStores.
// Run by the owner with their AWS profile. Never prints the smoke token.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENVS = ['staging', 'prod'];
const REPO = 'buinguyenphuongthao/google-egm-demo';
// Dotted decimal without leading zeros: the CloudFront Function compares the viewer IP
// as a string, so "01.2.3.4" could never match and is rejected rather than stored.
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
// Arity per command, used to reject extra or missing arguments.
const COMMANDS = { 'allow-me': 0, list: 0, remove: 1, 'rotate-smoke-token': 1 };
const USAGE = [
  'Usage: npm run access -- allow-me | list | remove <ip> | rotate-smoke-token <staging|prod>',
  'Do not rotate a smoke token while deploy.yml is running: the GitHub secret and the edge',
  'store briefly hold different tokens, so that run\'s smoke tests would be rejected.',
].join('\n');

export function parseIPv4(text) {
  const ip = String(text ?? '').trim();
  if (!IPV4.test(ip)) throw new Error(`Not an IPv4 address: ${JSON.stringify(ip)}`);
  return ip;
}
export const ipKey = (ip) => `ip:${parseIPv4(ip)}`;
export function parseEnv(env) {
  if (!ENVS.includes(env)) throw new Error(`Environment must be one of: ${ENVS.join(', ')}`);
  return env;
}

// Runs a CLI command with all output captured. Errors name only the command and its first
// two arguments, never the full command line or stdin. With `redact` (a secret string),
// that string is masked in the error detail and no `cause` is attached, so the raw error
// object (which carries stderr) cannot leak it. `errorCode` is the AWS error code, if any.
export function run(cmd, args, { input, redact } = {}, exec = execFileSync) {
  try {
    return exec(cmd, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    let detail = String(err.stderr || err.message).trim();
    if (redact) detail = detail.replaceAll(redact, '[redacted]');
    const wrapped = new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${detail}`, redact ? undefined : { cause: err });
    wrapped.errorCode = /\(([A-Za-z]+Exception)\)/.exec(detail)?.[1];
    throw wrapped;
  }
}

// AWS operations, with the command runner injectable for tests.
export function createClient(runner = run) {
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const common = ['--profile', process.env.AWS_PROFILE ?? 'egm-admin', '--region', region, '--output', 'json'];
  function aws(args, opts) {
    const out = runner('aws', [...args, ...common], opts);
    try {
      return JSON.parse(out || '{}');
    } catch {
      // No cause and no quoted output: the text is not ours to print.
      throw new Error(`aws ${args[0]} ${args[1]} returned output that is not JSON`);
    }
  }
  // Request parameters go through a private temp file so values (the smoke token) never
  // appear in argv. Not stdin: the AWS CLI cannot open /dev/stdin when it is a pipe on macOS.
  function awsJson(op, params, opts) {
    const dir = mkdtempSync(join(tmpdir(), 'egm-access-'));
    const file = join(dir, 'params.json');
    try {
      writeFileSync(file, JSON.stringify(params), { mode: 0o600 });
      return aws(['cloudfront-keyvaluestore', op, '--cli-input-json', `file://${file}`], opts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const etag = (arn) => aws(['cloudfront-keyvaluestore', 'describe-key-value-store', '--kvs-arn', arn]).ETag;
  // Writes need the store's current ETag; another writer may change it, so retry once.
  function withEtag(op, arn, params, opts) {
    const call = () => awsJson(op, { KvsARN: arn, ...params, IfMatch: etag(arn) }, opts);
    try {
      return call();
    } catch (err) {
      if (err.errorCode !== 'ConflictException') throw err;
      return call();
    }
  }
  return {
    storeArn(env) {
      const out = aws(['cloudformation', 'describe-stacks', '--stack-name', `egm-${env}`]);
      const arn = out.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'AccessStoreArn')?.OutputValue;
      if (!arn) throw new Error(`egm-${env} has no AccessStoreArn output; deploy PR A first`);
      return arn;
    },
    putKey: (arn, key, value, opts) => withEtag('put-key', arn, { Key: key, Value: value }, opts),
    // Returns false when the key was already absent.
    deleteKey(arn, key) {
      try {
        withEtag('delete-key', arn, { Key: key });
        return true;
      } catch (err) {
        if (err.errorCode === 'ResourceNotFoundException') return false;
        throw err;
      }
    },
    listKeys: (arn) => aws(['cloudfront-keyvaluestore', 'list-keys', '--kvs-arn', arn]).Items ?? [],
  };
}

// Applies `fn` to each environment's store. All ARNs are resolved before any write; a
// failure part-way says which environments were already changed.
function forEachStore(client, fn) {
  const stores = ENVS.map((env) => [env, client.storeArn(env)]);
  const done = [];
  for (const [env, arn] of stores) {
    try {
      fn(env, arn);
    } catch (err) {
      const already = done.length ? `already applied to ${done.join(', ')}` : 'no environment was changed';
      throw new Error(`${env}: ${err.message} (${already})`, { cause: err });
    }
    done.push(env);
  }
}

export async function main(argv, client = createClient()) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || ['help', '--help', '-h'].includes(cmd)) {
    console.log(USAGE);
    return;
  }
  if (!(cmd in COMMANDS) || rest.length !== COMMANDS[cmd]) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const [arg] = rest;
  switch (cmd) {
    case 'allow-me': {
      const res = await fetch('https://checkip.amazonaws.com');
      if (!res.ok) throw new Error(`checkip.amazonaws.com returned HTTP ${res.status}`);
      const ip = parseIPv4(await res.text());
      const value = new Date().toISOString();
      forEachStore(client, (env, arn) => client.putKey(arn, ipKey(ip), value));
      console.log(`Allowed ${ip} on ${ENVS.join(' and ')}. Takes effect within seconds.`);
      break;
    }
    case 'remove': {
      const key = ipKey(arg); // validate before any AWS call
      const absent = [];
      forEachStore(client, (env, arn) => {
        if (!client.deleteKey(arn, key)) absent.push(env);
      });
      console.log(`Removed ${arg.trim()}.${absent.length ? ` It was already absent on ${absent.join(', ')}.` : ''}`);
      break;
    }
    case 'list':
      for (const env of ENVS) {
        console.log(`${env}:`);
        for (const { Key, Value } of client.listKeys(client.storeArn(env))) {
          console.log(Key === 'smoke-token' ? '  smoke-token (set)' : `  ${Key}  added ${Value}`);
        }
      }
      break;
    case 'rotate-smoke-token': {
      // Do not run while deploy.yml is running: between the two writes below, the GitHub
      // secret and the edge store hold different tokens and smoke tests would be rejected.
      const env = parseEnv(arg);
      const arn = client.storeArn(env); // fail on a missing stack before touching the secret
      const token = randomBytes(32).toString('base64url');
      run('gh', ['secret', 'set', 'SMOKE_TOKEN', '--env', env, '--repo', REPO], { input: token, redact: token });
      try {
        client.putKey(arn, 'smoke-token', token, { redact: token });
      } catch (err) {
        // err carries no cause (redact mode) and its message is already redacted.
        throw new Error(`${err.message}. The ${env} GitHub secret was updated but the edge store was not; rerun this command.`, {
          cause: err,
        });
      }
      console.log(`Rotated the ${env} smoke token (GitHub secret and edge store).`);
      break;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
