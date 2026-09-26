import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { loadProjectContext } from '../src/apply/context.js';
import type { ApplyClientContext } from '../src/apply/types.js';

async function stubServer(
  routes: Record<string, [number, unknown]>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const key = `${req.method} ${req.url?.split('?')[0]}`;
    const hit = routes[key];
    if (!hit) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: false, message: 'not found' }));
      return;
    }
    const [status, body] = hit;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: status < 400, data: body }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('loadProjectContext loads branding, stack, project name, and commitStyle', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-context-test-'));
  await fs.mkdir(join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    join(dir, '.pinsay/stack.json'),
    JSON.stringify({ frontend: ['vue', 'tailwind'], backend: ['dotnet'] }),
    'utf8',
  );

  const stub = await stubServer({
    'GET /api/branding': [
      200,
      { productName: 'Custom Brand', urls: { app: 'https://app.example.com' } },
    ],
    'GET /api/projects/my-app/capture-config': [
      200,
      { name: 'My Application', commitStyle: 2 },
    ],
    'GET /api/admin/projects': [
      200,
      [{ key: 'my-app', name: 'My Official App Name' }],
    ],
  });

  try {
    const ctx: ApplyClientContext = {
      server: stub.url,
      project: 'my-app',
      token: 'test-token',
      cwd: dir,
    };

    const result = await loadProjectContext(ctx);
    assert.equal(result.productName, 'Custom Brand');
    assert.equal(result.projectName, 'My Official App Name');
    assert.equal(result.projectKey, 'my-app');
    assert.equal(result.commitStyle, 'Separate');
    assert.deepEqual(result.stack.frontend, ['vue', 'tailwind']);
    assert.deepEqual(result.stack.backend, ['dotnet']);
  } finally {
    await stub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
