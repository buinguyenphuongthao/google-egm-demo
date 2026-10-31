import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'security-gate.sh');
const SHA = '0123456789abcdef0123456789abcdef01234567';

function setup({
  status = 'complete',
  findings = [],
  validatorExit = 0,
  validatorBody = `process.exit(${validatorExit});`,
  metadata = true,
  profile = 'quick',
  sourceRef = { commit: SHA, dirty: false },
  ledger = true,
  ledgerValidatorBody = 'process.exit(0);',
  expectedProfile = 'quick',
  expectedSha = SHA,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const runDir = path.join(dir, 'run');
  const skillDir = path.join(dir, 'skill');
  fs.mkdirSync(runDir);
  fs.mkdirSync(skillDir);
  if (metadata) {
    fs.writeFileSync(
      path.join(runDir, 'run-metadata.json'),
      JSON.stringify({ run_status: status, profile, source_ref: sourceRef }),
    );
  }
  fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify(findings));
  if (ledger) fs.writeFileSync(path.join(runDir, 'coverage-ledger.json'), '{}');
  fs.writeFileSync(path.join(skillDir, 'validate-findings.cjs'), validatorBody);
  fs.writeFileSync(path.join(skillDir, 'validate-coverage-ledger.cjs'), ledgerValidatorBody);
  const summary = path.join(dir, 'summary.md');
  const result = spawnSync('bash', [script, runDir, skillDir, expectedProfile, expectedSha], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  return {
    status: result.status,
    summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '',
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const confirmed = (severity, title = 'secret title') => ({
  verdict: 'confirmed',
  title,
  severity: { overall_severity: severity },
});

test('passes a complete run with no blocking findings', () => {
  const r = setup({ findings: [confirmed('medium'), { verdict: 'needs_validation', title: 't' }] });
  assert.equal(r.status, 0);
});

test('fails on confirmed high or critical', () => {
  assert.equal(setup({ findings: [confirmed('high')] }).status, 1);
  assert.equal(setup({ findings: [confirmed('critical')] }).status, 1);
});

test('fails closed on incomplete, missing, or invalid output', () => {
  assert.equal(setup({ status: 'incomplete' }).status, 1);
  assert.equal(setup({ metadata: false }).status, 1);
  assert.equal(setup({ validatorExit: 1 }).status, 1);
});

test('never prints finding details to the public summary', () => {
  const r = setup({ findings: [confirmed('high', 'SQL injection in handler.ts line 42')] });
  assert.doesNotMatch(r.summary, /SQL injection|handler\.ts/);
  assert.match(r.summary, /high/);
});

test('keeps validator error details out of public logs', () => {
  const r = setup({
    validatorBody: `process.stderr.write('invalid value "src/secret/path.ts"'); process.exit(1);`,
  });
  assert.equal(r.status, 1);
  for (const out of [r.summary, r.stdout, r.stderr]) assert.doesNotMatch(out, /src\/secret\/path\.ts/);
});

test('accepts a plain-string source_ref containing the expected sha', () => {
  assert.equal(setup({ sourceRef: `${SHA} (clean)` }).status, 0);
});

test('fails closed when coverage-ledger.json is missing', () => {
  assert.equal(setup({ ledger: false }).status, 1);
});

test('fails closed when the coverage ledger is rejected, without leaking validator output', () => {
  const r = setup({
    ledgerValidatorBody: `console.log('bad unit src/ledger/leak.ts'); process.stderr.write('src/ledger/leak.ts'); process.exit(1);`,
  });
  assert.equal(r.status, 1);
  for (const out of [r.summary, r.stdout, r.stderr]) assert.doesNotMatch(out, /src\/ledger\/leak\.ts/);
});

test('fails closed when the profile does not match', () => {
  assert.equal(setup({ profile: 'standard' }).status, 1);
  assert.equal(setup({ profile: null }).status, 1);
});

test('fails closed when source_ref does not contain the expected sha', () => {
  assert.equal(setup({ sourceRef: { commit: 'f'.repeat(40) } }).status, 1);
  assert.equal(setup({ sourceRef: null }).status, 1);
  assert.equal(setup({ expectedSha: '' }).status, 1);
});

test('never prints an unsanitized run_status', () => {
  const r = setup({ status: 'incomplete: SQLi in repo.ts\n::error::x' });
  assert.equal(r.status, 1);
  for (const out of [r.summary, r.stdout, r.stderr]) {
    assert.doesNotMatch(out, /SQLi|repo\.ts|::error::x/);
  }
  assert.match(r.summary, /unknown/);
});
