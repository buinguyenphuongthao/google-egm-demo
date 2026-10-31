export interface Note {
  id: string;
  text: string;
  createdAt: string;
  tag?: string;
  expiresAt?: number;
}

export interface NoteInput {
  text: string;
  tag?: string;
}

export type ParseResult = { ok: true; value: NoteInput } | { ok: false; error: string };

export const MAX_TEXT_LENGTH = 500;
// Smoke-test notes expire on their own if a smoke run dies before cleaning up.
export const SMOKE_TTL_SECONDS = 3600;
const TAG_PATTERN = /^[a-z0-9-]{1,40}$/;

export function parseNoteInput(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const { text, tag } = body as Record<string, unknown>;
  if (typeof text !== 'string') return { ok: false, error: 'text must be a string' };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, error: 'text must not be empty' };
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: `text must be at most ${MAX_TEXT_LENGTH} characters` };
  }
  if (tag === undefined) return { ok: true, value: { text: trimmed } };
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    return { ok: false, error: 'tag must match [a-z0-9-]{1,40}' };
  }
  return { ok: true, value: { text: trimmed, tag } };
}

export function buildNote(input: NoteInput, now: Date, id: string): Note {
  const note: Note = { id, text: input.text, createdAt: now.toISOString() };
  if (input.tag) {
    note.tag = input.tag;
    if (input.tag.startsWith('smoke-')) {
      note.expiresAt = Math.floor(now.getTime() / 1000) + SMOKE_TTL_SECONDS;
    }
  }
  return note;
}
