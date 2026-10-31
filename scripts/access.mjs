#!/usr/bin/env node
// Owner-only access list for the egm-staging and egm-prod CloudFront KeyValueStores.
// Run by the owner with their AWS profile. Never prints the smoke token.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ENVS = ['staging', 'prod'];
const REPO = 'buinguyenphuongthao/google-egm-demo';
// Dotted decimal without leading zeros: the CloudFront Function compares the viewer IP
// as a string, so "01.2.3.4" could never match and is rejected rather than stored.
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const USAGE = 'Usage: npm run access -- allow-me | list | remove <ip> | rotate-smoke-token <staging|prod>';

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

const awsArgs = () => ['--profile', process.env.AWS_PROFILE ?? 'egm-admin', '--output', 'json'];

// Runs a CLI command with all output captured. Errors never include the command line or
// stdin. `secret: true` also drops the tool's stderr, in case it echoes request input.
function run(cmd, args, { input, secret = false } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    const what = `${cmd} ${args.slice(0, 2).join(' ')}`;
    const detail = secret ? '' : `: ${String(err.stderr ?? err.message).trim()}`;
    // A secret call keeps no cause: the raw error carries the tool's stderr.
    throw new Error(`${what} failed${detail}`, secret ? undefined : { cause: err });
  }
}
function aws(args, opts) {
  return JSON.parse(run('aws', [...args, ...awsArgs()], opts) || '{}');
}
// Request parameters go through stdin so values (the smoke token) never appear in argv.
const awsJson = (service, op, params, opts) =>
  aws([service, op, '--cli-input-json', 'file:///dev/stdin'], { ...opts, input: JSON.stringify(params) });

function storeArn(env) {
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const out = aws(['cloudformation', 'describe-stacks', '--stack-name', `egm-${env}`, '--region', region]);
  const arn = out.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'AccessStoreArn')?.OutputValue;
  if (!arn) throw new Error(`egm-${env} has no AccessStoreArn output; deploy PR A first`);
  return arn;
}
const etag = (arn) => aws(['cloudfront-keyvaluestore', 'describe-key-value-store', '--kvs-arn', arn]).ETag;
const putKey = (arn, key, value, opts) =>
  awsJson('cloudfront-keyvaluestore', 'put-key', { KvsARN: arn, Key: key, Value: value, IfMatch: etag(arn) }, opts);
const deleteKey = (arn, key) =>
  awsJson('cloudfront-keyvaluestore', 'delete-key', { KvsARN: arn, Key: key, IfMatch: etag(arn) });

async function main([cmd, arg]) {
  switch (cmd) {
    case 'allow-me': {
      const res = await fetch('https://checkip.amazonaws.com');
      if (!res.ok) throw new Error(`checkip.amazonaws.com returned HTTP ${res.status}`);
      const ip = parseIPv4(await res.text());
      for (const env of ENVS) putKey(storeArn(env), ipKey(ip), new Date().toISOString());
      console.log(`Allowed ${ip} on ${ENVS.join(' and ')}. Takes effect within seconds.`);
      break;
    }
    case 'remove': {
      const key = ipKey(arg); // validate before any AWS call
      for (const env of ENVS) deleteKey(storeArn(env), key);
      console.log(`Removed ${arg.trim()}.`);
      break;
    }
    case 'list':
      for (const env of ENVS) {
        const items = aws(['cloudfront-keyvaluestore', 'list-keys', '--kvs-arn', storeArn(env)]).Items ?? [];
        console.log(`${env}:`);
        for (const { Key, Value } of items) console.log(Key === 'smoke-token' ? '  smoke-token (set)' : `  ${Key}  added ${Value}`);
      }
      break;
    case 'rotate-smoke-token': {
      const env = parseEnv(arg);
      const arn = storeArn(env); // fail on a missing stack before touching the GitHub secret
      const token = randomBytes(32).toString('base64url');
      run('gh', ['secret', 'set', 'SMOKE_TOKEN', '--env', env, '--repo', REPO], { input: token, secret: true });
      try {
        putKey(arn, 'smoke-token', token, { secret: true });
      } catch (err) {
        throw new Error(`${err.message}. The ${env} GitHub secret was updated but the edge store was not; rerun this command.`, {
          cause: err,
        });
      }
      console.log(`Rotated the ${env} smoke token (GitHub secret and edge store).`);
      break;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      break;
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
