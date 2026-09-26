import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { fetchQueue, resetFallbackWarning } from '../src/apply/queue.js';
import type { ApplyClientContext } from '../src/apply/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

test('fetchQueue resolves page and pageContext from admin apply-queue', async () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/apply-queue.json'), 'utf8'));

  const stub = await stubServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/admin/projects/my-project/apply-queue')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: fixture }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false, message: 'not found' }));
  });

  try {
    const ctx: ApplyClientContext = {
      server: stub.url,
      project: 'my-project',
      token: 'admin-token',
      cwd: '/tmp',
    };

    const items = await fetchQueue(ctx);
    assert.equal(items.length, 1);
    const item = items[0];

    assert.equal(item.id, 12);
    assert.equal(item.status, 2);
    assert.equal(item.body, 'Make the CTA button primary');
    assert.equal(item.authorName, 'Jamie');

    // Page resolution from data.pages[element.pageRef]
    assert.ok(item.page, 'item.page must be resolved');
    assert.equal(item.page.route, '/checkout');
    assert.equal(item.page.device, 'mobile');

    // Page context resolution from data.pageContexts[pageContextId]
    assert.ok(item.pageContext, 'item.pageContext must be resolved');
    assert.equal(item.pageContext.id, 5);
    assert.equal(item.pageContext.consoleEntries?.length, 1);
    assert.equal(item.pageContext.networkEntries?.length, 1);

    // Picked actions and AI rules
    assert.equal(item.pickedActions.length, 1);
    assert.equal(item.pickedActions[0].text, 'Make primary');
    assert.equal(item.aiRules.length, 2);
  } finally {
    await stub.close();
  }
});

test('fetchQueue falls back to summary view on 403 and warns once', async () => {
  resetFallbackWarning();
  const summaryFixture = {
    items: [
      {
        id: 7,
        status: 2,
        environment: 1,
        body: 'Fix navbar margin',
        createdAt: '2026-06-24T00:00:00Z',
        route: '/home',
        sourcePath: 'src/Nav.tsx',
        authorName: 'Developer',
      },
    ],
  };

  const stub = await stubServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/admin/projects/dev-project/apply-queue')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: false, message: 'Forbidden' }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/projects/dev-project/comments?view=summary')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: summaryFixture }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false }));
  });

  try {
    const ctx: ApplyClientContext = {
      server: stub.url,
      project: 'dev-project',
      token: 'dev-token',
      cwd: '/tmp',
    };

    // Capture console.log
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));

    try {
      const items = await fetchQueue(ctx);
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 7);
      assert.equal(items[0].body, 'Fix navbar margin');
      assert.equal(items[0].page?.route, '/home');

      // Second call in same run
      await fetchQueue(ctx);
    } finally {
      console.log = origLog;
    }

    // Verify warning was logged exactly once
    const warningLogs = logs.filter((l) =>
      l.includes('Note: predefined-action prompts need an admin key'),
    );
    assert.equal(warningLogs.length, 1, 'Note must be logged exactly once per run');
  } finally {
    await stub.close();
  }
});
