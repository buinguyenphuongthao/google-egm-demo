import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export type Result = APIGatewayProxyStructuredResultV2;

/** A route handler gets the path pattern's captures, in order. */
export interface Route {
  method: string;
  pattern: RegExp;
  run(params: string[], event: APIGatewayProxyEventV2): Promise<Result>;
}

export function json(statusCode: number, body: unknown): Result {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

export const noContent: Result = { statusCode: 204 };

function readBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

/** Parses a JSON body of at most maxBytes, or returns the error response to send. */
export function readJson(
  event: APIGatewayProxyEventV2,
  maxBytes: number,
): { ok: true; value: unknown } | { ok: false; result: Result } {
  const raw = readBody(event);
  if (Buffer.byteLength(raw) > maxBytes) return { ok: false, result: json(413, { error: 'body too large' }) };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, result: json(400, { error: 'body must be valid JSON' }) };
  }
}
