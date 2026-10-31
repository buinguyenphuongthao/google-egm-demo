import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { buildNote, parseNoteInput } from './notes';
import type { NotesRepo } from './repo';

type Result = APIGatewayProxyStructuredResultV2;

const MAX_BODY_BYTES = 4096;
const NOTE_PATH = /^\/api\/notes\/([0-9a-f-]{36})$/;

export interface HandlerDeps {
  repo: NotesRepo;
  version: string;
  now?: () => Date;
  newId?: () => string;
}

function json(statusCode: number, body: unknown): Result {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function readBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

export function createHandler({ repo, version, now = () => new Date(), newId = randomUUID }: HandlerDeps) {
  return async (event: APIGatewayProxyEventV2): Promise<Result> => {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    try {
      if (method === 'GET' && path === '/api/health') {
        const dbOk = await repo.ping();
        return json(dbOk ? 200 : 503, { status: dbOk ? 'ok' : 'degraded', version, dbOk });
      }

      if (method === 'GET' && path === '/api/notes') {
        return json(200, { notes: await repo.list() });
      }

      if (method === 'POST' && path === '/api/notes') {
        const raw = readBody(event);
        if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(413, { error: 'body too large' });
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(400, { error: 'body must be valid JSON' });
        }
        const parsed = parseNoteInput(body);
        if (!parsed.ok) return json(400, { error: parsed.error });
        const note = buildNote(parsed.value, now(), newId());
        await repo.create(note);
        return json(201, { note });
      }

      const match = NOTE_PATH.exec(path);
      if (method === 'DELETE' && match) {
        const deleted = await repo.delete(match[1]!);
        return deleted ? { statusCode: 204 } : json(404, { error: 'note not found' });
      }

      return json(404, { error: 'not found' });
    } catch (err) {
      console.error(err);
      return json(500, { error: 'internal error' });
    }
  };
}
