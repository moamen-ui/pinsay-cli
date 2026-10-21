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
  opts: { project?: string; key?: string },
  fn: (dir: string, configDir: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-get-media-test-'));
  const configDir = `${dir}-global`;
  try {
    await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
    const cfg: Record<string, any> = {};
    if (opts.project) {
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

test('get saves media and names their paths (human and --json)', async () => {
  await withProject({ project: 'web', key: 'pnsy_test' }, async (dir, configDir) => {
    let stubUrl = '';
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

      if (req.method === 'GET' && url === '/api/projects/web/comments/by-number/12') {
        res.end(
          JSON.stringify({
            isSuccess: true,
            data: {
              id: 5,
              number: 12,
              status: 2,
              environment: 1,
              body: 'hello',
              replies: [],
              element: {},
              media: [
                {
                  kind: 'audio',
                  ordinal: 1,
                  url: `${stubUrl}/files/v1.webm`,
                  contentType: 'audio/webm',
                  sizeBytes: 3,
                  durationMs: 4000,
                  transcript: 'hello',
                  transcriptSource: 'browser',
                  available: true,
                },
                {
                  kind: 'image',
                  ordinal: 2,
                  url: `${stubUrl}/files/i1.png`,
                  contentType: 'image/png',
                  sizeBytes: 4,
                  available: true,
                },
              ],
            },
          }),
        );
        return;
      }

      if (req.method === 'GET' && url === '/files/v1.webm') {
        res.setHeader('Content-Type', 'audio/webm');
        res.end(Buffer.from('abc'));
        return;
      }

      if (req.method === 'GET' && url === '/files/i1.png') {
        res.setHeader('Content-Type', 'image/png');
        res.end(Buffer.from('img1'));
        return;
      }

      res.end(JSON.stringify({ isSuccess: true, data: {} }));
    }, async (url) => {
      stubUrl = url;

      const r = await run(['get', '12'], dir, { PINSAY_SERVER: url, PINSAY_CONFIG_DIR: configDir });
      assert.strictEqual(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes('Files:'), r.stdout);
      const voicePath = await fs.realpath(path.join(dir, '.pinsay', 'media', 'web', '12', 'voice-01.webm'));
      const voiceLine = r.stdout.split('\n').find((l) => l.startsWith('- Voice 1 of 1 (4 s): '));
      assert.ok(voiceLine, r.stdout);
      const linePath = await fs.realpath(voiceLine.slice('- Voice 1 of 1 (4 s): '.length).split(' — ')[0]);
      assert.strictEqual(linePath, voicePath);
      assert.ok(voiceLine.includes('browser transcript'), voiceLine);
      assert.ok(r.stdout.includes('[Voice 1] hello'), r.stdout);
      const stat = await fs.stat(voicePath);
      assert.strictEqual(stat.size, 3);

      const j = await run(['get', '12', '--json'], dir, { PINSAY_SERVER: url, PINSAY_CONFIG_DIR: configDir });
      assert.strictEqual(j.code, 0, j.stderr);
      const parsed = JSON.parse(j.stdout);
      assert.ok(parsed.media[0].path.endsWith(path.join('.pinsay', 'media', 'web', '12', 'voice-01.webm')), parsed.media[0].path);
      const img = parsed.media.find((m: any) => m.kind === 'image');
      assert.ok(img, j.stdout);
      assert.strictEqual(img.ordinal, 2);
      assert.ok(img.path.endsWith(path.join('.pinsay', 'media', 'web', '12', 'image-02.png')), img.path);
    });
  });
});
