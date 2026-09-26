import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { markApplied, markFailed } from '../src/apply/mark.js';
import type { ApplyClientContext } from '../src/apply/types.js';

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

test('markApplied in Separate style commits and patches single comment with commitUrl', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-mark-test-'));
  spawnSync('git', ['init'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Developer'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/myorg/myrepo.git'], { cwd: dir });

  // Initial commit so HEAD exists
  await fs.writeFile(join(dir, 'README.md'), '# test\n');
  spawnSync('git', ['add', 'README.md'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });

  // Stage a change for comment #10
  await fs.writeFile(join(dir, 'app.js'), 'console.log("fix");\n');
  spawnSync('git', ['add', 'app.js'], { cwd: dir });

  let patchedBody: any = null;
  const stub = await stubServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/branding') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: { productName: 'PinSay' } }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/projects/my-app/capture-config')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: { commitStyle: 2 } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/comments/10') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: { id: 10, body: 'Fix console log' } }));
      return;
    }
    if (req.method === 'PATCH' && req.url === '/api/comments/10') {
      let data = '';
      req.on('data', (chunk: any) => (data += chunk));
      req.on('end', () => {
        patchedBody = JSON.parse(data);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ isSuccess: true, data: {} }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false }));
  });

  try {
    const ctx: ApplyClientContext = {
      server: stub.url,
      project: 'my-app',
      token: 'test-token',
      cwd: dir,
    };

    const result = await markApplied(
      {
        id: 10,
        reply: 'Fixed the console log statement',
      },
      ctx,
    );

    assert.equal(result.committed, true);
    assert.ok(result.sha, 'Result must contain commit sha');
    assert.equal(
      result.commitUrl,
      `https://github.com/myorg/myrepo/commit/${result.sha}`,
    );

    // Verify git commit message
    const logRes = spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' });
    assert.equal(logRes.stdout.trim(), 'Apply PinSay comment #10 — Fix console log');

    // Verify PATCH body sent to server
    assert.ok(patchedBody, 'PATCH request must have been made');
    assert.equal(patchedBody.status, 3);
    assert.equal(patchedBody.reply, 'Fixed the console log statement');
    assert.equal(patchedBody.appliedByLabel, 'dev@example.com');
    assert.equal(patchedBody.commitUrl, result.commitUrl);
    // No --tool/--model passed: structured attribution fields are simply absent.
    assert.equal(patchedBody.aiTool, undefined);
    assert.equal(patchedBody.aiModel, undefined);
  } finally {
    await stub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('markApplied sends structured aiTool/aiModel in the PATCH body when provided', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-mark-test-'));
  spawnSync('git', ['init'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Developer'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/myorg/myrepo.git'], { cwd: dir });

  await fs.writeFile(join(dir, 'README.md'), '# test\n');
  spawnSync('git', ['add', 'README.md'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });

  await fs.writeFile(join(dir, 'app.js'), 'console.log("fix");\n');
  spawnSync('git', ['add', 'app.js'], { cwd: dir });

  let patchedBody: any = null;
  const stub = await stubServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/branding') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: { productName: 'PinSay' } }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/projects/my-app/capture-config')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: { commitStyle: 2 } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/comments/11') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: { id: 11, body: 'Fix console log' } }));
      return;
    }
    if (req.method === 'PATCH' && req.url === '/api/comments/11') {
      let data = '';
      req.on('data', (chunk: any) => (data += chunk));
      req.on('end', () => {
        patchedBody = JSON.parse(data);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ isSuccess: true, data: {} }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false }));
  });

  try {
    const ctx: ApplyClientContext = {
      server: stub.url,
      project: 'my-app',
      token: 'test-token',
      cwd: dir,
    };

    await markApplied(
      {
        id: 11,
        reply: 'Fixed the console log statement',
        tool: 'claude-code',
        model: 'claude-sonnet-5',
      },
      ctx,
    );

    assert.ok(patchedBody, 'PATCH request must have been made');
    assert.equal(patchedBody.aiTool, 'claude-code');
    assert.equal(patchedBody.aiModel, 'claude-sonnet-5');
    // appliedByLabel keeps its own "via <tool>" free-text form — unrelated to the structured fields.
    assert.equal(patchedBody.appliedByLabel, 'dev@example.com via claude-code');
  } finally {
    await stub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('markFailed posts reply with reason and emits event', async () => {
  let replyBody: any = null;
  let eventPayload: any = null;

  const stub = await stubServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/comments/25/replies') {
      let data = '';
      req.on('data', (chunk: any) => (data += chunk));
      req.on('end', () => {
        replyBody = JSON.parse(data);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ isSuccess: true, data: { id: 99 } }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/events') {
      let data = '';
      req.on('data', (chunk: any) => (data += chunk));
      req.on('end', () => {
        eventPayload = JSON.parse(data);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ isSuccess: true }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false }));
  });

  try {
    const ctx: ApplyClientContext = {
      server: stub.url,
      project: 'my-app',
      token: 'test-token',
      cwd: '/tmp',
    };

    await markFailed(25, 'Element cannot be styled via CSS', ctx);

    assert.ok(replyBody, 'Reply request must be sent');
    assert.equal(replyBody.body, 'Could not apply: Element cannot be styled via CSS');
    assert.equal(replyBody.aiTool, undefined);
    assert.equal(replyBody.aiModel, undefined);

    assert.ok(eventPayload, 'Event must be emitted');
    assert.equal(eventPayload.type, 'apply_failed');
    assert.equal(eventPayload.meta.commentId, 25);
  } finally {
    await stub.close();
  }
});

test('markFailed sends structured aiTool/aiModel in the reply body when provided', async () => {
  let replyBody: any = null;

  const stub = await stubServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/comments/26/replies') {
      let data = '';
      req.on('data', (chunk: any) => (data += chunk));
      req.on('end', () => {
        replyBody = JSON.parse(data);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ isSuccess: true, data: { id: 100 } }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/events') {
      let data = '';
      req.on('data', (chunk: any) => (data += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ isSuccess: true }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false }));
  });

  try {
    const ctx: ApplyClientContext = {
      server: stub.url,
      project: 'my-app',
      token: 'test-token',
      cwd: '/tmp',
    };

    await markFailed(26, 'Third-party widget, no repo counterpart', ctx, 'claude-code', 'gpt-5.2');

    assert.ok(replyBody, 'Reply request must be sent');
    assert.equal(replyBody.aiTool, 'claude-code');
    assert.equal(replyBody.aiModel, 'gpt-5.2');
  } finally {
    await stub.close();
  }
});

async function stagedRepo(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-mark-all-test-'));
  spawnSync('git', ['init'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Developer'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: dir });
  await fs.writeFile(join(dir, 'README.md'), '# test\n');
  spawnSync('git', ['add', 'README.md'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });
  await fs.writeFile(join(dir, 'app.js'), 'console.log("fix");\n');
  spawnSync('git', ['add', 'app.js'], { cwd: dir });
  return dir;
}

function queueStub(items: any[], seen: { queueUrls: string[]; patched: number[] }) {
  return (req: any, res: any) => {
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/api/branding')
      return json({ isSuccess: true, data: { productName: 'PinSay' } });
    if (req.method === 'GET' && req.url?.startsWith('/api/projects/my-app/capture-config'))
      return json({ isSuccess: true, data: { commitStyle: 1 } });
    if (req.method === 'GET' && req.url?.startsWith('/api/admin/projects/my-app/apply-queue')) {
      seen.queueUrls.push(req.url);
      return json({ isSuccess: true, data: { items, pages: {}, pageContexts: {} } });
    }
    if (req.method === 'PATCH' && req.url?.startsWith('/api/comments/')) {
      seen.patched.push(Number(req.url.split('/').pop()));
      req.resume();
      return req.on('end', () => json({ isSuccess: true, data: {} }));
    }
    if (req.method === 'POST' && req.url === '/api/events') return json({ isSuccess: true });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false }));
  };
}

test('markApplied all with zero matching comments commits nothing and leaves the staged diff', async () => {
  const dir = await stagedRepo();
  const seen = { queueUrls: [] as string[], patched: [] as number[] };
  const stub = await stubServer(queueStub([], seen));
  try {
    const ctx: ApplyClientContext = { server: stub.url, project: 'my-app', token: 't', cwd: dir };
    const result = await markApplied({ id: 'all', reply: 'Done' }, ctx);

    assert.equal(result.nothingMatched, true);
    assert.equal(result.committed, false);
    assert.deepEqual(result.patchedIds, []);
    assert.deepEqual(seen.patched, []);
    const log = spawnSync('git', ['log', '--pretty=%s'], { cwd: dir, encoding: 'utf8' });
    assert.equal(log.stdout.trim(), 'Initial commit', 'no "Apply 0 pending" commit may be made');
    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' });
    assert.equal(staged.stdout.trim(), 'app.js', 'the staged change must be left in place');
  } finally {
    await stub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('markApplied all uses the --status/--env filter the plan was built with', async () => {
  const dir = await stagedRepo();
  const seen = { queueUrls: [] as string[], patched: [] as number[] };
  const stub = await stubServer(queueStub([{ id: 212 }, { id: 213 }], seen));
  try {
    const ctx: ApplyClientContext = { server: stub.url, project: 'my-app', token: 't', cwd: dir };
    const result = await markApplied(
      { id: 'all', reply: 'Done', filter: { status: 'open', environment: 'production' } },
      ctx,
    );

    assert.equal(result.committed, true);
    assert.equal(result.nothingMatched, undefined);
    assert.deepEqual(seen.patched, [212, 213]);
    assert.match(seen.queueUrls[0], /status=1/);
    assert.match(seen.queueUrls[0], /environment=3/);
    const log = spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' });
    assert.equal(log.stdout.trim(), 'Apply 2 pending PinSay comments');
  } finally {
    await stub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
