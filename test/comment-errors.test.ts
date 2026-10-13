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
      env: { ...process.env, PINSAY_API_KEY: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function withProject(fn: (dir: string, configDir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-comment-errors-test-'));
  const configDir = `${dir}-global`;
  try {
    await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
    await fs.writeFile(path.join(dir, '.pinsay', 'config.json'), JSON.stringify({ project: 'my-app' }));
    await fs.writeFile(path.join(dir, '.pinsay', 'credentials.env'), 'PINSAY_API_KEY=ptr_repo_key\n');
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

// A repo configured for project `my-app`; the stub answers
// GET /api/projects/my-app/comments/by-number/999 with 404 (and anything else too).
const stubHandler: http.RequestListener = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = req.url || '';

  if (req.method === 'POST' && url === '/api/auth/login-with-key') {
    res.end(JSON.stringify({ isSuccess: true, data: { status: 'ok', token: 'jwt-token-123' } }));
    return;
  }

  if (req.method === 'GET' && url === '/api/projects/my-app/comments/by-number/999') {
    res.writeHead(404);
    res.end(JSON.stringify({ message: 'not found' }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ message: 'not found' }));
};

test('get 999: unknown number -> exit 4, stderr has No comment #999 in project my-app.', async () => {
  await withProject(async (dir, configDir) => {
    await withStub(stubHandler, async (serverUrl) => {
      const env = { PINSAY_SERVER: serverUrl, PINSAY_CONFIG_DIR: configDir };
      const r = await run(['get', '999'], dir, env);
      assert.strictEqual(r.code, 4, r.stderr);
      assert.ok(r.stderr.includes('No comment #999 in project my-app.'), r.stderr);
    });
  });
});

test('get abc: not a number -> exit 2, stderr has the invalid-number message', async () => {
  await withProject(async (dir, configDir) => {
    await withStub(stubHandler, async (serverUrl) => {
      const env = { PINSAY_SERVER: serverUrl, PINSAY_CONFIG_DIR: configDir };
      const r = await run(['get', 'abc'], dir, env);
      assert.strictEqual(r.code, 2, r.stderr);
      assert.ok(r.stderr.includes('Invalid comment number: abc. Expected a number like 12 or #12.'), r.stderr);
    });
  });
});

test('get --id 5: removed flag -> exit 2, stderr has --id was removed', async () => {
  await withProject(async (dir, configDir) => {
    await withStub(stubHandler, async (serverUrl) => {
      const env = { PINSAY_SERVER: serverUrl, PINSAY_CONFIG_DIR: configDir };
      const r = await run(['get', '--id', '5'], dir, env);
      assert.strictEqual(r.code, 2, r.stderr);
      assert.ok(r.stderr.includes('--id was removed'), r.stderr);
    });
  });
});

test('get --number 999: unknown number -> exit 4, stderr has No comment #999 in project my-app.', async () => {
  await withProject(async (dir, configDir) => {
    await withStub(stubHandler, async (serverUrl) => {
      const env = { PINSAY_SERVER: serverUrl, PINSAY_CONFIG_DIR: configDir };
      const r = await run(['get', '--number', '999'], dir, env);
      assert.strictEqual(r.code, 4, r.stderr);
      assert.ok(r.stderr.includes('No comment #999 in project my-app.'), r.stderr);
    });
  });
});

test('get --id=5: removed flag -> exit 2, stderr has --id was removed', async () => {
  await withProject(async (dir, configDir) => {
    await withStub(stubHandler, async (serverUrl) => {
      const env = { PINSAY_SERVER: serverUrl, PINSAY_CONFIG_DIR: configDir };
      const r = await run(['get', '--id=5'], dir, env);
      assert.strictEqual(r.code, 2, r.stderr);
      assert.ok(r.stderr.includes('--id was removed'), r.stderr);
    });
  });
});

test('reply 999 "hello there": unknown number -> exit 4', async () => {
  await withProject(async (dir, configDir) => {
    await withStub(stubHandler, async (serverUrl) => {
      const env = { PINSAY_SERVER: serverUrl, PINSAY_CONFIG_DIR: configDir };
      const r = await run(['reply', '999', 'hello there'], dir, env);
      assert.strictEqual(r.code, 4, r.stderr);
    });
  });
});

test('status 999 ready: unknown number -> exit 4', async () => {
  await withProject(async (dir, configDir) => {
    await withStub(stubHandler, async (serverUrl) => {
      const env = { PINSAY_SERVER: serverUrl, PINSAY_CONFIG_DIR: configDir };
      const r = await run(['status', '999', 'ready'], dir, env);
      assert.strictEqual(r.code, 4, r.stderr);
    });
  });
});
