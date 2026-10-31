import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { createHandler } from '../src/handler';
import { NOTE_TTL_SECONDS, type Note } from '../src/notes';
import type { NotesRepo } from '../src/repo';
import { memoryBoardRepo } from './memory-board-repo';

const ID = '11111111-1111-4111-8111-111111111111';

function fakeRepo(initial: Note[] = [], healthy = true): NotesRepo & { notes: Note[] } {
  const notes = [...initial];
  return {
    notes,
    async list() {
      return [...notes];
    },
    async create(note) {
      notes.push(note);
    },
    async delete(id) {
      const i = notes.findIndex((n) => n.id === id);
      if (i === -1) return false;
      notes.splice(i, 1);
      return true;
    },
    async ping() {
      return healthy;
    },
  };
}

function event(
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    headers,
    body,
    isBase64Encoded: false,
    requestContext: { http: { method } },
  } as unknown as APIGatewayProxyEventV2;
}

function handlerFor(repo: NotesRepo) {
  return createHandler({
    repo,
    boardRepo: memoryBoardRepo(),
    version: 'abc123',
    now: () => new Date('2026-10-31T00:00:00Z'),
    newId: () => ID,
  });
}

const parse = (body: string | undefined) => JSON.parse(body ?? '{}');

describe('GET /api/health', () => {
  it('reports version and a healthy db', async () => {
    const res = await handlerFor(fakeRepo())(event('GET', '/api/health'));
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual({ status: 'ok', version: 'abc123', dbOk: true });
  });

  it('returns 503 when the db is unreachable', async () => {
    const res = await handlerFor(fakeRepo([], false))(event('GET', '/api/health'));
    expect(res.statusCode).toBe(503);
    expect(parse(res.body)).toMatchObject({ status: 'degraded', dbOk: false });
  });
});

describe('notes routes', () => {
  it('lists notes', async () => {
    const note = { id: ID, text: 'hi', createdAt: '2026-10-31T00:00:00.000Z' };
    const res = await handlerFor(fakeRepo([note]))(event('GET', '/api/notes'));
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual({ notes: [note] });
  });

  it('creates a note', async () => {
    const repo = fakeRepo();
    const res = await handlerFor(repo)(event('POST', '/api/notes', JSON.stringify({ text: ' hi ' })));
    expect(res.statusCode).toBe(201);
    expect(parse(res.body).note).toEqual({
      id: ID,
      text: 'hi',
      createdAt: '2026-10-31T00:00:00.000Z',
      expiresAt: Date.parse('2026-10-31T00:00:00Z') / 1000 + NOTE_TTL_SECONDS,
    });
    expect(repo.notes).toHaveLength(1);
  });

  it('rejects invalid JSON, invalid notes, and oversized bodies', async () => {
    const handler = handlerFor(fakeRepo());
    expect((await handler(event('POST', '/api/notes', '{nope'))).statusCode).toBe(400);
    expect((await handler(event('POST', '/api/notes', JSON.stringify({ text: '' })))).statusCode).toBe(400);
    expect((await handler(event('POST', '/api/notes', 'x'.repeat(5000)))).statusCode).toBe(413);
  });

  it('deletes an existing note and 404s on a missing one', async () => {
    const repo = fakeRepo([{ id: ID, text: 'hi', createdAt: 'x' }]);
    const handler = handlerFor(repo);
    expect((await handler(event('DELETE', `/api/notes/${ID}`))).statusCode).toBe(204);
    expect((await handler(event('DELETE', `/api/notes/${ID}`))).statusCode).toBe(404);
  });

  it('404s on unknown routes and malformed ids', async () => {
    const handler = handlerFor(fakeRepo());
    expect((await handler(event('GET', '/api/nope'))).statusCode).toBe(404);
    expect((await handler(event('DELETE', '/api/notes/not-a-uuid'))).statusCode).toBe(404);
  });

  it('returns 500 without leaking details when the repo throws', async () => {
    const repo = fakeRepo();
    repo.list = async () => {
      throw new Error('secret internals');
    };
    const res = await handlerFor(repo)(event('GET', '/api/notes'));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internals');
  });
});

describe('origin verification', () => {
  const secret = 's3cret-value';
  const h = createHandler({ repo: fakeRepo(), boardRepo: memoryBoardRepo(), version: 'v1', originVerify: secret });

  it('rejects requests without the CloudFront header', async () => {
    expect((await h(event('GET', '/api/health'))).statusCode).toBe(403);
  });

  it('rejects a wrong header', async () => {
    expect((await h(event('GET', '/api/health', undefined, { 'x-origin-verify': 'nope' }))).statusCode).toBe(403);
  });

  it('rejects a same-length header with different content', async () => {
    const forged = secret.slice(0, -1) + 'x';
    expect((await h(event('GET', '/api/health', undefined, { 'x-origin-verify': forged }))).statusCode).toBe(403);
  });

  it('accepts the right header', async () => {
    expect((await h(event('GET', '/api/health', undefined, { 'x-origin-verify': secret }))).statusCode).toBe(200);
  });

  it('skips the check when no secret is configured (local dev, e2e)', async () => {
    const local = createHandler({ repo: fakeRepo(), boardRepo: memoryBoardRepo(), version: 'v1' });
    expect((await local(event('GET', '/api/health'))).statusCode).toBe(200);
  });

  it('refuses an empty secret as misconfiguration', () => {
    expect(() => createHandler({ repo: fakeRepo(), boardRepo: memoryBoardRepo(), version: 'v1', originVerify: '' })).toThrow(
      'originVerify must be non-empty',
    );
  });
});
