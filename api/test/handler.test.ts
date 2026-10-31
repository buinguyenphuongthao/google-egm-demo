import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { createHandler } from '../src/handler';
import { memoryBoardRepo } from './memory-board-repo';

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

function handlerFor(boardRepo = memoryBoardRepo()) {
  return createHandler({ boardRepo, version: 'abc123', now: () => new Date('2026-10-31T00:00:00Z') });
}

const parse = (body: string | undefined) => JSON.parse(body ?? '{}');

describe('GET /api/health', () => {
  it('reports version and a healthy db', async () => {
    const res = await handlerFor()(event('GET', '/api/health'));
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual({ status: 'ok', version: 'abc123', dbOk: true });
  });

  it('returns 503 when the Board table is unreachable', async () => {
    const res = await handlerFor({ ...memoryBoardRepo(), ping: async () => false })(event('GET', '/api/health'));
    expect(res.statusCode).toBe(503);
    expect(parse(res.body)).toMatchObject({ status: 'degraded', dbOk: false });
  });
});

describe('routing', () => {
  it('404s on unknown routes and on the removed notes routes', async () => {
    const handler = handlerFor();
    expect((await handler(event('GET', '/api/nope'))).statusCode).toBe(404);
    expect((await handler(event('GET', '/api/notes'))).statusCode).toBe(404);
    expect((await handler(event('POST', '/api/notes', JSON.stringify({ text: 'hi' })))).statusCode).toBe(404);
  });

  it('returns 500 without leaking details when the repo throws', async () => {
    const repo = memoryBoardRepo();
    repo.listProjects = async () => {
      throw new Error('secret internals');
    };
    const res = await handlerFor(repo)(event('GET', '/api/projects'));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internals');
  });
});

describe('origin verification', () => {
  const secret = 's3cret-value';
  const h = createHandler({ boardRepo: memoryBoardRepo(), version: 'v1', originVerify: secret });

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
    const local = createHandler({ boardRepo: memoryBoardRepo(), version: 'v1' });
    expect((await local(event('GET', '/api/health'))).statusCode).toBe(200);
  });

  it('refuses an empty secret as misconfiguration', () => {
    expect(() => createHandler({ boardRepo: memoryBoardRepo(), version: 'v1', originVerify: '' })).toThrow(
      'originVerify must be non-empty',
    );
  });
});
