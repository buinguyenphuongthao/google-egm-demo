import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { BoardRepo } from './board-repo';
import { boardRoutes } from './board-routes';
import { json, type Result, type Route } from './http';

export interface HandlerDeps {
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

export function createHandler({
  boardRepo,
  version,
  now = () => new Date(),
  newId = randomUUID,
  originVerify,
}: HandlerDeps) {
  if (originVerify === '') throw new Error('originVerify must be non-empty');
  const health: Route = {
    method: 'GET',
    pattern: /^\/api\/health$/,
    async run() {
      const dbOk = await boardRepo.ping();
      return json(dbOk ? 200 : 503, { status: dbOk ? 'ok' : 'degraded', version, dbOk });
    },
  };
  const routes = [health, ...boardRoutes({ repo: boardRepo, now, newId })];
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
