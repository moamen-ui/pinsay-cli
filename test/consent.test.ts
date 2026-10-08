import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { shareAllowed, shareFromFlags } from '../src/consent.js';
import { postEvent, postSetupDone } from '../src/events.js';

async function scratch(config?: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-consent-'));
  if (config) {
    await fs.mkdir(join(dir, '.pinsay'), { recursive: true });
    await fs.writeFile(join(dir, '.pinsay/config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

/** A stub server that records every request, replying `{"isSuccess":true,"data":{}}` to all. */
async function stubServer(): Promise<{ url: string; close: () => Promise<void>; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests,
  };
}

test('shareAllowed: no config at all shares (findRepoRoot falls back to cwd)', async () => {
  const dir = await scratch();
  assert.equal(await shareAllowed(dir), true);
});

test('shareAllowed: empty config shares', async () => {
  const dir = await scratch({});
  assert.equal(await shareAllowed(dir), true);
});

test('shareAllowed: shareStack true shares', async () => {
  const dir = await scratch({ shareStack: true });
  assert.equal(await shareAllowed(dir), true);
});

test('shareAllowed: only an explicit shareStack false says no', async () => {
  const dir = await scratch({ shareStack: false });
  assert.equal(await shareAllowed(dir), false);
});

test('shareFromFlags: all four flag combinations', () => {
  assert.deepEqual(shareFromFlags({ 'share-stack': true }), { share: true });
  assert.deepEqual(shareFromFlags({ 'no-share-stack': true }), { share: false });
  assert.deepEqual(shareFromFlags({}), {});
  assert.deepEqual(shareFromFlags({ 'share-stack': true, 'no-share-stack': true }), {
    error: 'Pass only one of --share-stack and --no-share-stack.',
  });
});

test('postEvent sends nothing when the repo said shareStack false', async () => {
  const stub = await stubServer();
  const dir = await scratch({ shareStack: false });
  try {
    await postEvent(stub.url, 'jwt', { type: 'doctor_run', projectKey: 'p' }, dir);
    assert.equal(stub.requests.filter((r) => r.url === '/api/events').length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('postEvent sends one event when the config has no shareStack answer', async () => {
  const stub = await stubServer();
  const dir = await scratch({});
  try {
    await postEvent(stub.url, 'jwt', { type: 'doctor_run', projectKey: 'p' }, dir);
    const events = stub.requests.filter((r) => r.url === '/api/events');
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].body), { type: 'doctor_run', projectKey: 'p' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('postSetupDone sends exactly the bare installed event, whatever the repo answered', async () => {
  const stub = await stubServer();
  try {
    await postSetupDone(stub.url, 'jwt', 'p');
    const events = stub.requests.filter((r) => r.url === '/api/events');
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].body), { type: 'installed', projectKey: 'p' });
  } finally {
    await stub.close();
  }
});
