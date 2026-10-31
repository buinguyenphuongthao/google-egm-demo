# Owner-only access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Only the owner's allowlisted IPs (plus CI with a smoke token) can reach staging and prod; the raw API Gateway URL is unusable.

**Architecture:** A CloudFront Function (JS 2.0) on both cache behaviors checks the viewer IP and a smoke-token header against a per-environment CloudFront KeyValueStore. CloudFront adds a secret `x-origin-verify` header to API requests; the Lambda rejects requests without it. Design: `docs/plans/2026-10-31-owner-only-access-design.md`.

**Tech Stack:** aws-cdk-lib 2.275 (cloudfront `KeyValueStore`, `Function`, secretsmanager `Secret`), CloudFront Functions JS 2.0, Node 22 script with AWS CLI v2 and `gh`, Vitest, Playwright.

**Rollout:** two PRs. PR A (Tasks 1-4) ships the stores, origin lock, and owner script while sites stay public. The owner seeds the stores (Task 5). PR B (Tasks 6-9) attaches the edge function.

---

## PR A: stores, origin lock, owner script

### Task 1: Lambda origin check

**Files:** Modify `api/src/handler.ts`, `api/src/lambda.ts`. Test: `api/test/handler.test.ts`.

**Step 1: failing tests** (append to `api/test/handler.test.ts`; reuse its existing event helper, adding a `headers` field):

```ts
describe('origin verification', () => {
  const secret = 's3cret-value';
  const h = createHandler({ repo: fakeRepo(), version: 'v1', originVerify: secret });

  it('rejects requests without the CloudFront header', async () => {
    expect((await h(event('GET', '/api/health'))).statusCode).toBe(403);
  });
  it('rejects a wrong header', async () => {
    expect((await h(event('GET', '/api/health', undefined, { 'x-origin-verify': 'nope' }))).statusCode).toBe(403);
  });
  it('accepts the right header', async () => {
    expect((await h(event('GET', '/api/health', undefined, { 'x-origin-verify': secret }))).statusCode).toBe(200);
  });
  it('skips the check when no secret is configured (local dev, e2e)', async () => {
    const local = createHandler({ repo: fakeRepo(), version: 'v1' });
    expect((await local(event('GET', '/api/health'))).statusCode).toBe(200);
  });
});
```

**Step 2:** `npm test -w api` → FAIL (`originVerify` not in `HandlerDeps`).

**Step 3: implement.** In `handler.ts`:

```ts
import { randomUUID, timingSafeEqual } from 'node:crypto';
// HandlerDeps gains:
  /** Value CloudFront sends in x-origin-verify. Unset only for local dev and e2e. */
  originVerify?: string;

function sameSecret(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

First statement inside the returned handler, before routing:

```ts
    if (originVerify !== undefined && !sameSecret(event.headers?.['x-origin-verify'], originVerify)) {
      return json(403, { error: 'forbidden' });
    }
```

In `lambda.ts` pass `originVerify: process.env.ORIGIN_VERIFY`, and fail fast when it is missing: `if (!process.env.ORIGIN_VERIFY) throw new Error('ORIGIN_VERIFY is required');` (the deployed Lambda must never run without it; `local-server.ts` does not import `lambda.ts`).

**Step 4:** `npm test -w api` → PASS; `npm run typecheck && npm run lint`.

**Step 5:** commit `feat(api): reject requests that did not come through CloudFront`.

### Task 2: Infra: origin secret, header, KeyValueStore

**Files:** Modify `infra/lib/app-stack.ts`. Test: `infra/test/app-stack.test.ts`.

**Step 1: failing tests** (for both `staging` and `prod` templates):

```ts
it.each([['staging', staging], ['prod', prod]] as const)('%s locks the API origin to CloudFront', (_s, t) => {
  t.resourceCountIs('AWS::SecretsManager::Secret', 1);
  t.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ ORIGIN_VERIFY: Match.anyValue() }) },
  });
  t.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      Origins: Match.arrayWith([
        Match.objectLike({ OriginCustomHeaders: [Match.objectLike({ HeaderName: 'x-origin-verify' })] }),
      ]),
    }),
  });
});

it.each([['staging', staging], ['prod', prod]] as const)('%s has an access KeyValueStore', (_s, t) => {
  t.resourceCountIs('AWS::CloudFront::KeyValueStore', 1);
  t.hasOutput('AccessStoreArn', {});
});
```

If an existing test counts Lambda functions or asserts the exact `Environment`, keep it passing (Match.objectLike).

**Step 2:** `npm test -w infra` → FAIL.

**Step 3: implement** in `app-stack.ts`:

```ts
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

    // CloudFront sends this value to the API; the Lambda rejects requests without it,
    // which closes the public execute-api URL. Resolved by CloudFormation at deploy time.
    const originSecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      description: 'Header value CloudFront sends so the API accepts only CloudFront traffic',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
      removalPolicy,
    });
    const originVerify = originSecret.secretValue.unsafeUnwrap();
```

Add `ORIGIN_VERIFY: originVerify` to the Lambda environment, and
`new origins.HttpOrigin(apiDomain, { customHeaders: { 'x-origin-verify': originVerify } })`.
CloudFront custom origin headers overwrite a viewer-sent header of the same name, so viewers cannot spoof it.

```ts
    // Owner IPs (ip:<addr>) and the CI smoke token (smoke-token). Data is set by
    // `npm run access`, never by CDK or CI. Read by the edge function (PR B).
    const accessStore = new cloudfront.KeyValueStore(this, 'AccessStore', {
      comment: `Owner-only access list for ${props.stage}`,
    });
    new CfnOutput(this, 'AccessStoreArn', { value: accessStore.keyValueStoreArn });
```

Expected during the first PR A deploy: the Lambda can update before the CloudFront change
finishes propagating, so the API may return 403 for a few minutes mid-deploy. CloudFormation
waits for the distribution, so smoke tests run after both are live.

**Step 4:** `npm test -w infra` → PASS; `npm run synth -w infra` succeeds; grep `infra/cdk.out/*.template.json` to confirm the secret appears only as `{{resolve:secretsmanager:...}}`.

**Step 5:** commit `feat(infra): origin-verify secret and access KeyValueStore`.

### Task 3: Owner script `npm run access`

**Files:** Create `scripts/access.mjs`, `scripts/access.test.mjs`. Modify root `package.json`.

Pure helpers are exported and unit-tested; side effects run only when executed directly.

```js
#!/usr/bin/env node
// Owner-only access list for the egm-staging and egm-prod CloudFront KeyValueStores.
// Run by the owner with their AWS profile. Never prints the smoke token.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ENVS = ['staging', 'prod'];
const REPO = 'buinguyenphuongthao/google-egm-demo';
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function parseIPv4(text) {
  const ip = String(text).trim();
  if (!IPV4.test(ip)) throw new Error(`Not an IPv4 address: ${ip}`);
  return ip;
}
export const ipKey = (ip) => `ip:${parseIPv4(ip)}`;
export function parseEnv(env) {
  if (!ENVS.includes(env)) throw new Error(`Environment must be one of: ${ENVS.join(', ')}`);
  return env;
}

const awsArgs = () => ['--profile', process.env.AWS_PROFILE ?? 'egm-admin', '--output', 'json'];
function aws(...args) {
  return JSON.parse(execFileSync('aws', [...args, ...awsArgs()], { encoding: 'utf8' }) || '{}');
}
function storeArn(env) {
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const out = aws('cloudformation', 'describe-stacks', '--stack-name', `egm-${env}`, '--region', region);
  const arn = out.Stacks[0].Outputs?.find((o) => o.OutputKey === 'AccessStoreArn')?.OutputValue;
  if (!arn) throw new Error(`egm-${env} has no AccessStoreArn output; deploy PR A first`);
  return arn;
}
const etag = (arn) => aws('cloudfront-keyvaluestore', 'describe-key-value-store', '--kvs-arn', arn).ETag;
const putKey = (arn, key, value) =>
  aws('cloudfront-keyvaluestore', 'put-key', '--kvs-arn', arn, '--key', key, '--value', value, '--if-match', etag(arn));
const deleteKey = (arn, key) =>
  aws('cloudfront-keyvaluestore', 'delete-key', '--kvs-arn', arn, '--key', key, '--if-match', etag(arn));

async function main([cmd, arg]) {
  switch (cmd) {
    case 'allow-me': {
      const ip = parseIPv4(await (await fetch('https://checkip.amazonaws.com')).text());
      for (const env of ENVS) putKey(storeArn(env), ipKey(ip), new Date().toISOString());
      console.log(`Allowed ${ip} on ${ENVS.join(' and ')}. Takes effect within seconds.`);
      break;
    }
    case 'remove':
      for (const env of ENVS) deleteKey(storeArn(env), ipKey(arg));
      console.log(`Removed ${arg}.`);
      break;
    case 'list':
      for (const env of ENVS) {
        const items = aws('cloudfront-keyvaluestore', 'list-keys', '--kvs-arn', storeArn(env)).Items ?? [];
        console.log(`${env}:`);
        for (const { Key, Value } of items) console.log(Key === 'smoke-token' ? '  smoke-token (set)' : `  ${Key}  added ${Value}`);
      }
      break;
    case 'rotate-smoke-token': {
      const env = parseEnv(arg);
      const token = randomBytes(32).toString('base64url');
      execFileSync('gh', ['secret', 'set', 'SMOKE_TOKEN', '--env', env, '--repo', REPO], { input: token, stdio: ['pipe', 'ignore', 'inherit'] });
      putKey(storeArn(env), 'smoke-token', token);
      console.log(`Rotated the ${env} smoke token (GitHub secret and edge store).`);
      break;
    }
    default:
      console.log('Usage: npm run access -- allow-me | list | remove <ip> | rotate-smoke-token <staging|prod>');
      process.exitCode = cmd ? 1 : 0;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
```

Tests (`node:test`): `parseIPv4` accepts `203.0.113.7\n`, rejects `256.1.1.1`, `::1`, `1.2.3`, and `1.2.3.4; rm`; `ipKey` prefixes; `parseEnv` rejects `dev`.

`package.json`: add `"access": "node scripts/access.mjs"`, and append `scripts/access.test.mjs` to `test:guards`.

Run `npm run test:guards` → PASS; `npm run lint`. Commit `feat: owner script for the access allowlist and smoke token`.

### Task 4: Docs for PR A, open PR A

Add an "Owner-only access" section to `docs/setup.md` covering prerequisites (AWS CLI v2 with `cloudfront-keyvaluestore`, `gh` logged in, profile `egm-admin`) and the seeding steps in Task 5. Push, open PR A. The user reviews and merges; deploy runs (sites still public).

### Task 5: Owner seeds the stores (user, after PR A deploys)

```bash
aws sso login --profile egm-admin
npm run access -- allow-me
npm run access -- rotate-smoke-token staging
npm run access -- rotate-smoke-token prod
npm run access -- list
```

Expected: both environments list `ip:<your ip>` and `smoke-token (set)`. Agent verifies only via `list` output the user pastes; never reads the token.

---

## PR B: lock the edge

### Task 6: Edge function

**Files:** Create `infra/edge/owner-only.js`. Test: `infra/test/owner-only.test.ts`.

```js
// CloudFront Function (JS 2.0), viewer request. Lets through the owner's allowlisted IPs
// and CI requests carrying the smoke token; everyone else gets 403. Fails closed.
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
```

Test harness: read the file, drop the `import cf from 'cloudfront';` line, evaluate with `new Function('cf', src + '\nreturn handler;')(fakeCf)` where `fakeCf.kvs()` returns `{ get: async (k) => (k in data ? data[k] : Promise.reject(new Error('not found'))) }`. Cases: allowed IP → returns request; right token from any IP → request, header stripped; wrong token from unknown IP → 403; empty store → 403; `get` always throws → 403; token header present but store has no `smoke-token` → 403.

Commit `feat(infra): owner-only edge function`.

### Task 7: Attach function, disable IPv6

**Files:** Modify `infra/lib/app-stack.ts`, `infra/test/app-stack.test.ts`.

```ts
    const ownerOnly = new cloudfront.Function(this, 'OwnerOnly', {
      comment: 'Allow only owner IPs and the CI smoke token',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: accessStore,
      code: cloudfront.FunctionCode.fromInline(
        fs.readFileSync(fileURLToPath(new URL('../edge/owner-only.js', import.meta.url)), 'utf8')
          .replace('__KVS_ID__', accessStore.keyValueStoreId),
      ),
    });
    const ownerOnlyAssoc = [{ function: ownerOnly, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }];
```

Add `functionAssociations: ownerOnlyAssoc` to the default behavior and `/api/*`; add `enableIpv6: false` to the distribution.

Tests: `DefaultCacheBehavior.FunctionAssociations` and every `CacheBehaviors[*].FunctionAssociations` contain one `viewer-request` entry; `IPV6Enabled: false`; `AWS::CloudFront::Function` count 1 with `FunctionConfig.Runtime: 'cloudfront-js-2.0'`. Commit `feat(infra): attach owner-only function, disable IPv6`.

### Task 8: Smoke tests send the token and prove the lock

**Files:** Modify `smoke/playwright.config.ts`, `smoke/tests/smoke.spec.ts`, `.github/workflows/_deploy-stage.yml` (Edit tool; hook asks the user to confirm).

- Config: `const token = process.env.SMOKE_TOKEN; if (process.env.CI && !token) throw new Error('SMOKE_TOKEN is required in CI');` and `use: { baseURL, extraHTTPHeaders: token ? { 'x-egm-smoke-token': token } : {}, ... }`.
- New test:

```ts
test('the site is closed to anonymous visitors', async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: {} });
  try {
    expect((await anon.get('/')).status()).toBe(403);
    expect((await anon.get('/api/health')).status()).toBe(403);
  } finally {
    await anon.dispose();
  }
});
```

- Workflow smoke step env: `SMOKE_TOKEN: ${{ secrets.SMOKE_TOKEN }}` (environment secret; the job already declares `environment`).
- Local runs: the owner's allowlisted IP passes without a token, so the anonymous test fails locally unless run off-network; document that `npm run test:smoke` locally needs `SMOKE_TOKEN` unset and expects the 403 test to fail from an allowlisted IP, or skip it with `--grep-invert anonymous`.

Commit `test(smoke): send smoke token, assert anonymous 403`.

### Task 9: Docs and PR B

- `docs/threat-model.md`: the board is no longer public; record the IP-sharing and token-leak residual risks (Edit tool; protected paths ask the user).
- `CLAUDE.md`: architecture line and Conventions: owner-only access, `npm run access`, smoke token.
- Open PR B. After merge and deploy: from the owner's IP the site works; from a phone on mobile data it returns 403; `curl https://<api-id>.execute-api.ap-southeast-1.amazonaws.com/api/health` returns 403.

## Done when

- Anonymous requests to both CloudFront URLs and both execute-api URLs return 403.
- The owner's browser works after `npm run access -- allow-me`.
- Deploy smoke passes with the token, including the anonymous-403 test, and `prod-good` moves.
