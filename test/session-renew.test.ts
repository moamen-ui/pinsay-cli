import { test, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { tokenCacheFile } from '../src/credentials.js';
import { resolveToken } from '../src/auth.js';
import { api, ApiError } from '../src/api.js';
import { describeError } from '../src/errors.js';

// QA-BUG-01: the server ended a cached session before its JWT `exp` (a role change ends all sessions). The CLI must
// drop the cache, exchange the key again and retry once; only a 401 from login-with-key means the key is bad.

let serverUrl = '';
let logins = 0;
let loginStatus = 200;
let freshToken = 'fresh-1';
const seen: string[] = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/login-with-key') {
      logins++;
      const key = JSON.parse(body || '{}').apiKey;
      if (loginStatus !== 200) { res.statusCode = loginStatus; res.end(JSON.stringify({ message: 'nope' })); return; }
      if (key !== 'ptr_good') { res.statusCode = 401; res.end(JSON.stringify({ message: 'Invalid key' })); return; }
      res.end(JSON.stringify({ data: { token: freshToken } }));
      return;
    }
    const auth = String(req.headers.authorization || '');
    seen.push(auth);
    if (auth === `Bearer ${freshToken}`) { res.end(JSON.stringify({ data: { ok: true } })); return; }
    res.statusCode = 401;
    res.end(JSON.stringify({ message: 'Unauthorized' }));
  });
});

before(() => new Promise<void>((resolve) => server.listen(0, () => {
  serverUrl = `http://localhost:${(server.address() as import('net').AddressInfo).port}`;
  resolve();
})));
after(() => { server.close(); });

async function withCachedToken(key: string, cached: string, fn: (repo: string, cacheFile: string) => Promise<void>) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-renew-repo-'));
  const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-renew-global-'));
  const prevDir = process.env.PINSAY_CONFIG_DIR;
  const prevKey = process.env.PINSAY_API_KEY;
  process.env.PINSAY_CONFIG_DIR = globalDir;
  delete process.env.PINSAY_API_KEY;
  logins = 0; loginStatus = 200; seen.length = 0;
  try {
    await fs.mkdir(path.join(repo, '.pinsay'), { recursive: true });
    await fs.writeFile(path.join(repo, '.pinsay', 'credentials.env'), `PINSAY_API_KEY=${key}\n`, 'utf8');
    const cacheFile = tokenCacheFile(serverUrl, key);
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ token: cached }), 'utf8');
    await fn(repo, cacheFile);
  } finally {
    if (prevDir === undefined) delete process.env.PINSAY_CONFIG_DIR; else process.env.PINSAY_CONFIG_DIR = prevDir;
    if (prevKey !== undefined) process.env.PINSAY_API_KEY = prevKey;
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(globalDir, { recursive: true, force: true });
  }
}

test('a cached token the server ended: one new exchange, the request is retried and works, the cache holds the new token', () =>
  withCachedToken('ptr_good', 'ended-1', async (repo, cacheFile) => {
    freshToken = 'fresh-1';
    const token = await resolveToken(serverUrl, repo);
    assert.strictEqual(token, 'ended-1');
    assert.strictEqual(logins, 0, 'the cache is used first');

    const out = await api<{ ok: boolean }>(serverUrl, '/api/probe', { token });
    assert.deepStrictEqual(out, { ok: true });
    assert.strictEqual(logins, 1);
    assert.deepStrictEqual(seen, ['Bearer ended-1', 'Bearer fresh-1']);
    assert.strictEqual(JSON.parse(await fs.readFile(cacheFile, 'utf8')).token, 'fresh-1');

    // Later calls that still hold the old token send the new one, with no new exchange.
    await api(serverUrl, '/api/probe', { token });
    assert.strictEqual(logins, 1);
    assert.strictEqual(seen[seen.length - 1], 'Bearer fresh-1');
  }));

test('parallel calls with the ended token share one exchange', () =>
  withCachedToken('ptr_good', 'ended-2', async (repo) => {
    freshToken = 'fresh-2';
    const token = await resolveToken(serverUrl, repo);
    await Promise.all([1, 2, 3].map(() => api(serverUrl, '/api/probe', { token })));
    assert.strictEqual(logins, 1);
  }));

test('a key the server rejects: one exchange attempt, then the 401 and the "saved key no longer works" message', () =>
  withCachedToken('ptr_bad', 'ended-3', async (repo, cacheFile) => {
    const token = await resolveToken(serverUrl, repo);
    const err = await api(serverUrl, '/api/probe', { token }).then(() => null, (e) => e);
    assert.ok(err instanceof ApiError && err.code === 401);
    assert.match(describeError(err).message, /saved key no longer works/);
    assert.strictEqual(logins, 1, 'exactly one retry of the exchange');
    await assert.rejects(fs.access(cacheFile), 'the ended token is no longer cached');
  }));

test('an outage during the new exchange is reported as the outage, not as a bad key', () =>
  withCachedToken('ptr_good', 'ended-4', async (repo) => {
    const token = await resolveToken(serverUrl, repo);
    loginStatus = 503;
    const err = await api(serverUrl, '/api/probe', { token }).then(() => null, (e) => e);
    assert.ok(err instanceof ApiError && err.code === 503);
  }));

test('a token that did not come from resolveToken is never renewed', async () => {
  logins = 0; loginStatus = 200;
  const err = await api(serverUrl, '/api/probe', { token: 'someone-elses' }).then(() => null, (e) => e);
  assert.ok(err instanceof ApiError && err.code === 401);
  assert.strictEqual(logins, 0);
});
