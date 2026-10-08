import { test } from 'node:test';
import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { rmTempDir } from './rm-temp.js';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');

function run(args: string[], cwd: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function withProject(
  opts: { project?: string; key?: string; configProjects?: Record<string, { path: string }> },
  fn: (dir: string, configDir: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-overview-test-'));
  const configDir = `${dir}-global`;
  try {
    await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
    const cfg: Record<string, any> = {};
    if (opts.configProjects) {
      cfg.projects = opts.configProjects;
    } else if (opts.project) {
      cfg.project = opts.project;
    }
    await fs.writeFile(path.join(dir, '.pinsay', 'config.json'), JSON.stringify(cfg));
    if (opts.key) {
      await fs.writeFile(
        path.join(dir, '.pinsay', 'credentials.env'),
        `PINSAY_API_KEY=${opts.key}\n`,
      );
    }
    await fn(dir, configDir);
  } finally {
    rmTempDir(dir);
    rmTempDir(configDir);
  }
}

async function withStub(handler: http.RequestListener, fn: (url: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('configured repo + repo key + stub queue returning 3 items: status overview and status PATCH', async () => {
  let patchCalled = false;
  let patchedStatus = -1;

  const stubHandler: http.RequestListener = (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url || '';

    if (req.method === 'POST' && url === '/api/auth/login-with-key') {
      res.end(JSON.stringify({ isSuccess: true, data: { status: 'ok', token: 'jwt-token-123' } }));
      return;
    }

    if (req.method === 'GET' && url === '/api/auth/me') {
      res.end(
        JSON.stringify({
          isSuccess: true,
          data: { displayName: 'Jane Doe', email: 'jane@example.com' },
        }),
      );
      return;
    }

    if (req.method === 'GET' && url === '/api/admin/projects') {
      res.end(
        JSON.stringify({
          isSuccess: true,
          data: [{ key: 'my-app', name: 'My App' }],
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.startsWith('/api/admin/projects/my-app/apply-queue')) {
      res.end(
        JSON.stringify({
          isSuccess: true,
          data: {
            items: [
              { id: 1, status: 2, body: 'C1' },
              { id: 2, status: 2, body: 'C2' },
              { id: 3, status: 2, body: 'C3' },
            ],
            pages: {},
            pageContexts: {},
          },
        }),
      );
      return;
    }

    if (req.method === 'PATCH' && url === '/api/comments/12') {
      patchCalled = true;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          patchedStatus = parsed.status;
        } catch {}
        res.end(JSON.stringify({ isSuccess: true, data: { id: 12, status: 2 } }));
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ message: 'not found' }));
  };

  await withProject({ project: 'my-app', key: 'ptr_repo_key' }, async (dir, configDir) => {
    await withStub(stubHandler, async (serverUrl) => {
      const env = { PINSAY_SERVER: serverUrl, PINSAY_CONFIG_DIR: configDir };

      // 1. Human stdout status
      const human = await run(['status'], dir, env);
      assert.strictEqual(human.code, 0, human.stderr);
      assert.ok(human.stdout.includes('Signed in'), human.stdout);
      assert.ok(human.stdout.includes('Jane Doe (jane@example.com)'), human.stdout);
      assert.ok(human.stdout.includes('key from this repo'), human.stdout);
      assert.ok(human.stdout.includes('Project     My App (my-app)'), human.stdout);
      assert.ok(human.stdout.includes('3 comments to apply'), human.stdout);
      assert.ok(human.stdout.includes('npx pinsay-cli apply'), human.stdout);

      // 2. Machine stdout status --json
      const jsonRes = await run(['status', '--json'], dir, env);
      assert.strictEqual(jsonRes.code, 0, jsonRes.stderr);
      const parsed = JSON.parse(jsonRes.stdout);
      assert.strictEqual(parsed.ok, true);
      assert.strictEqual(parsed.server, serverUrl);
      assert.deepStrictEqual(parsed.account, {
        displayName: 'Jane Doe',
        email: 'jane@example.com',
      });
      assert.strictEqual(parsed.keySource, 'repo');
      assert.deepStrictEqual(parsed.projects, [
        { key: 'my-app', name: 'My App', pending: 3 },
      ]);

      // 3. status 12 ready still PATCHes /api/comments/12
      const patchRes = await run(['status', '12', 'ready'], dir, env);
      assert.strictEqual(patchRes.code, 0, patchRes.stderr);
      assert.strictEqual(patchCalled, true);
      assert.strictEqual(patchedStatus, 2);
    });
  });
});

test('status overview: no key -> exit 3 with login hint', async () => {
  await withProject({ project: 'my-app' }, async (dir, configDir) => {
    const env: Record<string, string> = {
      PINSAY_SERVER: 'http://127.0.0.1:9',
      PINSAY_CONFIG_DIR: configDir,
    };
    delete env['PINSAY_API_KEY'];
    const r = await run(['status'], dir, env);
    assert.strictEqual(r.code, 3);
    assert.ok(r.stderr.includes('Not signed in'), r.stderr);
    assert.ok(r.stderr.includes('npx pinsay-cli login'), r.stderr);
  });
});

test('status overview: rejected key (stub 401) -> exit 3 no longer works', async () => {
  const stubHandler: http.RequestListener = (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/auth/login-with-key') {
      res.writeHead(401);
      res.end(JSON.stringify({ message: 'invalid key' }));
      return;
    }
    res.writeHead(404);
    res.end();
  };

  await withProject({ project: 'my-app', key: 'ptr_bad_key' }, async (dir, configDir) => {
    await withStub(stubHandler, async (serverUrl) => {
      const env = { PINSAY_SERVER: serverUrl, PINSAY_CONFIG_DIR: configDir };
      const r = await run(['status'], dir, env);
      assert.strictEqual(r.code, 3);
      assert.ok(r.stderr.includes('no longer works'), r.stderr);
      assert.ok(r.stderr.includes('npx pinsay-cli login'), r.stderr);
    });
  });
});

test('open --print with PINSAY_SERVER=http://127.0.0.1:9 and config project my-app prints URL with no network', async () => {
  await withProject({ project: 'my-app' }, async (dir, configDir) => {
    const env = {
      PINSAY_SERVER: 'http://127.0.0.1:9',
      PINSAY_CONFIG_DIR: configDir,
    };
    const r = await run(['open', '--print'], dir, env);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), 'http://127.0.0.1:9/comments?project=my-app');
  });
});
