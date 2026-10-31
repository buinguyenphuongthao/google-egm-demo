import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { BoardRepo } from './board-repo';
import { boardRoutes } from './board-routes';
import { json, readJson, type Result, type Route } from './http';
import { buildNote, parseNoteInput } from './notes';
import type { NotesRepo } from './repo';

const MAX_BODY_BYTES = 4096;

export interface HandlerDeps {
  repo: NotesRepo;
  boardRepo: BoardRepo;
  version: string;
  now?: () => Date;
  newId?: () => string;
  /** Value CloudFront sends in x-origin-verify. Unset only for local dev and e2e. */
  originVerify?: string;
}

function sameSecret(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function notesRoutes(repo: NotesRepo, version: string, now: () => Date, newId: () => string): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/health$/,
      async run() {
        const dbOk = await repo.ping();
        return json(dbOk ? 200 : 503, { status: dbOk ? 'ok' : 'degraded', version, dbOk });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/notes$/,
      async run() {
        return json(200, { notes: await repo.list() });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/notes$/,
      async run(_params, event) {
        const body = readJson(event, MAX_BODY_BYTES);
        if (!body.ok) return body.result;
        const parsed = parseNoteInput(body.value);
        if (!parsed.ok) return json(400, { error: parsed.error });
        const note = buildNote(parsed.value, now(), newId());
        await repo.create(note);
        return json(201, { note });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/notes\/([0-9a-f-]{36})$/,
      async run([id]) {
        const deleted = await repo.delete(id!);
        return deleted ? { statusCode: 204 } : json(404, { error: 'note not found' });
      },
    },
  ];
}

export function createHandler({
  repo,
  boardRepo,
  version,
  now = () => new Date(),
  newId = randomUUID,
  originVerify,
}: HandlerDeps) {
  if (originVerify === '') throw new Error('originVerify must be non-empty');
  const routes = [
    ...notesRoutes(repo, version, now, newId),
    ...boardRoutes({ repo: boardRepo, now, newId }),
  ];
  return async (event: APIGatewayProxyEventV2): Promise<Result> => {
    if (originVerify !== undefined && !sameSecret(event.headers?.['x-origin-verify'], originVerify)) {
      return json(403, { error: 'forbidden' });
    }
    const method = event.requestContext.http.method;
    try {
      for (const route of routes) {
        if (route.method !== method) continue;
        const match = route.pattern.exec(event.rawPath);
        if (match) return await route.run(match.slice(1), event);
      }
      return json(404, { error: 'not found' });
    } catch (err) {
      console.error(err);
      return json(500, { error: 'internal error' });
    }
  };
}
