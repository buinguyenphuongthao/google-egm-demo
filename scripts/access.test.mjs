import { test } from 'node:test';
import assert from 'node:assert/strict';
// Importing must not run main(): any AWS or gh call would fail or hang here.
import { ENVS, ipKey, parseEnv, parseIPv4 } from './access.mjs';

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
