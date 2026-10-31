import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Importing must not run main(): any AWS or gh call would fail or hang here.
import { ENVS, createClient, ipKey, main, parseEnv, parseIPv4, run } from './access.mjs';

const ARN = 'arn:aws:cloudfront::000000000000:key-value-store/test';

test('parseIPv4 accepts and trims a dotted IPv4 address', () => {
  assert.equal(parseIPv4('203.0.113.7\n'), '203.0.113.7');
  assert.equal(parseIPv4('0.0.0.0'), '0.0.0.0');
  assert.equal(parseIPv4('255.255.255.255'), '255.255.255.255');
  assert.equal(parseIPv4('10.200.199.9'), '10.200.199.9');
});

test('parseIPv4 rejects anything that is not plain IPv4', () => {
  for (const bad of [
    '256.1.1.1',
    '::1',
    '1.2.3',
    '1.2.3.4.5',
    '1.2.3.4; rm -rf /',
    '1.2.3.4\n5.6.7.8',
    '01.2.3.4',
    '1.2.3.004',
    '',
    undefined,
  ]) {
    assert.throws(() => parseIPv4(bad), /Not an IPv4 address/, String(bad));
  }
});

test('ipKey prefixes ip: and validates', () => {
  assert.equal(ipKey('203.0.113.7'), 'ip:203.0.113.7');
  assert.throws(() => ipKey('notanip'), /Not an IPv4 address/);
});

test('parseEnv accepts staging and prod only', () => {
  assert.deepEqual(ENVS, ['staging', 'prod']);
  assert.equal(parseEnv('staging'), 'staging');
  assert.equal(parseEnv('prod'), 'prod');
  assert.throws(() => parseEnv('dev'), /must be one of: staging, prod/);
  assert.throws(() => parseEnv(undefined), /must be one of/);
});

test('run in redact mode masks the secret in stderr detail and attaches no cause', () => {
  // A child that echoes its stdin to stderr, then fails.
  const script = 'process.stdin.pipe(process.stderr); process.stdin.on("end", () => process.exit(1));';
  let caught;
  try {
    run(process.execPath, ['-e', script], { input: 'SECRET', redact: 'SECRET' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected run to throw');
  assert.ok(!caught.message.includes('SECRET'), caught.message);
  assert.match(caught.message, /\[redacted\]/);
  assert.equal(caught.cause, undefined);
});

test('run without redact keeps stderr detail, the cause, and the AWS error code', () => {
  const script = 'console.error("An error occurred (AccessDeniedException) when calling PutKey"); process.exit(1);';
  let caught;
  try {
    run(process.execPath, ['-e', script]);
  } catch (err) {
    caught = err;
  }
  assert.match(caught.message, /AccessDeniedException/);
  assert.equal(caught.errorCode, 'AccessDeniedException');
  assert.ok(caught.cause);
});

// A fake runner that records calls and answers like the AWS CLI.
function fakeRunner({ failures = {} } = {}) {
  const calls = [];
  const runner = (cmd, args, opts = {}) => {
    const call = { cmd, args, opts };
    // The parameter file is deleted after the call, so capture it now.
    const ref = args[args.indexOf('--cli-input-json') + 1];
    if (args.includes('--cli-input-json')) {
      call.paramFile = ref.slice('file://'.length);
      call.paramMode = statSync(call.paramFile).mode & 0o777;
      call.input = readFileSync(call.paramFile, 'utf8');
    }
    calls.push(call);
    const op = args[1];
    const fail = failures[op]?.shift();
    if (fail) {
      const err = new Error(`aws ${args[0]} ${op} failed: An error occurred (${fail})`);
      err.errorCode = fail;
      throw err;
    }
    if (op === 'describe-stacks') {
      return JSON.stringify({ Stacks: [{ Outputs: [{ OutputKey: 'AccessStoreArn', OutputValue: ARN }] }] });
    }
    if (op === 'describe-key-value-store') return JSON.stringify({ ETag: `etag-${calls.length}` });
    return JSON.stringify({ ETag: 'new', ItemCount: 1, TotalSizeInBytes: 1 });
  };
  return { runner, calls };
}

test('put-key passes the value in a private, deleted file, never in argv', () => {
  const { runner, calls } = fakeRunner();
  createClient(runner).putKey(ARN, 'smoke-token', 'TOKENVALUE', { redact: 'TOKENVALUE' });
  const put = calls.find((c) => c.args[1] === 'put-key');
  assert.ok(put);
  for (const c of calls) assert.ok(!c.args.some((a) => a.includes('TOKENVALUE')), c.args.join(' '));
  const input = JSON.parse(put.input);
  assert.equal(put.paramMode, 0o600);
  assert.equal(existsSync(put.paramFile), false);
  assert.equal(input.Value, 'TOKENVALUE');
  assert.equal(input.KvsARN, ARN);
  assert.ok(input.IfMatch);
  assert.equal(put.opts.redact, 'TOKENVALUE');
  assert.ok(put.args.includes('--region'));
});

test('put-key retries once with a fresh ETag on ConflictException', () => {
  const { runner, calls } = fakeRunner({ failures: { 'put-key': ['ConflictException'] } });
  createClient(runner).putKey(ARN, 'ip:203.0.113.7', 'x');
  const puts = calls.filter((c) => c.args[1] === 'put-key');
  assert.equal(puts.length, 2);
  assert.notEqual(JSON.parse(puts[0].input).IfMatch, JSON.parse(puts[1].input).IfMatch);
});

test('put-key does not retry other errors', () => {
  const { runner, calls } = fakeRunner({ failures: { 'put-key': ['AccessDeniedException'] } });
  assert.throws(() => createClient(runner).putKey(ARN, 'k', 'v'), /AccessDeniedException/);
  assert.equal(calls.filter((c) => c.args[1] === 'put-key').length, 1);
});

test('deleteKey treats ResourceNotFoundException as already removed', () => {
  const { runner } = fakeRunner({ failures: { 'delete-key': ['ResourceNotFoundException'] } });
  assert.equal(createClient(runner).deleteKey(ARN, 'ip:203.0.113.7'), false);
});

test('remove resolves both stores before writing and reports partial failure', async () => {
  // staging delete succeeds, prod delete is denied.
  const { runner, calls } = fakeRunner();
  let deletes = 0;
  const wrapped = (cmd, args, opts) => {
    if (args[1] === 'delete-key' && ++deletes === 2) {
      const err = new Error('aws cloudfront-keyvaluestore delete-key failed: (AccessDeniedException)');
      err.errorCode = 'AccessDeniedException';
      throw err;
    }
    return runner(cmd, args, opts);
  };
  await assert.rejects(main(['remove', '203.0.113.7'], createClient(wrapped)), /^Error: prod: .*already applied to staging/);
  const ops = calls.map((c) => c.args[1]);
  assert.deepEqual(ops.slice(0, 2), ['describe-stacks', 'describe-stacks']);
});

test('main rejects extra or missing arguments before any call', async () => {
  const { runner, calls } = fakeRunner();
  const client = createClient(runner);
  const prev = process.exitCode;
  const error = console.error;
  console.error = () => {};
  try {
    for (const argv of [['allow-me', '1.2.3.4'], ['list', 'x'], ['remove'], ['remove', 'a', 'b'], ['rotate-smoke-token']]) {
      process.exitCode = 0;
      await main(argv, client);
      assert.equal(process.exitCode, 1, argv.join(' '));
    }
  } finally {
    console.error = error;
    process.exitCode = prev;
  }
  assert.equal(calls.length, 0);
});
