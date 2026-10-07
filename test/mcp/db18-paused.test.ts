// DB-18: workspace paused / scheduled for deletion — MCP behaviour.
//
// Contract (docs/db/execution/DB-18-workspace-self-service-pause-and-delete.md §3.6, task 18):
// a 423 from the server must come back as a tool error carrying the server's message, and MUST
// NOT call process.exit — this MCP server may be serving other tools' calls in the same process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../../dist/cli.js');

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

test('mcp: a 423 from the server comes back as a tool error carrying the server message, never process.exit', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pinsay-mcp-paused-test-'));
  mkdirSync(join(tmpDir, '.pinsay'), { recursive: true });

  const stub = await stubServer((req, res) => {
    if (req.url === '/api/comments/42') {
      res.writeHead(423, { 'content-type': 'application/json', 'x-workspace-paused': 'true' });
      res.end(JSON.stringify({ isSuccess: false, message: 'This workspace is paused. It is read-only until an admin resumes it.' }));
      return;
    }
    if (req.url === '/api/resolve-source' || req.url?.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: {} }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ isSuccess: false, message: 'Not found' }));
  });

  writeFileSync(
    join(tmpDir, '.pinsay/config.json'),
    JSON.stringify({
      server: stub.url,
      project: 'test-project',
      environment: 'local',
      cliVersion: '0.1.0',
    }),
    'utf8',
  );
  writeFileSync(join(tmpDir, '.pinsay/credentials.env'), 'PINSAY_API_KEY=ptr_test_secret\n', 'utf8');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [cliPath, 'mcp'],
    cwd: tmpDir,
    env: {
      ...process.env,
      PINSAY_SERVER: stub.url,
      PINSAY_PROJECT: 'test-project',
      PINSAY_API_KEY: 'ptr_test_secret',
    },
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);

    const callResult = (await client.callTool({
      name: 'pinsay_get_comment',
      arguments: { id: 42 },
    })) as any;

    assert.equal(callResult.isError, true);
    const body = JSON.parse(callResult.content[0].text);
    assert.equal(body.code, 'paused');
    assert.equal(body.message, 'This workspace is paused. It is read-only until an admin resumes it.');

    // The server must still be alive and answering — proof no process.exit happened on the 423.
    const followUp = (await client.callTool({
      name: 'pinsay_resolve_source',
      arguments: { hash: 'deadbeef' },
    })) as any;
    assert.equal(Boolean(followUp.isError), false);
  } finally {
    await client.close();
    await stub.close();
    // Windows: a just-closed child process may still hold its cwd (EBUSY) — retry.
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
