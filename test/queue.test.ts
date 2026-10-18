import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { fetchQueue, resetFallbackWarning } from '../src/apply/queue.js';
import { buildApplyPrompt } from '../src/apply/prompt.js';
import { ProjectNotFoundError } from '../src/errors.js';
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

    // Capture console.error
    const logs: string[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => logs.push(args.join(' '));

    try {
      const items = await fetchQueue(ctx);
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 7);
      assert.equal(items[0].body, 'Fix navbar margin');
      assert.equal(items[0].page?.route, '/home');

      // Second call in same run
      await fetchQueue(ctx);
    } finally {
      console.error = origError;
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

test('fetchQueue: a 404 on the apply queue is ProjectNotFoundError with the workspace name', async () => {
  const stub = await stubServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/admin/projects/demo/apply-queue')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: false, message: 'not found' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false, message: 'not found' }));
  });

  try {
    await assert.rejects(
      fetchQueue({ server: stub.url, project: 'demo', token: 't', cwd: '.', workspaceName: 'PinSay' }),
      (err: any) => {
        assert.ok(err instanceof ProjectNotFoundError);
        assert.equal(err.project, 'demo');
        assert.equal(err.workspace, 'PinSay');
        assert.equal(err.code, 'not_found');
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test('fetchQueue: a 403 then a 404 on the summary fallback is ProjectNotFoundError', async () => {
  resetFallbackWarning();
  const stub = await stubServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/admin/projects/demo/apply-queue')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: false, message: 'Forbidden' }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/projects/demo/comments')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: false, message: 'not found' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false, message: 'not found' }));
  });

  try {
    await assert.rejects(
      fetchQueue({ server: stub.url, project: 'demo', token: 't', cwd: '.', workspaceName: 'PinSay' }),
      (err: any) => {
        assert.ok(err instanceof ProjectNotFoundError);
        assert.equal(err.project, 'demo');
        assert.equal(err.workspace, 'PinSay');
        assert.equal(err.code, 'not_found');
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

async function memberRulesFallback(rulesHandler: (res: any) => void) {
  resetFallbackWarning();
  const stub = await stubServer((req, res) => {
    if (req.url?.startsWith('/api/admin/projects/dev-project/apply-queue')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: false, message: 'Forbidden' }));
      return;
    }
    if (req.url?.startsWith('/api/projects/dev-project/comments?view=summary')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: { items: [{ id: 7, status: 2, environment: 1, body: 'x', createdAt: '' }] } }));
      return;
    }
    if (req.url?.startsWith('/api/ai-rules/project/dev-project')) return rulesHandler(res);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false }));
  });
  const origError = console.error;
  console.error = () => {};
  try {
    return await fetchQueue({ server: stub.url, project: 'dev-project', token: 't', cwd: '/tmp' });
  } finally {
    console.error = origError;
    await stub.close();
  }
}

test('fetchQueue 403 fallback carries the member rules (admin + role)', async () => {
  const items = await memberRulesFallback((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        isSuccess: true,
        data: {
          adminRules: [{ title: 'W', prompt: 'pw', isActive: true, projectId: null }],
          myRules: [],
          roleRules: [{ title: 'R', prompt: 'pr', isActive: true, roleId: 1, roleName: 'Backend' }],
          roleName: 'Backend',
        },
      }),
    );
  });
  assert.deepEqual(items[0].aiRules.map((r) => r.scope), ['Workspace', 'Role']);
  assert.equal(items[0].aiRules[1].roleName, 'Backend');
});

test('fetchQueue 403 fallback: a failing rules endpoint gives aiRules: []', async () => {
  const items = await memberRulesFallback((res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false }));
  });
  assert.deepEqual(items[0].aiRules, []);
});

test('fetchQueue admin path keeps roleName on a Role rule', async () => {
  const stub = await stubServer((req, res) => {
    if (req.url?.startsWith('/api/admin/projects/dev-project/apply-queue')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          isSuccess: true,
          data: {
            items: [
              {
                id: 1,
                number: 1,
                status: 2,
                environment: 1,
                body: 'x',
                aiRules: [{ title: 'API only', prompt: 'p', scope: 'Role', priority: 3, isPersonal: false, roleName: 'Backend' }],
              },
            ],
          },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false }));
  });
  try {
    const items = await fetchQueue({ server: stub.url, project: 'dev-project', token: 't', cwd: '/tmp' });
    assert.equal(items[0].aiRules[0].roleName, 'Backend');
    const out = buildApplyPrompt(
      items,
      { productName: 'PinSay', projectName: 'x', projectKey: 'dev-project', commitStyle: 'Single', stack: {} } as any,
    );
    assert.ok(out.includes('[Role: Backend]'));
  } finally {
    await stub.close();
  }
});

test('apply queue maps media and reply media', async () => {
  const stub = await stubServer((req, res) => {
    if (req.url?.startsWith('/api/admin/projects/dev-project/apply-queue')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          isSuccess: true,
          data: {
            items: [
              {
                id: 2,
                number: 2,
                status: 2,
                environment: 1,
                body: 'y',
                textSource: 'editedSpeech',
                media: [
                  {
                    kind: 'audio', ordinal: 1, url: 'https://x/v1.webm', contentType: 'audio/webm',
                    sizeBytes: 12, transcript: 'louder please', available: true,
                  },
                ],
                replies: [
                  {
                    id: 21,
                    body: 'r',
                    media: [
                      { kind: 'annotation', ordinal: 1, url: 'https://x/a.png', contentType: 'image/png', sizeBytes: 5, available: true },
                    ],
                  },
                ],
              },
              {
                id: 3,
                number: 3,
                status: 2,
                environment: 1,
                body: 'z',
              },
            ],
          },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false }));
  });
  try {
    const items = await fetchQueue({ server: stub.url, project: 'dev-project', token: 't', cwd: '/tmp' });
    assert.equal(items[0].media?.[0]?.transcript, 'louder please');
    assert.equal(items[0].replies[0].media?.[0]?.kind, 'annotation');
    assert.equal(items[0].textSource, 'editedSpeech');
    assert.deepEqual(items[1].media, []);
  } finally {
    await stub.close();
  }
});
