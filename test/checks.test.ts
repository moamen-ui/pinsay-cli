import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { runInitChecks } from '../src/checks.js';

async function scratch(config?: Record<string, unknown>, apiKey?: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-checks-'));
  if (config) {
    await fs.mkdir(join(dir, '.pinsay'), { recursive: true });
    await fs.writeFile(join(dir, '.pinsay/config.json'), JSON.stringify(config), 'utf8');
  }
  if (apiKey) {
    await fs.mkdir(join(dir, '.pinsay'), { recursive: true });
    await fs.writeFile(join(dir, '.pinsay/credentials.env'), `PINSAY_API_KEY=${apiKey}\n`, 'utf8');
  }
  return dir;
}

/** Same stub shape as doctor.test.ts: "METHOD /path" -> [status, body]; anything unlisted 404s. */
async function stubServer(routes: Record<string, [number, unknown]>): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const key = `${req.method} ${req.url?.split('?')[0]}`;
    const hit = routes[key];
    if (!hit) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: false, message: 'not found' }));
      return;
    }
    const [status, body] = hit;
    const isScript = key.endsWith('/widget.js');
    res.writeHead(status, { 'content-type': isScript ? 'application/javascript' : 'application/json' });
    res.end(isScript ? String(body) : JSON.stringify({ isSuccess: status < 400, data: body }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('extension delivery: widget check is ok even with nothing injected, and no store URL warns', async () => {
  const stub = await stubServer({
    'GET /api/branding': [200, { productName: 'PinSay', extension: { storeUrl: '', zipUrl: '' } }],
  });
  // No index.html, no marker, no env file at all — an embed install would report "Widget not found".
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local', delivery: 'extension' });

  const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
  await stub.close();

  const widget = checks.find((c) => c.id === 'widget');
  assert.equal(widget?.status, 'ok');
  assert.match(widget?.message ?? '', /[Ee]xtension/);

  const extension = checks.find((c) => c.id === 'extension');
  assert.equal(extension?.status, 'warn');
  assert.match(extension?.hint ?? '', /super admin/i);
});

test('extension delivery: a configured store URL means no extension warning', async () => {
  const stub = await stubServer({
    'GET /api/branding': [200, { productName: 'PinSay', extension: { storeUrl: 'https://chromewebstore.google.com/detail/x', zipUrl: '' } }],
  });
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local', delivery: 'extension' });

  const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
  await stub.close();

  assert.equal(checks.find((c) => c.id === 'widget')?.status, 'ok');
  assert.equal(checks.find((c) => c.id === 'extension'), undefined, 'must not warn once the store URL is set');
});

test('embed delivery (the default): the extension check never runs at all', async () => {
  const stub = await stubServer({
    'GET /api/branding': [200, { productName: 'PinSay', extension: { storeUrl: '', zipUrl: '' } }],
  });
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local' });
  await fs.writeFile(join(dir, 'index.html'), '<html><!-- pinsay-feedback:start --></html>', 'utf8');

  const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
  await stub.close();

  assert.equal(checks.find((c) => c.id === 'widget')?.status, 'ok');
  assert.equal(checks.find((c) => c.id === 'extension'), undefined);
});
