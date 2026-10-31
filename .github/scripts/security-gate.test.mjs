import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'security-gate.sh');

function setup({ status = 'complete', findings = [], validatorExit = 0, metadata = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const runDir = path.join(dir, 'run');
  const skillDir = path.join(dir, 'skill');
  fs.mkdirSync(runDir);
  fs.mkdirSync(skillDir);
  if (metadata) fs.writeFileSync(path.join(runDir, 'run-metadata.json'), JSON.stringify({ run_status: status }));
  fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify(findings));
  fs.writeFileSync(path.join(skillDir, 'validate-findings.cjs'), `process.exit(${validatorExit});`);
  const summary = path.join(dir, 'summary.md');
  const result = spawnSync('bash', [script, runDir, skillDir], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  return { status: result.status, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' };
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
