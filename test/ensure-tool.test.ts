import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { ensureToolRegistered } from '../src/apply/run.js';

async function stubServer(
  handler: (req: any, res: any) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const design = {
  version: 1,
  libraries: [],
  tokens: { cssVars: { source: 'src/index.css', names: ['--brand'] } },
};

async function setup(aiTools: string[], url: string): Promise<{ dir: string; stackPath: string }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-ensure-tool-'));
  await fs.mkdir(join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(join(dir, '.pinsay', 'config.json'), JSON.stringify({ server: url, project: 'my-app' }), 'utf8');
  const stackPath = join(dir, '.pinsay', 'stack.json');
  await fs.writeFile(stackPath, JSON.stringify({ frontend: ['react'], backend: null, aiTools, design }), 'utf8');
  return { dir, stackPath };
}

test('ensureToolRegistered keeps the local design block when the server answers', async () => {
  const requests: { method: string; url: string; body: string }[] = [];
  const stub = await stubServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: { frontend: ['react'], backend: null, aiTools: ['other', 'claude-code'] } }));
    });
  });
  try {
    const { dir, stackPath } = await setup(['other'], stub.url);
    await ensureToolRegistered({ cwd: dir, server: stub.url, project: 'my-app', token: 't' } as any, 'claude-code');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/projects/my-app/stack');
    assert.deepEqual(JSON.parse(requests[0].body), { aiTool: 'claude-code' });
    const after = JSON.parse(await fs.readFile(stackPath, 'utf8'));
    assert.deepEqual(after.aiTools, ['claude-code', 'other']);
    assert.deepEqual(after.design.tokens.cssVars.names, ['--brand']);
  } finally {
    await stub.close();
  }
});

test('ensureToolRegistered does nothing when the tool is already listed', async () => {
  let count = 0;
  const stub = await stubServer((_req, res) => {
    count++;
    res.writeHead(500);
    res.end();
  });
  try {
    const { dir, stackPath } = await setup(['claude-code'], stub.url);
    const before = await fs.readFile(stackPath, 'utf8');
    await ensureToolRegistered({ cwd: dir, server: stub.url, project: 'my-app', token: 't' } as any, 'claude-code');
    assert.equal(count, 0);
    assert.equal(await fs.readFile(stackPath, 'utf8'), before);
  } finally {
    await stub.close();
  }
});
