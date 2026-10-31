// CloudFront Function (JS 2.0), viewer request. Lets through the owner's allowlisted IPs
// and CI requests carrying the smoke token; everyone else gets 403. Fails closed.
// CDK replaces __KVS_ID__ with the KeyValueStore id when it attaches this function.
import cf from 'cloudfront';

const kvs = cf.kvs('__KVS_ID__');
const TOKEN_HEADER = 'x-egm-smoke-token';

async function lookup(key) {
  try {
    return await kvs.get(key);
  } catch (e) {
    return undefined; // missing key or store error: deny
  }
}

async function handler(event) {
  const request = event.request;
  const token = request.headers[TOKEN_HEADER];
  // Never forward the token to the origin, whether or not it is valid.
  delete request.headers[TOKEN_HEADER];
  if (token && token.value) {
    const expected = await lookup('smoke-token');
    if (expected && token.value === expected) return request;
  }
  if ((await lookup('ip:' + event.viewer.ip)) !== undefined) return request;
  return {
    statusCode: 403,
    statusDescription: 'Forbidden',
    headers: { 'content-type': { value: 'text/plain' }, 'cache-control': { value: 'no-store' } },
    body: { encoding: 'text', data: 'Forbidden' },
  };
}
