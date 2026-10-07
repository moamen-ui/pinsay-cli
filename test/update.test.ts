import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { updateCommand } from '../src/commands/update.js';

async function scratch(config: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-update-'));
  await fs.mkdir(join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(join(dir, '.pinsay/config.json'), JSON.stringify(config), 'utf8');
  return dir;
}

/** A stub PinSay server: /api/meta reports a skill version, the three served files return fixed bodies. */
async function stubServer(skillVersion: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/api/meta') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: true, data: { skillVersion } }));
      return;
    }
    if (req.url === '/pinsay.sh') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`#!/bin/sh\n# pinsay-skill-version: ${skillVersion}\necho hi\n`);
      return;
    }
    if (req.url === '/pinsay-init.md' || req.url === '/skill.md') {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      res.end(`---\nname: x\n---\n<!-- pinsay-skill-version: ${skillVersion} -->\n\nbody\n`);
      return;
    }
    if (req.url === '/skills/apply.md' || req.url === '/skills/translate.md' || req.url === '/skills/advanced.md') {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      res.end(`<!-- pinsay-skill-version: ${skillVersion} -->\n\n# ${req.url}\n`);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false, message: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('update installs pinsay.sh and the skill files when they are entirely missing', async () => {
  const stub = await stubServer('2026.09.16');
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local', aiTool: 'claude-code' });
  try {
    const code = await updateCommand(dir, { server: stub.url });
    assert.equal(code, 0);

    for (const rel of [
      '.claude/skills/pinsay-init/SKILL.md',
      '.claude/skills/pinsay-feedback/SKILL.md',
      '.claude/skills/pinsay-feedback/apply.md',
      '.claude/skills/pinsay-feedback/translate.md',
      '.claude/skills/pinsay-feedback/advanced.md',
      '.pinsay/pinsay.sh',
    ]) {
      const stat = await fs.stat(join(dir, rel));
      assert.ok(stat.isFile() || stat.isSymbolicLink(), `${rel} should exist`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('update re-installs a skill file that was deleted after a previous install', async () => {
  const stub = await stubServer('2026.09.16');
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local', aiTool: 'claude-code' });
  try {
    // A first run installs everything.
    const first = await updateCommand(dir, { server: stub.url });
    assert.equal(first, 0);

    const feedbackSkill = join(dir, '.claude/skills/pinsay-feedback/SKILL.md');
    const translateSkill = join(dir, '.claude/skills/pinsay-feedback/translate.md');
    await fs.access(feedbackSkill); // sanity: it exists before we delete it
    await fs.access(translateSkill); // sanity: the sub-file was installed too
    await fs.rm(feedbackSkill);
    await fs.rm(translateSkill);

    const second = await updateCommand(dir, { server: stub.url });
    assert.equal(second, 0);

    await fs.access(feedbackSkill); // re-installed
    await fs.access(translateSkill); // sub-file re-installed alongside it
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('update rebuilds the flat Cursor rules file (not just /skill.md\'s body) when it is stale', async () => {
  const stub = await stubServer('2026.09.16');
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local', aiTool: 'cursor' });
  try {
    const first = await updateCommand(dir, { server: stub.url });
    assert.equal(first, 0);

    const rulesFile = join(dir, '.cursor/rules/pinsay-feedback.md');
    const before = await fs.readFile(rulesFile, 'utf8');
    for (const marker of ['<!-- pinsay-skill: apply -->', '<!-- pinsay-skill: translate -->', '<!-- pinsay-skill: advanced -->']) {
      assert.ok(before.includes(marker), `expected ${marker} in the concatenated rules file`);
    }

    // Simulate staleness: an older stamp than what the (still-running) stub server reports.
    await fs.writeFile(rulesFile, before.replace('2026.09.16', '2026.09.01'), 'utf8');

    const second = await updateCommand(dir, { server: stub.url });
    assert.equal(second, 0);

    const after = await fs.readFile(rulesFile, 'utf8');
    for (const marker of ['<!-- pinsay-skill: apply -->', '<!-- pinsay-skill: translate -->', '<!-- pinsay-skill: advanced -->']) {
      assert.ok(after.includes(marker), `refreshed rules file must still contain ${marker}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('update --check reports missing files without installing them', async () => {
  const stub = await stubServer('2026.09.16');
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local', aiTool: 'claude-code' });
  try {
    const code = await updateCommand(dir, { server: stub.url, check: true });
    assert.equal(code, 0);
    await assert.rejects(fs.access(join(dir, '.pinsay/pinsay.sh')), 'check must not install anything');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('update reports up to date once files are installed and match the server version', async () => {
  const stub = await stubServer('2026.09.16');
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local', aiTool: 'claude-code' });
  try {
    await updateCommand(dir, { server: stub.url });
    const code = await updateCommand(dir, { server: stub.url });
    assert.equal(code, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('update removes legacy .pinsay/credentials.env.example and .pinsay/.token_cache, never touching credentials.env', async () => {
  const stub = await stubServer('2026.09.16');
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local', aiTool: 'claude-code' });
  try {
    await fs.writeFile(join(dir, '.pinsay/credentials.env.example'), 'PINSAY_API_KEY=\n', 'utf8');
    await fs.writeFile(join(dir, '.pinsay/.token_cache'), '{"token":"stale"}', 'utf8');
    await fs.writeFile(join(dir, '.pinsay/credentials.env'), 'PINSAY_API_KEY=ptr_good\n', 'utf8');

    await updateCommand(dir, { server: stub.url });

    await assert.rejects(fs.access(join(dir, '.pinsay/credentials.env.example')));
    await assert.rejects(fs.access(join(dir, '.pinsay/.token_cache')));

    const creds = await fs.readFile(join(dir, '.pinsay/credentials.env'), 'utf8');
    assert.equal(creds, 'PINSAY_API_KEY=ptr_good\n');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('update installs through a link stub and then reports up to date', async (t) => {
  const stub = await stubServer('2026.09.16');
  const dir = await scratch({ project: 'demo', aiTool: 'claude-code' });
  try {
    await fs.mkdir(join(dir, '.agents/skills'), { recursive: true });
    await fs.mkdir(join(dir, '.claude'), { recursive: true });
    await fs.writeFile(join(dir, '.claude/skills'), '../.agents/skills', 'utf8');

    assert.equal(await updateCommand(dir, { server: stub.url }), 0);
    await fs.access(join(dir, '.agents/skills/pinsay-feedback/apply.md'));

    const log = t.mock.method(console, 'log', () => {});
    assert.equal(await updateCommand(dir, { server: stub.url }), 0);
    const lines = log.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(lines.some((l) => /Up to date/.test(l)), `expected "Up to date" in: ${lines.join(' | ')}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('update returns 1 and warns, without throwing, when .claude/skills is a plain file', async (t) => {
  const stub = await stubServer('2026.09.16');
  const dir = await scratch({ project: 'demo', aiTool: 'claude-code' });
  try {
    await fs.mkdir(join(dir, '.claude'), { recursive: true });
    await fs.writeFile(join(dir, '.claude/skills'), 'x\ny\n', 'utf8');

    const err = t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
    const code = await updateCommand(dir, { server: stub.url });
    assert.equal(code, 1);
    const lines = err.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(lines.some((l) => /is a file, not a folder/.test(l)), `got: ${lines.join(' | ')}`);
    await fs.access(join(dir, '.pinsay/pinsay.sh'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});
