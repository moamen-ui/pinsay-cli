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

test('mcp stdio: spawn node dist/cli.js mcp, initialize, tools/list, tools/call', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pinsay-mcp-stdio-test-'));
  mkdirSync(join(tmpDir, '.pinsay'), { recursive: true });

  const stub = await stubServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: true }));
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

  writeFileSync(
    join(tmpDir, '.pinsay/credentials.env'),
    'PINSAY_API_KEY=ptr_test_secret\n',
    'utf8',
  );

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

  const client = new Client(
    {
      name: 'test-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    },
  );

  try {
    await client.connect(transport);

    // 1. tools/list: assert all 10 tool names
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      'pinsay_commit_and_mark',
      'pinsay_doctor',
      'pinsay_get_comment',
      'pinsay_get_queue',
      'pinsay_list_comments',
      'pinsay_list_projects',
      'pinsay_mark_applied',
      'pinsay_reply',
      'pinsay_resolve_source',
      'pinsay_set_status',
    ]);

    // 2. resources/list and read pinsay://project
    const resources = await client.listResources();
    assert.ok(resources.resources.some((r) => r.uri === 'pinsay://project'));

    const projectRes = await client.readResource({ uri: 'pinsay://project' });
    assert.equal(projectRes.contents[0].uri, 'pinsay://project');
    const projectConfig = JSON.parse((projectRes.contents[0] as any).text);
    assert.equal(projectConfig.project, 'test-project');

    // 3. prompts/list: assert pinsay_apply_instructions
    const prompts = await client.listPrompts();
    assert.ok(prompts.prompts.some((p) => p.name === 'pinsay_apply_instructions'));

    // 4. tools/call: call pinsay_resolve_source with deadbeef
    const callResult = (await client.callTool({
      name: 'pinsay_resolve_source',
      arguments: { hash: 'deadbeef' },
    })) as any;

    assert.equal(Boolean(callResult.isError), false);
    assert.ok(Array.isArray(callResult.content));
    assert.equal(callResult.content[0].type, 'text');
    const resultObj = JSON.parse(callResult.content[0].text);
    assert.deepEqual(resultObj, { path: null, reason: 'no-manifest' });
  } finally {
    await client.close();
    await stub.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
