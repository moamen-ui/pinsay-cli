import { test } from 'node:test';
import * as assert from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// The served script lives in this monorepo's API project (the old path assumed the CLI sat inside
// pinsay-api/, so every test here was silently skipped).
const shPath = path.resolve(__dirname, '../../pinsay-api/API/wwwroot/pinsay.sh');
const shAvailable = existsSync(shPath);

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-sh-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function installShTo(
  dir: string,
  config: unknown,
  credentialsEnv = 'PINSAY_API_KEY=ptr_x\nPINSAY_SERVER=http://127.0.0.1:1\n',
) {
  const pointerDir = path.join(dir, '.pinsay');
  await fs.mkdir(pointerDir, { recursive: true });
  const script = await fs.readFile(shPath, 'utf8');
  await fs.writeFile(path.join(pointerDir, 'pinsay.sh'), script, { mode: 0o755 });
  await fs.writeFile(path.join(pointerDir, 'config.json'), JSON.stringify(config), 'utf8');
  await fs.writeFile(path.join(pointerDir, 'credentials.env'), credentialsEnv, 'utf8');
}

async function withGlobalDir(fn: (globalDir: string) => Promise<void>) {
  const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-sh-global-'));
  try {
    await fn(globalDir);
  } finally {
    await fs.rm(globalDir, { recursive: true, force: true });
  }
}

test('pinsay.sh is valid bash syntax (bash -n)', { skip: (!shAvailable && 'needs the pinsay-api monorepo checkout (API/wwwroot/pinsay.sh)') || (process.platform === 'win32' && 'pinsay.sh is a POSIX shell script') }, () => {
  // Never skip this — it is the one check that catches a shell syntax error before it reaches a
  // consumer repo, since nothing else in the CLI's own test suite parses the served shell script.
  execFileSync('bash', ['-n', shPath]);
});

test('pinsay.sh: a multi-project config with no -p prints the configured keys and exits 2', { skip: (!shAvailable && 'needs the pinsay-api monorepo checkout (API/wwwroot/pinsay.sh)') || (process.platform === 'win32' && 'pinsay.sh is a POSIX shell script') }, () =>
  withTempDir(async (dir) => {
    await installShTo(dir, {
      server: 'http://127.0.0.1:1',
      projects: { a: { path: 'apps/a' }, b: { path: 'apps/b' } },
    });

    await assert.rejects(
      execFileAsync('bash', [path.join(dir, '.pinsay/pinsay.sh'), 'list'], { cwd: dir, env: { ...process.env, PINSAY_SERVER: 'http://127.0.0.1:1' } }),
      (err: any) => {
        assert.strictEqual(err.code, 2);
        assert.match(err.stderr, /Several projects configured/);
        assert.match(err.stderr, /a, b|b, a/);
        return true;
      },
    );
  }));

test('pinsay.sh: -p <key> resolves the project and proceeds past the multi-project check', { skip: (!shAvailable && 'needs the pinsay-api monorepo checkout (API/wwwroot/pinsay.sh)') || (process.platform === 'win32' && 'pinsay.sh is a POSIX shell script') }, () =>
  withTempDir(async (dir) => {
    await installShTo(dir, {
      server: 'http://127.0.0.1:1',
      projects: { a: { path: 'apps/a' }, b: { path: 'apps/b' } },
    });

    await assert.rejects(
      execFileAsync('bash', [path.join(dir, '.pinsay/pinsay.sh'), '-p', 'a', 'list'], { cwd: dir, env: { ...process.env, PINSAY_SERVER: 'http://127.0.0.1:1' } }),
      (err: any) => {
        // Fails on the network call (there is no real server) — the point is it got PAST the
        // "several projects configured" refusal, which a bare `list` (no -p) hits instead.
        assert.doesNotMatch(err.stderr ?? '', /Several projects configured/);
        return true;
      },
    );
  }));

test('pinsay.sh: PINSAY_PROJECT env resolves the project just like -p', { skip: (!shAvailable && 'needs the pinsay-api monorepo checkout (API/wwwroot/pinsay.sh)') || (process.platform === 'win32' && 'pinsay.sh is a POSIX shell script') }, () =>
  withTempDir(async (dir) => {
    await installShTo(dir, {
      server: 'http://127.0.0.1:1',
      projects: { a: { path: 'apps/a' }, b: { path: 'apps/b' } },
    });

    await assert.rejects(
      execFileAsync('bash', [path.join(dir, '.pinsay/pinsay.sh'), 'list'], {
        cwd: dir,
        env: { ...process.env, PINSAY_PROJECT: 'b', PINSAY_SERVER: 'http://127.0.0.1:1' },
      }),
      (err: any) => {
        assert.doesNotMatch(err.stderr ?? '', /Several projects configured/);
        return true;
      },
    );
  }));

test('pinsay.sh: a single-project config never hits the multi-project check', { skip: (!shAvailable && 'needs the pinsay-api monorepo checkout (API/wwwroot/pinsay.sh)') || (process.platform === 'win32' && 'pinsay.sh is a POSIX shell script') }, () =>
  withTempDir(async (dir) => {
    await installShTo(dir, { server: 'http://127.0.0.1:1', project: 'solo' });

    await assert.rejects(
      execFileAsync('bash', [path.join(dir, '.pinsay/pinsay.sh'), 'list'], { cwd: dir, env: { ...process.env, PINSAY_SERVER: 'http://127.0.0.1:1' } }),
      (err: any) => {
        assert.doesNotMatch(err.stderr ?? '', /Several projects configured/);
        return true;
      },
    );
  }));

// -----------------------------------------------------------------------------------------------
// Global credential store fallback (API key only — server/project resolution is unchanged)
// -----------------------------------------------------------------------------------------------

test('pinsay.sh: falls back to the global credential store when no PINSAY_API_KEY line exists locally', { skip: (!shAvailable && 'needs the pinsay-api monorepo checkout (API/wwwroot/pinsay.sh)') || (process.platform === 'win32' && 'pinsay.sh is a POSIX shell script') }, () =>
  withTempDir((dir) =>
    withGlobalDir(async (globalDir) => {
      // credentials.env carries SERVER/PROJECT (as `resolve_config` needs) but deliberately no
      // PINSAY_API_KEY line — the key must come from the global store instead.
      await installShTo(
        dir,
        { server: 'http://127.0.0.1:1', project: 'solo' },
        'PINSAY_SERVER=http://127.0.0.1:1\nPINSAY_PROJECT=solo\n',
      );
      await fs.writeFile(
        path.join(globalDir, 'credentials.json'),
        JSON.stringify({ 'http://127.0.0.1:1': { apiKey: 'ptr_from_global' } }),
        'utf8',
      );

      await assert.rejects(
        execFileAsync('bash', [path.join(dir, '.pinsay/pinsay.sh'), 'list'], {
          cwd: dir,
          env: { ...process.env, PINSAY_CONFIG_DIR: globalDir, PINSAY_SERVER: 'http://127.0.0.1:1' },
        }),
        (err: any) => {
          // Port 1 refuses connections, so this still fails — the point is it got PAST "Missing
          // configuration" (exit 1), which is exactly what happens when API_KEY never resolves.
          assert.notStrictEqual(err.code, 1, 'must not report missing configuration');
          assert.doesNotMatch(err.stderr ?? '', /Missing configuration/);
          return true;
        },
      );
    }),
  ));

test('pinsay.sh: "Missing configuration" when no key resolves anywhere (env, repo, or global store)', { skip: (!shAvailable && 'needs the pinsay-api monorepo checkout (API/wwwroot/pinsay.sh)') || (process.platform === 'win32' && 'pinsay.sh is a POSIX shell script') }, () =>
  withTempDir((dir) =>
    withGlobalDir(async (globalDir) => {
      await installShTo(
        dir,
        { server: 'http://127.0.0.1:1', project: 'solo' },
        'PINSAY_SERVER=http://127.0.0.1:1\nPINSAY_PROJECT=solo\n',
      );
      // globalDir exists but has no credentials.json at all.

      await assert.rejects(
        execFileAsync('bash', [path.join(dir, '.pinsay/pinsay.sh'), 'list'], {
          cwd: dir,
          env: { ...process.env, PINSAY_CONFIG_DIR: globalDir, PINSAY_SERVER: 'http://127.0.0.1:1' },
        }),
        (err: any) => {
          assert.strictEqual(err.code, 1);
          assert.match(err.stderr ?? '', /Missing configuration/);
          return true;
        },
      );
    }),
  ));

test('pinsay.sh: PINSAY_API_KEY env var wins over the global store', { skip: (!shAvailable && 'needs the pinsay-api monorepo checkout (API/wwwroot/pinsay.sh)') || (process.platform === 'win32' && 'pinsay.sh is a POSIX shell script') }, () =>
  withTempDir((dir) =>
    withGlobalDir(async (globalDir) => {
      await installShTo(
        dir,
        { server: 'http://127.0.0.1:1', project: 'solo' },
        'PINSAY_SERVER=http://127.0.0.1:1\nPINSAY_PROJECT=solo\n',
      );
      await fs.writeFile(
        path.join(globalDir, 'credentials.json'),
        JSON.stringify({ 'http://127.0.0.1:1': { apiKey: 'ptr_from_global' } }),
        'utf8',
      );

      await assert.rejects(
        execFileAsync('bash', [path.join(dir, '.pinsay/pinsay.sh'), 'list'], {
          cwd: dir,
          env: { ...process.env, PINSAY_CONFIG_DIR: globalDir, PINSAY_API_KEY: 'ptr_env', PINSAY_SERVER: 'http://127.0.0.1:1' },
        }),
        (err: any) => {
          // Same network failure as above — proves resolution completed (env wins, no missing-
          // configuration exit) without needing to intercept the outgoing request.
          assert.notStrictEqual(err.code, 1, 'must not report missing configuration');
          return true;
        },
      );
    }),
  ));

// -----------------------------------------------------------------------------------------------
// Per-machine folder `pinsay`, the read-only fallback to a pre-0.8.0 `pointer` store, fixed server
// -----------------------------------------------------------------------------------------------

test('pinsay.sh: reads an old `pointer` store when the `pinsay` one does not exist, and leaves it in place', { skip: (!shAvailable && 'needs pinsay-api/API/wwwroot/pinsay.sh') || (process.platform === 'win32' && 'pinsay.sh is a POSIX shell script') }, () =>
  withTempDir(async (dir) => {
    await installShTo(dir, { project: 'solo' }, 'PINSAY_PROJECT=solo\n');
    const configHome = path.join(dir, 'xdg-config');
    const cacheHome = path.join(dir, 'xdg-cache');
    const legacyFile = path.join(configHome, 'pointer', 'credentials.json');
    await fs.mkdir(path.dirname(legacyFile), { recursive: true });
    await fs.writeFile(legacyFile, JSON.stringify({ 'http://127.0.0.1:1': { apiKey: 'ptr_legacy' } }), 'utf8');
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: configHome, XDG_CACHE_HOME: cacheHome, PINSAY_SERVER: 'http://127.0.0.1:1' };
    delete env.PINSAY_CONFIG_DIR;
    delete env.PINSAY_API_KEY;

    await assert.rejects(
      execFileAsync('bash', [path.join(dir, '.pinsay/pinsay.sh'), 'list'], { cwd: dir, env }),
      (err: any) => {
        // Port 1 refuses the connection; the point is the key resolved (no "Missing configuration").
        assert.doesNotMatch(err.stderr ?? '', /Missing configuration/);
        return true;
      },
    );
    assert.ok(existsSync(legacyFile), 'the shell never moves or deletes the old store');
    assert.ok(existsSync(path.join(cacheHome, 'pinsay')), 'the JWT cache goes to the pinsay folder');
    assert.ok(!existsSync(path.join(cacheHome, 'pointer')), 'nothing is written under pointer');
  }));

test('pinsay.sh: the server is fixed (app.pinsay.dev or the PINSAY_SERVER override), never read from files', { skip: !shAvailable && 'needs pinsay-api/API/wwwroot/pinsay.sh' }, async () => {
  const script = await fs.readFile(shPath, 'utf8');
  assert.match(script, /SERVER="\$\{PINSAY_SERVER:-https:\/\/app\.pinsay\.dev\}"/);
  assert.doesNotMatch(script, /resolve_config PINSAY_SERVER/);
  assert.doesNotMatch(script, /\.config\}\/pointer"|\.cache\}\/pointer"/, 'no pointer folder is used for writing');
});
