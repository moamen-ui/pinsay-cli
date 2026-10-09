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

async function withProject(
  opts: { project?: string; key?: string; configProjects?: Record<string, { path: string }> },
  fn: (dir: string, configDir: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-project-not-found-test-'));
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

test('status: a project outside the key\'s workspace exits 3 and names the workspace', async () => {
  await withProject({ project: 'other', key: 'pnsy_test' }, async (dir, configDir) => {
    await withStub((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url || '';

      if (req.method === 'POST' && url === '/api/auth/login-with-key') {
        res.end(JSON.stringify({ isSuccess: true, data: { status: 'ok', token: 'jwt' } }));
        return;
      }

      if (req.method === 'GET' && url === '/api/auth/me') {
        res.end(
          JSON.stringify({
            isSuccess: true,
            data: { displayName: 'Test', email: 't@x', tenantName: 'PinSay' },
          }),
        );
        return;
      }

      if (req.method === 'GET' && url === '/api/admin/projects') {
        res.end(JSON.stringify({ isSuccess: true, data: [] }));
        return;
      }

      if (req.method === 'GET' && url.startsWith('/api/admin/projects/other/')) {
        res.writeHead(404);
        res.end(JSON.stringify({ isSuccess: false, message: 'not found' }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ isSuccess: false, message: 'not found' }));
    }, async (url) => {
      const r = await run(['status'], dir, { PINSAY_SERVER: url, PINSAY_CONFIG_DIR: configDir });
      assert.strictEqual(r.code, 3);
      assert.ok(r.stderr.includes('Project "other" not found in workspace PinSay.'), r.stderr);
      assert.ok(!r.stderr.includes('Something went wrong'), r.stderr);
    });
  });
});
