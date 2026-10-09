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
  normalizeServerOrigin,
  sourceLabel,
  globalCredentialsPath,
  tokenCacheFile,
  legacyGlobalCredentialsPath,
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
// resolveApiKey: precedence (env > repo), in-process
// -----------------------------------------------------------------------------------------------

test('resolveApiKey: nothing resolves when env and repo are both empty', () =>
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

test('resolveApiKey: a credentials.json in the machine folder is ignored (0.10.0)', () =>
  withGlobalDir(() =>
    withTempDir(async (repo) => {
      const prevEnv = process.env.PINSAY_API_KEY;
      delete process.env.PINSAY_API_KEY;
      try {
        await fs.writeFile(
          globalCredentialsPath(),
          JSON.stringify({ [normalizeServerOrigin('https://example.test')]: { apiKey: 'ptr_machine' } }),
          'utf8',
        );
        const resolved = await resolveApiKey(repo, 'https://example.test');
        assert.deepStrictEqual(resolved, { key: undefined, source: null });
      } finally {
        if (prevEnv !== undefined) process.env.PINSAY_API_KEY = prevEnv;
      }
    }),
  ));

test('resolveApiKey: PINSAY_API_KEY env var wins over the repo key', () =>
  withGlobalDir(() =>
    withTempDir(async (repo) => {
      const prevEnv = process.env.PINSAY_API_KEY;
      process.env.PINSAY_API_KEY = 'ptr_env';
      try {
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

// -----------------------------------------------------------------------------------------------
// Machine folder paths
// -----------------------------------------------------------------------------------------------

test('sourceLabel gives a human label for every source, including none', () => {
  assert.strictEqual(sourceLabel('env'), 'env var');
  assert.strictEqual(sourceLabel('repo'), 'repo credentials.env');
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
        res.end(JSON.stringify({ data: { displayName: 'Test User', email: 'test@example.com', tenantName: 'Test Workspace' }, isSuccess: true }));
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
  return { ...process.env, PINSAY_CONFIG_DIR: globalDir, PINSAY_SERVER: serverUrl };
}

test('login saves the key in the repo; whoami reports it; logout removes it', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      await execAsync('git init -q', { cwd: repo });
      const { stdout: loginOut } = await execAsync(
        `node ${cliPath} login --key ptr_good`,
        { cwd: repo, env: envFor(globalDir) },
      );
      assert.match(loginOut, /Signed in as Test User/);

      const creds = await fs.readFile(path.join(repo, '.pinsay', 'credentials.env'), 'utf8');
      assert.match(creds, /^PINSAY_API_KEY=ptr_good$/m);

      const { stdout: whoamiOut } = await execAsync(`node ${cliPath} whoami --json`, {
        cwd: repo,
        env: envFor(globalDir),
      });
      const whoami = JSON.parse(whoamiOut.trim().split('\n').pop()!);
      assert.strictEqual(whoami.ok, true);
      assert.strictEqual(whoami.source, 'repo');
      assert.strictEqual(whoami.displayName, 'Test User');
      assert.strictEqual(whoami.email, 'test@example.com');
      assert.strictEqual(whoami.workspace, 'Test Workspace');

      const { stdout: logoutOut } = await execAsync(`node ${cliPath} logout`, {
        cwd: repo,
        env: envFor(globalDir),
      });
      assert.match(logoutOut, /Signed out: removed this repo's key/);
      await assert.rejects(fs.access(path.join(repo, '.pinsay', 'credentials.env')));

      await assert.rejects(
        execAsync(`node ${cliPath} whoami --json`, { cwd: repo, env: envFor(globalDir) }),
        (err: any) => {
          assert.strictEqual(err.code, 3);
          return true;
        },
        'whoami must fail once the key is gone',
      );
    }),
  ));

test('whoami reports source env when PINSAY_API_KEY is set', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      const { stdout } = await execAsync(`node ${cliPath} whoami --json`, {
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
      const { stdout } = await execAsync(`node ${cliPath} logout --json`, {
        cwd: repo,
        env: envFor(globalDir),
      });
      const json = JSON.parse(stdout.trim());
      assert.strictEqual(json.removed, false);
      assert.strictEqual(json.source, 'repo');
    }),
  ));

test('login --scope repo writes .pinsay/credentials.env and writes nothing in the config dir', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      const { stdout } = await execAsync(
        `node ${cliPath} login --key ptr_good --scope repo`,
        { cwd: repo, env: envFor(globalDir) },
      );
      assert.match(stdout, /Key saved in this repo/);
      const creds = await fs.readFile(path.join(repo, '.pinsay/credentials.env'), 'utf8');
      assert.match(creds, /PINSAY_API_KEY=ptr_good/);
      assert.doesNotMatch(creds, /PINSAY_SERVER=/);
      await assert.rejects(fs.access(path.join(globalDir, 'credentials.json')), 'no machine store may be created');
    }),
  ));

test('login --scope with an unknown value exits 2', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      await assert.rejects(
        execAsync(`node ${cliPath} login --key ptr_good --scope machine`, { cwd: repo, env: envFor(globalDir) }),
        (err: any) => err.code === 2 && /Invalid --scope/.test(err.stderr),
      );
    }),
  ));

// -----------------------------------------------------------------------------------------------
// Expired cached JWT (see auth.ts's isJwtExpired) — a dead cache entry must not wedge every
// later command into a 401 until someone thinks to clear ~/.cache/pinsay by hand.
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
        await fs.mkdir(path.join(repo, '.pinsay'), { recursive: true });
        await fs.writeFile(path.join(repo, '.pinsay', 'credentials.env'), 'PINSAY_API_KEY=ptr_good\n', 'utf8');

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
        await fs.mkdir(path.join(repo, '.pinsay'), { recursive: true });
        await fs.writeFile(path.join(repo, '.pinsay', 'credentials.env'), 'PINSAY_API_KEY=ptr_good\n', 'utf8');
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

// -----------------------------------------------------------------------------------------------
// Per-machine folder `pinsay`, and the one-time move of a pre-0.8.0 `pointer` store
// -----------------------------------------------------------------------------------------------

/**
 * Points XDG_CONFIG_HOME / XDG_CACHE_HOME at fresh temp dirs and UNSETS PINSAY_CONFIG_DIR (which
 * disables the legacy read), so the real base-dir logic runs — never against a real ~/.config.
 */
async function withXdgDirs(fn: (configHome: string, cacheHome: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-xdg-'));
  const configHome = path.join(root, 'config');
  const cacheHome = path.join(root, 'cache');
  await fs.mkdir(configHome, { recursive: true });
  await fs.mkdir(cacheHome, { recursive: true });
  const prev = {
    PINSAY_CONFIG_DIR: process.env.PINSAY_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  delete process.env.PINSAY_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_CACHE_HOME = cacheHome;
  try {
    await fn(configHome, cacheHome);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

test('the machine folder and the JWT cache live in a `pinsay` folder', { skip: process.platform === 'win32' && 'XDG paths' }, () =>
  withXdgDirs(async (configHome, cacheHome) => {
    assert.strictEqual(globalCredentialsPath(), path.join(configHome, 'pinsay', 'credentials.json'));
    assert.strictEqual(path.dirname(tokenCacheFile('https://example.test', 'ptr_x')), path.join(cacheHome, 'pinsay'));
    assert.strictEqual(legacyGlobalCredentialsPath(), path.join(configHome, 'pointer', 'credentials.json'));
  }));

test('login outside any repo exits 2 and writes nothing', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      await assert.rejects(
        execAsync(`node ${cliPath} login --key ptr_good`, { cwd: repo, env: envFor(globalDir) }),
        (err: any) => err.code === 2 && /Run this inside your project's repo/.test(err.stderr + err.stdout),
      );
      assert.strictEqual(await exists(path.join(repo, '.pinsay')), false);
      assert.strictEqual(await exists(path.join(globalDir, 'credentials.json')), false);
    }),
  ));

test('login --local-credentials writes the repo file and hides it from git', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      const { stdout } = await execAsync(`node ${cliPath} login --key ptr_good --local-credentials`, {
        cwd: repo,
        env: envFor(globalDir),
      });
      assert.match(stdout, /Key saved in this repo \(\.pinsay\/credentials\.env/);
      assert.match(await fs.readFile(path.join(repo, '.pinsay', 'credentials.env'), 'utf8'), /^PINSAY_API_KEY=ptr_good$/m);
      // Not a git repo here: only `.pinsay/.gitignore` is written, and no root .gitignore is created.
      await fs.access(path.join(repo, '.pinsay', '.gitignore'));
      await assert.rejects(fs.access(path.join(repo, '.gitignore')));
    }),
  ));

test('login --scope with an unknown value exits 2 before signing in (no --key needed)', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      await assert.rejects(
        execAsync(`node ${cliPath} login --scope machine`, { cwd: repo, env: envFor(globalDir) }),
        (err: any) => err.code === 2 && /Invalid --scope/.test(err.stderr),
      );
    }),
  ));

// -----------------------------------------------------------------------------------------------
// 0.10.0 key storage (SPEC B2): the key lives in the repo only; --global is rejected; logout removes it.
// -----------------------------------------------------------------------------------------------

async function gitInit(dir: string): Promise<void> {
  await execAsync('git init -q', { cwd: dir });
}


test('login in a git repo saves the key in the repo (0600) and not on the machine', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      await gitInit(repo);
      const { stdout } = await execAsync(`node ${cliPath} login --key ptr_good`, { cwd: repo, env: envFor(globalDir) });
      assert.match(stdout, /Key saved in this repo \(\.pinsay\/credentials\.env, hidden from git\)/);
      const file = path.join(repo, '.pinsay', 'credentials.env');
      assert.match(await fs.readFile(file, 'utf8'), /^PINSAY_API_KEY=ptr_good$/m);
      if (process.platform !== 'win32') assert.strictEqual((await fs.stat(file)).mode & 0o777, 0o600);
      assert.strictEqual(await exists(path.join(globalDir, 'credentials.json')), false);
      const { stdout: st } = await execAsync('git status --porcelain', { cwd: repo });
      assert.doesNotMatch(st, /credentials/);
    }),
  ));

test('login --global and --scope global exit 2 with the removed-flag message', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      await gitInit(repo);
      for (const flag of ['--global', '--scope global']) {
        await assert.rejects(
          execAsync(`node ${cliPath} login --key ptr_good ${flag}`, { cwd: repo, env: envFor(globalDir) }),
          (err: any) => err.code === 2 && /--global is no longer supported/.test(err.stderr + err.stdout),
        );
        assert.strictEqual(await exists(path.join(repo, '.pinsay')), false);
        assert.strictEqual(await exists(path.join(globalDir, 'credentials.json')), false);
      }
    }),
  ));

test('logout removes the repo key; a second logout says there is none', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      await gitInit(repo);
      await execAsync(`node ${cliPath} login --key ptr_good`, { cwd: repo, env: envFor(globalDir) });

      const first = JSON.parse((await execAsync(`node ${cliPath} logout --json`, { cwd: repo, env: envFor(globalDir) })).stdout.trim());
      assert.deepStrictEqual([first.source, first.removed], ['repo', true]);
      assert.strictEqual(await exists(path.join(repo, '.pinsay', 'credentials.env')), false);

      const { stdout } = await execAsync(`node ${cliPath} logout`, { cwd: repo, env: envFor(globalDir) });
      assert.match(stdout, /No key saved in this repo\./);
    }),
  ));

test('logout --global exits 2 with the removed-flag message', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      await gitInit(repo);
      await assert.rejects(
        execAsync(`node ${cliPath} logout --global`, { cwd: repo, env: envFor(globalDir) }),
        (err: any) => err.code === 2 && /--global is no longer supported/.test(err.stderr + err.stdout),
      );
    }),
  ));

test('logout with PINSAY_API_KEY set removes nothing and says to unset it', () =>
  withTempDir(async (repo) =>
    withGlobalDir(async (globalDir) => {
      await gitInit(repo);
      await execAsync(`node ${cliPath} login --key ptr_good`, { cwd: repo, env: envFor(globalDir) });
      const { stdout } = await execAsync(`node ${cliPath} logout`, { cwd: repo, env: { ...envFor(globalDir), PINSAY_API_KEY: 'ptr_good' } });
      assert.match(stdout, /Your key comes from the PINSAY_API_KEY variable\. Unset it to sign out\./);
      assert.strictEqual(await exists(path.join(repo, '.pinsay', 'credentials.env')), true);
    }),
  ));
