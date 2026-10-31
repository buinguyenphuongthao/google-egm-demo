import { describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH, NOTE_TTL_SECONDS, SMOKE_TTL_SECONDS, buildNote, parseNoteInput } from '../src/notes';

describe('parseNoteInput', () => {
  it('accepts and trims text', () => {
    expect(parseNoteInput({ text: '  hello  ' })).toEqual({ ok: true, value: { text: 'hello' } });
  });

  it('rejects a non-object body', () => {
    expect(parseNoteInput('hello').ok).toBe(false);
    expect(parseNoteInput(null).ok).toBe(false);
  });

  it('rejects missing, blank, or non-string text', () => {
    expect(parseNoteInput({}).ok).toBe(false);
    expect(parseNoteInput({ text: 42 }).ok).toBe(false);
    expect(parseNoteInput({ text: '   ' }).ok).toBe(false);
  });

  it('enforces the maximum length', () => {
    expect(parseNoteInput({ text: 'a'.repeat(MAX_TEXT_LENGTH) }).ok).toBe(true);
    expect(parseNoteInput({ text: 'a'.repeat(MAX_TEXT_LENGTH + 1) }).ok).toBe(false);
  });

  it('accepts a well-formed tag and rejects others', () => {
    expect(parseNoteInput({ text: 'x', tag: 'smoke-abc1234' })).toEqual({
      ok: true,
      value: { text: 'x', tag: 'smoke-abc1234' },
    });
    expect(parseNoteInput({ text: 'x', tag: 'Bad Tag' }).ok).toBe(false);
    expect(parseNoteInput({ text: 'x', tag: 7 }).ok).toBe(false);
  });
});

describe('buildNote', () => {
  const now = new Date('2026-10-31T00:00:00Z');

  const nowSeconds = Math.floor(now.getTime() / 1000);

  it('stamps id, createdAt, and a 7-day TTL', () => {
    expect(NOTE_TTL_SECONDS).toBe(604800);
    expect(buildNote({ text: 'hi' }, now, 'id-1')).toEqual({
      id: 'id-1',
      text: 'hi',
      createdAt: '2026-10-31T00:00:00.000Z',
      expiresAt: nowSeconds + NOTE_TTL_SECONDS,
    });
  });

  it('gives smoke-tagged notes a 1-hour TTL', () => {
    expect(SMOKE_TTL_SECONDS).toBe(3600);
    const note = buildNote({ text: 'hi', tag: 'smoke-abc' }, now, 'id-2');
    expect(note.expiresAt).toBe(nowSeconds + SMOKE_TTL_SECONDS);
  });

  it('gives other tagged notes the standard TTL', () => {
    expect(buildNote({ text: 'hi', tag: 'work' }, now, 'id-3')).toMatchObject({
      tag: 'work',
      expiresAt: nowSeconds + NOTE_TTL_SECONDS,
    });
  });
});
