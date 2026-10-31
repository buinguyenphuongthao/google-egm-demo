import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_LINE = "import cf from 'cloudfront';";
const raw = fs.readFileSync(path.join(here, '../edge/owner-only.js'), 'utf8');

type Header = { value: string };
type Request = { method: string; uri: string; headers: Record<string, Header> };
type Event = { viewer: { ip: string }; request: Request };
type Response = {
  statusCode: number;
  statusDescription: string;
  headers: Record<string, Header>;
  body: { encoding: string; data: string };
};
type Handler = (event: Event) => Promise<Request | Response>;
type Getter = (key: string) => Promise<string>;

function load(get: Getter) {
  const ids: string[] = [];
  const fakeCf = {
    kvs(id: string) {
      ids.push(id);
      return { get };
    },
  };
  const src = raw.replace(IMPORT_LINE, '');
  const handler = new Function('cf', `${src}\nreturn handler;`)(fakeCf) as Handler;
  return { handler, ids };
}

function withStore(data: Record<string, string>) {
  return load(async (k) => (k in data ? data[k]! : Promise.reject(new Error('not found'))));
}

function event(ip: string, token?: string): Event {
  const headers: Record<string, Header> = { host: { value: 'example.test' } };
  if (token !== undefined) headers['x-egm-smoke-token'] = { value: token };
  return { viewer: { ip }, request: { method: 'GET', uri: '/', headers } };
}

const OWNER = '203.0.113.7';
const STRANGER = '198.51.100.9';
const TOKEN = 'tok-0123456789abcdef';
const store = { [`ip:${OWNER}`]: '2026-10-31T00:00:00.000Z', 'smoke-token': TOKEN };

function expectForbidden(result: Request | Response) {
  expect(result).toEqual({
    statusCode: 403,
    statusDescription: 'Forbidden',
    headers: { 'content-type': { value: 'text/plain' }, 'cache-control': { value: 'no-store' } },
    body: { encoding: 'text', data: 'Forbidden' },
  });
}

describe('owner-only edge function', () => {
  it('has the cloudfront import exactly once, and the KVS placeholder exactly once', () => {
    expect(raw.split(IMPORT_LINE).length - 1).toBe(1);
    expect(raw.split('__KVS_ID__').length - 1).toBe(2); // one in the code, one in the header comment
    expect(raw.split("cf.kvs('__KVS_ID__')").length - 1).toBe(1);
  });

  it('fits in the CloudFront Functions 10 KB code limit', () => {
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(10 * 1024);
  });

  it('passes the __KVS_ID__ placeholder to cf.kvs', () => {
    const { ids } = withStore(store);
    expect(ids).toEqual(['__KVS_ID__']);
  });

  it('lets an allowlisted IP through', async () => {
    const { handler } = withStore(store);
    const e = event(OWNER);
    expect(await handler(e)).toBe(e.request);
  });

  it('lets the right token through from an unknown IP and strips the header', async () => {
    const { handler } = withStore(store);
    const e = event(STRANGER, TOKEN);
    const result = await handler(e);
    expect(result).toBe(e.request);
    expect(e.request.headers).not.toHaveProperty('x-egm-smoke-token');
    expect(e.request.headers).toHaveProperty('host');
  });

  it('strips the token header for an allowlisted IP too', async () => {
    const { handler } = withStore(store);
    const e = event(OWNER, TOKEN);
    expect(await handler(e)).toBe(e.request);
    expect(e.request.headers).not.toHaveProperty('x-egm-smoke-token');
  });

  it('strips a wrong token for an allowlisted IP and still allows by IP', async () => {
    const { handler } = withStore(store);
    const e = event(OWNER, 'wrong');
    expect(await handler(e)).toBe(e.request);
    expect(e.request.headers).not.toHaveProperty('x-egm-smoke-token');
  });

  it('denies a wrong token from an unknown IP', async () => {
    const { handler } = withStore(store);
    expectForbidden(await handler(event(STRANGER, 'wrong')));
  });

  it('denies an unknown IP without a token', async () => {
    const { handler } = withStore(store);
    expectForbidden(await handler(event(STRANGER)));
  });

  it('denies everyone when the store is empty', async () => {
    const { handler } = withStore({});
    expectForbidden(await handler(event(OWNER)));
    expectForbidden(await handler(event(STRANGER, TOKEN)));
  });

  it('denies everyone when the store always throws', async () => {
    const { handler } = load(async () => {
      throw new Error('store unavailable');
    });
    expectForbidden(await handler(event(OWNER)));
    expectForbidden(await handler(event(STRANGER, TOKEN)));
  });

  it('denies a token when the store has no smoke-token', async () => {
    const { handler } = withStore({ [`ip:${OWNER}`]: '2026-10-31T00:00:00.000Z' });
    expectForbidden(await handler(event(STRANGER, TOKEN)));
  });

  it('denies an empty token even if the stored smoke-token is empty', async () => {
    const { handler } = withStore({ 'smoke-token': '' });
    const e = event(STRANGER, '');
    expectForbidden(await handler(e));
    expect(e.request.headers).not.toHaveProperty('x-egm-smoke-token');
  });
});
