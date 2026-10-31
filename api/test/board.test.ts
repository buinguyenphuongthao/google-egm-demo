import { describe, expect, it } from 'vitest';
import {
  DONE_TTL_SECONDS,
  SMOKE_TTL_SECONDS,
  buildProject,
  byRank,
  cardExpiry,
  isLive,
  parseCardCreate,
  parseCardUpdate,
  parseColumnCreate,
  parseColumnUpdate,
  parseLabelCreate,
  parseProjectInput,
  type Column,
} from '../src/board';

const NOW = new Date('2026-11-01T00:00:00Z');
const EPOCH = NOW.getTime() / 1000;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('parsing', () => {
  it('trims text and counts code points, not UTF-16 units', () => {
    expect(parseProjectInput({ name: '  Work  ' })).toEqual({ ok: true, value: { name: 'Work' } });
    expect(parseProjectInput({ name: '😀'.repeat(80) }).ok).toBe(true);
    expect(parseProjectInput({ name: '😀'.repeat(81) }).ok).toBe(false);
    expect(parseProjectInput({ name: '   ' }).ok).toBe(false);
  });

  it('rejects non-objects, missing required fields, and wrong types', () => {
    expect(parseProjectInput(null).ok).toBe(false);
    expect(parseProjectInput([]).ok).toBe(false);
    expect(parseProjectInput({}).ok).toBe(false);
    expect(parseProjectInput({ name: 3 }).ok).toBe(false);
  });

  it('rejects unknown fields, including server-owned ones', () => {
    expect(parseCardUpdate({ title: 'x', expiresAt: 1 })).toEqual({ ok: false, error: 'unknown field: expiresAt' });
    expect(parseColumnUpdate({ isDone: true }).ok).toBe(false);
    expect(parseProjectInput({ name: 'x', isSmoke: true }).ok).toBe(false);
  });

  it('requires an update to change something', () => {
    expect(parseColumnUpdate({})).toEqual({ ok: false, error: 'nothing to update' });
  });

  it('accepts only base-62 ranks of 1-64 characters', () => {
    expect(parseColumnCreate({ name: 'x', rank: 'a0V' }).ok).toBe(true);
    expect(parseColumnCreate({ name: 'x', rank: 'a'.repeat(64) }).ok).toBe(true);
    expect(parseColumnCreate({ name: 'x', rank: 'a'.repeat(65) }).ok).toBe(false);
    expect(parseColumnCreate({ name: 'x', rank: '' }).ok).toBe(false);
    expect(parseColumnCreate({ name: 'x', rank: 'a-0' }).ok).toBe(false);
  });

  it('enforces card field limits', () => {
    const base = { columnId: A, rank: 'a0', title: 't' };
    expect(parseCardCreate(base).ok).toBe(true);
    expect(parseCardCreate({ ...base, title: 'x'.repeat(201) }).ok).toBe(false);
    expect(parseCardCreate({ ...base, description: '' }).ok).toBe(true);
    expect(parseCardCreate({ ...base, description: 'x'.repeat(2001) }).ok).toBe(false);
    expect(parseCardCreate({ ...base, columnId: 'nope' }).ok).toBe(false);
  });

  it('enforces labelIds: ids only, unique, at most 30', () => {
    const base = { columnId: A, rank: 'a0', title: 't' };
    expect(parseCardCreate({ ...base, labelIds: [A, B] }).ok).toBe(true);
    expect(parseCardCreate({ ...base, labelIds: [A, A] }).ok).toBe(false);
    expect(parseCardCreate({ ...base, labelIds: ['x'] }).ok).toBe(false);
    expect(parseCardCreate({ ...base, labelIds: A }).ok).toBe(false);
    const many = Array.from({ length: 31 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`);
    expect(parseCardCreate({ ...base, labelIds: many }).ok).toBe(false);
  });

  it('accepts only palette colors for labels', () => {
    expect(parseLabelCreate({ name: 'bug', color: 'red' }).ok).toBe(true);
    expect(parseLabelCreate({ name: 'bug', color: '#ff0000' }).ok).toBe(false);
    expect(parseLabelCreate({ name: 'bug', color: 'red; background: url(x)' }).ok).toBe(false);
  });
});

describe('projects', () => {
  it('marks smoke- projects at creation with a 1 hour expiry', () => {
    expect(buildProject('smoke-abc', NOW, A)).toEqual({
      id: A,
      name: 'smoke-abc',
      createdAt: NOW.toISOString(),
      isSmoke: true,
      expiresAt: EPOCH + SMOKE_TTL_SECONDS,
    });
    expect(buildProject('Work', NOW, A)).toEqual({ id: A, name: 'Work', createdAt: NOW.toISOString(), isSmoke: false });
  });
});

describe('card expiry', () => {
  const project = buildProject('Work', NOW, A);
  const todo: Column = { id: A, projectId: A, name: 'To do', rank: 'a0', isDone: false };
  const done: Column = { id: B, projectId: A, name: 'Done', rank: 'a2', isDone: true };
  const later = new Date(NOW.getTime() + 3600_000);

  it('starts a 7 day clock when a card enters the done column', () => {
    expect(cardExpiry(project, done, { columnId: A }, NOW)).toEqual({
      doneAt: NOW.toISOString(),
      expiresAt: EPOCH + DONE_TTL_SECONDS,
    });
  });

  it('keeps the clock for a card that stays in the done column', () => {
    const inDone = { columnId: B, doneAt: NOW.toISOString(), expiresAt: EPOCH + DONE_TTL_SECONDS };
    expect(cardExpiry(project, done, inDone, later)).toEqual({ doneAt: inDone.doneAt, expiresAt: inDone.expiresAt });
  });

  it('clears expiry when a card leaves the done column', () => {
    const inDone = { columnId: B, doneAt: NOW.toISOString(), expiresAt: EPOCH + DONE_TTL_SECONDS };
    expect(cardExpiry(project, todo, inDone, later)).toEqual({});
  });

  it('gives smoke project cards the project expiry, even in the done column', () => {
    const smoke = buildProject('smoke-x', NOW, A);
    expect(cardExpiry(smoke, done, undefined, later)).toEqual({ expiresAt: smoke.expiresAt });
    expect(cardExpiry(smoke, todo, { columnId: B, expiresAt: smoke.expiresAt }, later)).toEqual({
      expiresAt: smoke.expiresAt,
    });
  });
});

describe('helpers', () => {
  it('treats items at or past expiresAt as gone', () => {
    expect(isLive({}, NOW)).toBe(true);
    expect(isLive({ expiresAt: EPOCH + 1 }, NOW)).toBe(true);
    expect(isLive({ expiresAt: EPOCH }, NOW)).toBe(false);
  });

  it('sorts by rank, then id', () => {
    const items = [
      { rank: 'a1', id: A },
      { rank: 'a0', id: B },
      { rank: 'a0', id: A },
    ];
    expect(items.sort(byRank)).toEqual([
      { rank: 'a0', id: A },
      { rank: 'a0', id: B },
      { rank: 'a1', id: A },
    ]);
  });
});
