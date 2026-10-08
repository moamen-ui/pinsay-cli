// DB-18: workspace paused / scheduled-for-deletion — CLI behaviour.
//
// Contract (docs/db/execution/DB-18-workspace-self-service-pause-and-delete.md §3.5/§3.6, task 18):
// `apply`/`apply --plan`/`apply --mark` read `GET /api/auth/me` right after auth and exit 2 —
// before any git/AI work — when the workspace is paused or scheduled for deletion; `deployed` must
// never fail a customer's CI, so a 423 there is a warning and an exit 0.
import { test, before, after } from 'node:test';
import * as assert from 'node:assert';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '../dist/cli.js');
const execAsync = promisify(exec);

let server: http.Server;
let serverUrl: string;
// Toggled per-test to control what /api/auth/me answers with.
let meResponse: Record<string, unknown> = {};
// Set whenever a request the frozen-check should have short-circuited (queue/apply-queue/PATCH)
// reaches the stub — proves "before any git/AI work".
let touchedQueueOrWrite = false;
// DB-18 code review (Opus MEDIUM): simulates the workspace freezing in the gap between the /me
// pre-check and the queue fetch — /me still answers "not frozen" but the queue GET itself 423s.
let queueFrozen = false;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url || '';

    if (url === '/api/meta') {
      res.end(JSON.stringify({ isSuccess: true, data: { minCliVersion: '0.0.0' } }));
      return;
    }
    if (url === '/api/branding') {
      res.end(JSON.stringify({ productName: 'PinSay Test', urls: { app: 'http://test' }, extension: {} }));
      return;
    }
    if (req.method === 'POST' && url === '/api/auth/login-with-key') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.end(JSON.stringify({ isSuccess: true, data: { status: 'ok', token: 'jwt-for-test' } }));
      });
      return;
    }
    if (req.method === 'GET' && url === '/api/auth/me') {
      res.end(JSON.stringify({ isSuccess: true, data: meResponse }));
      return;
    }
    // Anything under the apply queue or a comment write means the frozen-check did NOT stop the
    // command before touching the queue/git/AI path.
    if (
      url.startsWith('/api/admin/projects/') ||
      url.match(/^\/api\/projects\/[^/]+\/comments/) ||
      (req.method === 'PATCH' && url.startsWith('/api/comments/'))
    ) {
      touchedQueueOrWrite = true;
      if (queueFrozen) {
        res.writeHead(423, { 'x-workspace-paused': 'true' });
        res.end(JSON.stringify({ isSuccess: false, message: 'This workspace is paused.' }));
        return;
      }
      res.end(JSON.stringify({ isSuccess: true, data: { items: [] } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ isSuccess: false, message: 'Not found' }));
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

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-db18-cli-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeSingleProjectRepo(dir: string) {
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({ server: serverUrl, project: 'my-app' }),
    'utf8',
  );
  await fs.writeFile(path.join(dir, '.pinsay/credentials.env'), 'PINSAY_API_KEY=ptr_good\n', 'utf8');
}

test('apply (default): a paused workspace exits 2 with the paused message, before touching the queue', () =>
  withTempDir(async (dir) => {
    await writeSingleProjectRepo(dir);
    meResponse = { tenantName: 'Acme Corp', workspacePausedAt: '2026-09-20T12:00:00Z', workspaceDeletionScheduledFor: null };
    touchedQueueOrWrite = false;

    await assert.rejects(
      execAsync(`node ${cliPath} apply`, { cwd: dir, env: { ...process.env, PINSAY_SERVER: serverUrl } }),
      (err: any) => {
        assert.strictEqual(err.code, 2);
        assert.match(
          err.stderr,
          /Workspace "Acme Corp" is paused — apply is disabled until a workspace admin resumes it\./,
        );
        return true;
      },
    );
    assert.strictEqual(touchedQueueOrWrite, false, 'must exit before the queue is ever fetched');
  }));

test('apply: a workspace scheduled for deletion exits 2 with the scheduled-deletion message', () =>
  withTempDir(async (dir) => {
    await writeSingleProjectRepo(dir);
    meResponse = {
      tenantName: 'Acme Corp',
      workspacePausedAt: null,
      workspaceDeletionScheduledFor: '2026-10-01T00:00:00Z',
    };
    touchedQueueOrWrite = false;

    await assert.rejects(
      execAsync(`node ${cliPath} apply`, { cwd: dir, env: { ...process.env, PINSAY_SERVER: serverUrl } }),
      (err: any) => {
        assert.strictEqual(err.code, 2);
        assert.match(
          err.stderr,
          /Workspace "Acme Corp" is scheduled for deletion on 2026-10-01 — apply is disabled\./,
        );
        return true;
      },
    );
    assert.strictEqual(touchedQueueOrWrite, false);
  }));

test('apply --plan: same check, same exit 2, before any git/AI work', () =>
  withTempDir(async (dir) => {
    await writeSingleProjectRepo(dir);
    meResponse = { tenantName: 'Acme Corp', workspacePausedAt: '2026-09-20T12:00:00Z', workspaceDeletionScheduledFor: null };
    touchedQueueOrWrite = false;

    await assert.rejects(
      execAsync(`node ${cliPath} apply --plan`, { cwd: dir, env: { ...process.env, PINSAY_SERVER: serverUrl } }),
      (err: any) => {
        assert.strictEqual(err.code, 2);
        assert.match(err.stderr, /is paused — apply is disabled until a workspace admin resumes it\./);
        return true;
      },
    );
    assert.strictEqual(touchedQueueOrWrite, false);
  }));

test('apply --mark: same check, same exit 2, before marking anything', () =>
  withTempDir(async (dir) => {
    await writeSingleProjectRepo(dir);
    meResponse = { tenantName: 'Acme Corp', workspacePausedAt: '2026-09-20T12:00:00Z', workspaceDeletionScheduledFor: null };
    touchedQueueOrWrite = false;

    await assert.rejects(
      execAsync(`node ${cliPath} apply --mark 5 --reply "done" --models "m=implementer"`, { cwd: dir, env: { ...process.env, PINSAY_SERVER: serverUrl } }),
      (err: any) => {
        assert.strictEqual(err.code, 2);
        assert.match(err.stderr, /is paused — apply is disabled until a workspace admin resumes it\./);
        return true;
      },
    );
    assert.strictEqual(touchedQueueOrWrite, false, 'must never PATCH the comment');
  }));

test('apply: an active (not frozen) workspace is unaffected — reaches the queue as before', () =>
  withTempDir(async (dir) => {
    await writeSingleProjectRepo(dir);
    meResponse = { tenantName: 'Acme Corp', workspacePausedAt: null, workspaceDeletionScheduledFor: null };
    touchedQueueOrWrite = false;

    // No git repo in `dir`, so runApply itself will fail past the frozen-check (fine — this test
    // only asserts the frozen-check let it THROUGH, not that the whole apply run succeeds).
    await execAsync(`node ${cliPath} apply --plan`, { cwd: dir, env: { ...process.env, PINSAY_SERVER: serverUrl } }).catch(() => {});
    assert.strictEqual(touchedQueueOrWrite, true, 'an active workspace must reach the queue fetch');
  }));

test('apply --json: a mid-run freeze (queue 423s after /me said "not frozen") still exits 2, never the generic 1', () =>
  withTempDir(async (dir) => {
    await writeSingleProjectRepo(dir);
    meResponse = { tenantName: 'Acme Corp', workspacePausedAt: null, workspaceDeletionScheduledFor: null };
    touchedQueueOrWrite = false;
    queueFrozen = true;

    try {
      await assert.rejects(
        execAsync(`node ${cliPath} apply --json`, { cwd: dir, env: { ...process.env, PINSAY_SERVER: serverUrl } }),
        (err: any) => {
          assert.strictEqual(err.code, 2, `expected exit 2, got ${err.code}: ${err.stderr}`);
          assert.deepStrictEqual(JSON.parse(err.stdout.trim().split('\n').pop()), {
            ok: false,
            error: { code: 2, message: 'This workspace is paused. Ask its admin to resume it in the dashboard.' },
          });
          return true;
        },
      );
      assert.strictEqual(touchedQueueOrWrite, true, 'the queue fetch DID run — the race happened after /me');
    } finally {
      queueFrozen = false;
    }
  }));

test('pinsay status --deployed: a 423 from the server warns and exits 0 (never fails a customer CI)', () =>
  withTempDir(async (dir) => {
    spawnSync('git', ['init'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'CI'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: dir });
    await fs.writeFile(path.join(dir, 'README.md'), '# test\n');
    spawnSync('git', ['add', 'README.md'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });

    // A dedicated stub for this test (its own port): the comments GET 423s, mirroring a
    // paused/scheduled-for-deletion workspace during `pinsay status --deployed` in CI.
    const deployedServer = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url || '';
      if (req.method === 'POST' && url === '/api/auth/login-with-key') {
        res.end(JSON.stringify({ isSuccess: true, data: { status: 'ok', token: 'jwt-for-test' } }));
        return;
      }
      if (url.startsWith('/api/projects/my-app/comments')) {
        res.writeHead(423, { 'x-workspace-paused': 'true' });
        res.end(JSON.stringify({ isSuccess: false, message: 'This workspace is paused.' }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ isSuccess: false, message: 'Not found' }));
    });
    const deployedUrl = await new Promise<string>((resolve) => {
      deployedServer.listen(0, () => {
        const addr = deployedServer.address() as import('net').AddressInfo;
        resolve(`http://localhost:${addr.port}`);
      });
    });

    try {
      await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
      await fs.writeFile(
        path.join(dir, '.pinsay/config.json'),
        JSON.stringify({ server: deployedUrl, project: 'my-app' }),
        'utf8',
      );
      await fs.writeFile(path.join(dir, '.pinsay/credentials.env'), 'PINSAY_API_KEY=ptr_good\n', 'utf8');

      const { stdout, stderr } = await execAsync(`node ${cliPath} status --deployed`, { cwd: dir, env: { ...process.env, PINSAY_SERVER: deployedUrl } });
      // DB-18 code review (NIT): prints the server's OWN message (distinguishes "paused" from
      // "scheduled for deletion") rather than a hard-coded "paused" string.
      assert.match(stderr, /PinSay: This workspace is paused\. — build not reported\./);
      assert.match(stdout, /0 comments marked deployed/);
    } finally {
      await new Promise<void>((resolve) => deployedServer.close(() => resolve()));
    }
  }));
