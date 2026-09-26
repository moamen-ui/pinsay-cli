import { test, before, after } from 'node:test';
import * as assert from 'node:assert';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import {
  resolveApiKey,
  saveGlobalCredential,
  getGlobalCredential,
  removeGlobalCredential,
  normalizeServerOrigin,
  sourceLabel,
  globalCredentialsPath,
  tokenCacheFile,
} from '../src/credentials.js';
import { resolveToken } from '../src/auth.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '../dist/cli.js');

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-credentials-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Every test below sets `PINSAY_CONFIG_DIR` to an isolated temp directory — the one override that
 * redirects both `globalConfigDir()` and `globalCacheDir()` (see credentials.ts) away from a real
 * machine's `~/.config`/`~/.cache`. Never rely on the ambient environment here.
 */
async function withGlobalDir(fn: (globalDir: string) => Promise<void>) {
  const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-credentials-global-'));
  const prev = process.env.PINSAY_CONFIG_DIR;
  process.env.PINSAY_CONFIG_DIR = globalDir;
  try {
    await fn(globalDir);
  } finally {
    if (prev === undefined) delete process.env.PINSAY_CONFIG_DIR;
    else process.env.PINSAY_CONFIG_DIR = prev;
    await fs.rm(globalDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------------------------
// resolveApiKey: precedence (env > repo > global), in-process
// -----------------------------------------------------------------------------------------------

test('resolveApiKey: nothing resolves when env, repo, and global are all empty', () =>
  withGlobalDir(() =>
    withTempDir(async (repo) => {
      const prevEnv = process.env.PINSAY_API_KEY;
      delete process.env.PINSAY_API_KEY;
      try {
        const resolved = await resolveApiKey(repo, 'https://example.test');
        assert.strictEqual(resolved.key, undefined);
        assert.strictEqual(resolved.source, null);
      } finally {
        if (prevEnv !== undefined) process.env.PINSAY_API_KEY = prevEnv;
      }
    }),
  ));

test('resolveApiKey: the global store answers when nothing else does', () =>
  withGlobalDir(() =>
    withTempDir(async (repo) => {
      const prevEnv = process.env.PINSAY_API_KEY;
      delete process.env.PINSAY_API_KEY;
      try {
        await saveGlobalCredential('https://example.test', { apiKey: 'ptr_global', displayName: 'Global User' });
        const resolved = await resolveApiKey(repo, 'https://example.test');
        assert.strictEqual(resolved.key, 'ptr_global');
        assert.strictEqual(resolved.source, 'global');
      } finally {
        if (prevEnv !== undefined) process.env.PINSAY_API_KEY = prevEnv;
      }
    }),
  ));

test('resolveApiKey: repo credentials.env wins over the global store', () =>
  withGlobalDir(() =>
    withTempDir(async (repo) => {
      const prevEnv = process.env.PINSAY_API_KEY;
      delete process.env.PINSAY_API_KEY;
      try {
        await saveGlobalCredential('https://example.test', { apiKey: 'ptr_global' });
        await fs.mkdir(path.join(repo, '.pinsay'), { recursive: true });
        await fs.writeFile(path.join(repo, '.pinsay/credentials.env'), 'PINSAY_API_KEY=ptr_repo\n', 'utf8');

        const resolved = await resolveApiKey(repo, 'https://example.test');
        assert.strictEqual(resolved.key, 'ptr_repo');
        assert.strictEqual(resolved.source, 'repo');
      } finally {
        if (prevEnv !== undefined) process.env.PINSAY_API_KEY = prevEnv;
      }
    }),
  ));

test('resolveApiKey: PINSAY_API_KEY env var wins over both repo and global', () =>
  withGlobalDir(() =>
    withTempDir(async (repo) => {
      const prevEnv = process.env.PINSAY_API_KEY;
      process.env.PINSAY_API_KEY = 'ptr_env';
      try {
        await saveGlobalCredential('https://example.test', { apiKey: 'ptr_global' });
        await fs.mkdir(path.join(repo, '.pinsay'), { recursive: true });
        await fs.writeFile(path.join(repo, '.pinsay/credentials.env'), 'PINSAY_API_KEY=ptr_repo\n', 'utf8');

        const resolved = await resolveApiKey(repo, 'https://example.test');
        assert.strictEqual(resolved.key, 'ptr_env');
        assert.strictEqual(resolved.source, 'env');
      } finally {
        if (prevEnv === undefined) delete process.env.PINSAY_API_KEY;
        else process.env.PINSAY_API_KEY = prevEnv;
      }
    }),
  ));

test('resolveApiKey: the global store is keyed by server origin, not by the exact URL string', () =>
  withGlobalDir(() =>
    withTempDir(async (repo) => {
      const prevEnv = process.env.PINSAY_API_KEY;
      delete process.env.PINSAY_API_KEY;
      try {
        await saveGlobalCredential('https://example.test/some/path', { apiKey: 'ptr_global' });
        const resolved = await resolveApiKey(repo, 'https://example.test/');
        assert.strictEqual(resolved.key, 'ptr_global');
        assert.strictEqual(normalizeServerOrigin('https://example.test/some/path'), 'https://example.test');
      } finally {
        if (prevEnv !== undefined) process.env.PINSAY_API_KEY = prevEnv;
      }
    }),
  ));

// -----------------------------------------------------------------------------------------------
// Global store mechanics: 0600 mode, get/save/remove
// -----------------------------------------------------------------------------------------------

test('saveGlobalCredential writes the store file with mode 0600', () =>
  withGlobalDir(async () => {
    await saveGlobalCredential('https://example.test', { apiKey: 'ptr_x' });
    const stat = await fs.stat(globalCredentialsPath());
    assert.strictEqual(stat.mode & 0o777, 0o600);
  }));

test('getGlobalCredential returns the saved entry; removeGlobalCredential deletes it', () =>
  withGlobalDir(async () => {
    await saveGlobalCredential('https://example.test', {
      apiKey: 'ptr_x',
      email: 'dev@example.test',
      displayName: 'Dev',
    });

    const entry = await getGlobalCredential('https://example.test');
    assert.strictEqual(entry?.apiKey, 'ptr_x');
    assert.strictEqual(entry?.email, 'dev@example.test');
    assert.strictEqual(entry?.displayName, 'Dev');
    assert.ok(entry?.savedAt);

    const removed = await removeGlobalCredential('https://example.test');
    assert.strictEqual(removed, true);
    assert.strictEqual(await getGlobalCredential('https://example.test'), undefined);

    // Removing again reports nothing-to-remove rather than throwing.
    assert.strictEqual(await removeGlobalCredential('https://example.test'), false);
  }));

test('saving a second server does not disturb the first', () =>
  withGlobalDir(async () => {
    await saveGlobalCredential('https://a.example.test', { apiKey: 'ptr_a' });
    await saveGlobalCredential('https://b.example.test', { apiKey: 'ptr_b' });

    assert.strictEqual((await getGlobalCredential('https://a.example.test'))?.apiKey, 'ptr_a');
    assert.strictEqual((await getGlobalCredential('https://b.example.test'))?.apiKey, 'ptr_b');

    await removeGlobalCredential('https://a.example.test');
    assert.strictEqual(await getGlobalCredential('https://a.example.test'), undefined);
    assert.strictEqual((await getGlobalCredential('https://b.example.test'))?.apiKey, 'ptr_b');
  }));

test('sourceLabel gives a human label for every source, including none', () => {
  assert.strictEqual(sourceLabel('env'), 'env var');
  assert.strictEqual(sourceLabel('repo'), 'repo credentials.env');
  assert.strictEqual(sourceLabel('global'), 'global store');
  assert.strictEqual(sourceLabel(null), 'none');
});

// -----------------------------------------------------------------------------------------------
// `pinsay login` / `logout` / `whoami`, end-to-end against a stub server
// -----------------------------------------------------------------------------------------------

let server: http.Server;
let serverUrl: string;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/branding') {
      res.end(JSON.stringify({ productName: 'PinSay Test', urls: { app: 'http://test' } }));
    } else if (req.url === '/api/auth/login-with-key') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const apiKey = (() => {
          try {
            return JSON.parse(body || '{}').apiKey;
          } catch {
            return undefined;
          }
        })();
        if (apiKey === 'ptr_good') {
          res.end(
            JSON.stringify({
              data: { status: 'ok', token: 'jwt-for-test', user: { displayName: 'Test User', email: 'test@example.com' } },
              isSuccess: true,
            }),
          );
        } else {
          res.writeHead(401);
          res.end(JSON.stringify({ message: 'Invalid API key' }));
        }
      });
      return;
    } else if (req.url === '/api/auth/me') {
      if (req.headers.authorization === 'Bearer jwt-for-test') {
        res.end(JSON.stringify({ data: { displayName: 'Test User', email: 'test@example.com' }, isSuccess: true }));
      } else {
        res.writeHead(401);
        res.end(JSON.stringify({ message: 'Unauthorized' }));
      }
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ message: 'Not found' }));
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(0, () => {
      const addr = server.address() as import('net').AddressInfo;
      serverUrl = `http://localhost:${addr.port}`;
      resolve();
    }),
  );
});

after(() => {
  server.close();
});

function envFor(globalDir: string): NodeJS.ProcessEnv {
  return { ...process.env, PINSAY_CONFIG_DIR: globalDir };
}

test('login saves the key globally; whoami reports it; logout removes it', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      const { stdout: loginOut } = await execAsync(
        `node ${cliPath} login --key ptr_good --server ${serverUrl}`,
        { cwd: repo, env: envFor(globalDir) },
      );
      assert.match(loginOut, /Signed in to/);
      assert.match(loginOut, /saved for all repos on this machine/);

      const store = JSON.parse(await fs.readFile(path.join(globalDir, 'credentials.json'), 'utf8'));
      assert.strictEqual(store[new URL(serverUrl).origin].apiKey, 'ptr_good');

      const { stdout: whoamiOut } = await execAsync(`node ${cliPath} whoami --server ${serverUrl} --json`, {
        cwd: repo,
        env: envFor(globalDir),
      });
      const whoami = JSON.parse(whoamiOut.trim().split('\n').pop()!);
      assert.strictEqual(whoami.ok, true);
      assert.strictEqual(whoami.source, 'global');
      assert.strictEqual(whoami.displayName, 'Test User');
      assert.strictEqual(whoami.email, 'test@example.com');

      const { stdout: logoutOut } = await execAsync(`node ${cliPath} logout --server ${serverUrl}`, {
        cwd: repo,
        env: envFor(globalDir),
      });
      assert.match(logoutOut, /Removed the saved key/);

      await assert.rejects(
        execAsync(`node ${cliPath} whoami --server ${serverUrl} --json`, { cwd: repo, env: envFor(globalDir) }),
        (err: any) => {
          assert.strictEqual(err.code, 3);
          return true;
        },
        'whoami must fail once the key is gone',
      );
    }),
  ));

test('whoami reports source env when PINSAY_API_KEY is set, even with a global entry present', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      await execAsync(`node ${cliPath} login --key ptr_good --server ${serverUrl}`, {
        cwd: repo,
        env: envFor(globalDir),
      });

      const { stdout } = await execAsync(`node ${cliPath} whoami --server ${serverUrl} --json`, {
        cwd: repo,
        env: { ...envFor(globalDir), PINSAY_API_KEY: 'ptr_good' },
      });
      const whoami = JSON.parse(stdout.trim().split('\n').pop()!);
      assert.strictEqual(whoami.source, 'env');
    }),
  ));

test('logout on a server with no saved key reports nothing removed', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      const { stdout } = await execAsync(`node ${cliPath} logout --server ${serverUrl} --json`, {
        cwd: repo,
        env: envFor(globalDir),
      });
      const json = JSON.parse(stdout.trim());
      assert.strictEqual(json.removed, false);
    }),
  ));

test('login --scope repo writes .pinsay/credentials.env and leaves the global store alone', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      const { stdout } = await execAsync(
        `node ${cliPath} login --key ptr_good --server ${serverUrl} --scope repo`,
        { cwd: repo, env: envFor(globalDir) },
      );
      assert.match(stdout, /this repo only/);
      const creds = await fs.readFile(path.join(repo, '.pinsay/credentials.env'), 'utf8');
      assert.match(creds, /PINSAY_API_KEY=ptr_good/);
      assert.match(creds, new RegExp(`PINSAY_SERVER=${serverUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      await assert.rejects(fs.access(path.join(globalDir, 'credentials.json')), 'global store must not be created');
    }),
  ));

test('login --scope with an unknown value exits 2', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      await assert.rejects(
        execAsync(`node ${cliPath} login --key ptr_good --server ${serverUrl} --scope machine`, { cwd: repo, env: envFor(globalDir) }),
        (err: any) => err.code === 2 && /Invalid --scope/.test(err.stderr),
      );
    }),
  ));

// -----------------------------------------------------------------------------------------------
// Expired cached JWT (see auth.ts's isJwtExpired) — a dead cache entry must not wedge every
// later command into a 401 until someone thinks to clear ~/.cache/pointer by hand.
// -----------------------------------------------------------------------------------------------

function fakeJwt(exp: number): string {
  const b64url = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none' })}.${b64url({ exp })}.sig`;
}

// `resolveToken` (not `whoami`, which does its own standalone login-with-key call and never
// touches the cache) is the one path real commands like `list`/`apply` share — see auth.ts.
test('resolveToken discards an expired cached JWT and re-exchanges the key, instead of trusting it forever', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      const prevConfigDir = process.env.PINSAY_CONFIG_DIR;
      process.env.PINSAY_CONFIG_DIR = globalDir;
      try {
        await saveGlobalCredential(serverUrl, { apiKey: 'ptr_good' });

        // Seed the cache with a structurally-real but long-expired JWT — exactly what a token
        // minted hours ago (in an earlier session, say) and never revalidated looks like on disk.
        const cacheFile = tokenCacheFile(serverUrl, 'ptr_good');
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify({ token: fakeJwt(Math.floor(Date.now() / 1000) - 3600) }), 'utf8');

        const token = await resolveToken(serverUrl, repo);
        // Before the fix this returns the dead cached JWT verbatim, and every later request the
        // caller makes with it 401s — reproducing the reported bug (login succeeds, list fails).
        assert.strictEqual(token, 'jwt-for-test', 'must fall through to a fresh exchange, not the dead cache entry');

        // The dead entry must have been overwritten with a live one, not merely bypassed in memory.
        const refreshed = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
        assert.strictEqual(refreshed.token, 'jwt-for-test');
      } finally {
        if (prevConfigDir === undefined) delete process.env.PINSAY_CONFIG_DIR;
        else process.env.PINSAY_CONFIG_DIR = prevConfigDir;
      }
    }),
  ));

test('resolveToken keeps a non-expiring cached token as-is (a test stub / non-JWT string is never second-guessed)', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      const prevConfigDir = process.env.PINSAY_CONFIG_DIR;
      process.env.PINSAY_CONFIG_DIR = globalDir;
      try {
        await saveGlobalCredential(serverUrl, { apiKey: 'ptr_good' });
        const cacheFile = tokenCacheFile(serverUrl, 'ptr_good');
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify({ token: 'jwt-for-test' }), 'utf8');
        const mtimeBefore = (await fs.stat(cacheFile)).mtimeMs;

        const token = await resolveToken(serverUrl, repo);
        assert.strictEqual(token, 'jwt-for-test');
        // Must be returned straight from the cache — not rewritten via a fresh (unnecessary) exchange.
        assert.strictEqual((await fs.stat(cacheFile)).mtimeMs, mtimeBefore);
      } finally {
        if (prevConfigDir === undefined) delete process.env.PINSAY_CONFIG_DIR;
        else process.env.PINSAY_CONFIG_DIR = prevConfigDir;
      }
    }),
  ));
