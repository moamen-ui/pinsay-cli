import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('update installs the skill files when they are entirely missing', async () => {
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
    ]) {
      const stat = await fs.stat(join(dir, rel));
      assert.ok(stat.isFile() || stat.isSymbolicLink(), `${rel} should exist`);
    }
    await assert.rejects(fs.access(join(dir, '.pinsay/pinsay.sh')), 'pinsay.sh is no longer installed');
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

test('update --check on an up-to-date repo writes nothing (no .pinsay/.gitignore, no exclude block)', async () => {
  const stub = await stubServer('2026.09.16');
  const dir = await scratch({ project: 'demo', aiTool: 'claude-code' });
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });

    const first = await updateCommand(dir, { server: stub.url });
    assert.equal(first, 0);

    await fs.rm(join(dir, '.pinsay/.gitignore'), { force: true });
    await fs.writeFile(join(dir, '.git/info/exclude'), '# mine\n', 'utf8');

    const code = await updateCommand(dir, { server: stub.url, check: true });
    assert.equal(code, 0);
    await assert.rejects(fs.access(join(dir, '.pinsay/.gitignore')), 'check must not create .pinsay/.gitignore');
    const exclude = await fs.readFile(join(dir, '.git/info/exclude'), 'utf8');
    assert.equal(exclude, '# mine\n');
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
    await assert.rejects(fs.access(join(dir, '.pinsay/pinsay.sh')), 'pinsay.sh is no longer installed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('update leaves an old .pinsay/pinsay.sh untouched and notes it is no longer used, once', async (t) => {
  const stub = await stubServer('2026.09.16');
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local', aiTool: 'claude-code' });
  try {
    const shPath = join(dir, '.pinsay/pinsay.sh');
    await fs.writeFile(shPath, 'old', 'utf8');

    const log = t.mock.method(console, 'log', () => {});
    const code = await updateCommand(dir, { server: stub.url });
    assert.equal(code, 0);

    assert.equal(await fs.readFile(shPath, 'utf8'), 'old', 'update must never touch an existing pinsay.sh');
    const lines = log.mock.calls.map((c) => String(c.arguments[0]));
    const notes = lines.filter((l) => l.includes('no longer used'));
    assert.equal(notes.length, 1, `expected exactly one note, got: ${lines.join(' | ')}`);
    assert.match(notes[0], /npx pinsay-cli remove/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

const CFG = { project: 'demo', environment: 'local', aiTool: 'claude-code' };
const STORE = '{"https://app.pinsay.dev":{"apiKey":"pnsy_x"}}';

/** Runs `fn` with the named env vars saved, restoring them (or deleting them) afterwards. */
async function withEnv(names: string[], fn: () => Promise<void>): Promise<void> {
  const saved = names.map((n) => process.env[n]);
  try {
    await fn();
  } finally {
    names.forEach((n, i) => {
      if (saved[i] === undefined) delete process.env[n];
      else process.env[n] = saved[i];
    });
  }
}

test('update deletes the machine-wide key file and says which one', async (t) => {
  await withEnv(['PINSAY_CONFIG_DIR'], async () => {
    const stub = await stubServer('2026.09.16');
    try {
      const cfg = await fs.mkdtemp(join(tmpdir(), 'pinsay-update-cfg-'));
      process.env.PINSAY_CONFIG_DIR = cfg;
      await fs.writeFile(join(cfg, 'credentials.json'), STORE, 'utf8');
      const dir = await scratch({ server: stub.url, ...CFG });
      await fs.writeFile(join(dir, '.pinsay/credentials.env'), 'PINSAY_API_KEY=pnsy_repo\n', 'utf8');
      const lines: string[] = [];
      t.mock.method(console, 'log', (...a: unknown[]) => { lines.push(a.join(' ')); });
      await updateCommand(dir, { server: stub.url });
      await assert.rejects(fs.access(join(cfg, 'credentials.json')));
      assert.equal(lines.filter((l) => l.includes('removed machine-wide key')).length, 1);
      assert.ok(lines.includes(`removed machine-wide key ${join(cfg, 'credentials.json')}`));
      assert.ok(!lines.some((l) => l.includes('has no key of its own')));
    } finally {
      await stub.close();
    }
  });
});

test('update hints login when the repo has no key of its own', async (t) => {
  await withEnv(['PINSAY_CONFIG_DIR', 'PINSAY_API_KEY'], async () => {
    const stub = await stubServer('2026.09.16');
    try {
      const cfg = await fs.mkdtemp(join(tmpdir(), 'pinsay-update-cfg-'));
      process.env.PINSAY_CONFIG_DIR = cfg;
      delete process.env.PINSAY_API_KEY;
      await fs.writeFile(join(cfg, 'credentials.json'), STORE, 'utf8');
      const dir = await scratch({ server: stub.url, ...CFG });
      const lines: string[] = [];
      t.mock.method(console, 'log', (...a: unknown[]) => { lines.push(a.join(' ')); });
      await updateCommand(dir, { server: stub.url });
      assert.ok(lines.includes('This repo has no key of its own yet. Sign in for it: npx pinsay-cli login'));
    } finally {
      await stub.close();
    }
  });
});

test('update --check lists the machine key and keeps it', async (t) => {
  await withEnv(['PINSAY_CONFIG_DIR'], async () => {
    const stub = await stubServer('2026.09.16');
    try {
      const cfg = await fs.mkdtemp(join(tmpdir(), 'pinsay-update-cfg-'));
      process.env.PINSAY_CONFIG_DIR = cfg;
      await fs.writeFile(join(cfg, 'credentials.json'), STORE, 'utf8');
      const dir = await scratch({ server: stub.url, ...CFG });
      const lines: string[] = [];
      t.mock.method(console, 'log', (...a: unknown[]) => { lines.push(a.join(' ')); });
      await updateCommand(dir, { server: stub.url, check: true });
      await fs.access(join(cfg, 'credentials.json'));
      assert.ok(lines.includes(`machine-wide key found: ${join(cfg, 'credentials.json')} (update deletes it)`));
    } finally {
      await stub.close();
    }
  });
});

test('update with no machine key prints nothing about it', async (t) => {
  await withEnv(['PINSAY_CONFIG_DIR'], async () => {
    const stub = await stubServer('2026.09.16');
    try {
      process.env.PINSAY_CONFIG_DIR = await fs.mkdtemp(join(tmpdir(), 'pinsay-update-cfg-'));
      const dir = await scratch({ server: stub.url, ...CFG });
      const lines: string[] = [];
      t.mock.method(console, 'log', (...a: unknown[]) => { lines.push(a.join(' ')); });
      await updateCommand(dir, { server: stub.url });
      assert.ok(!lines.some((l) => l.includes('machine-wide')));
    } finally {
      await stub.close();
    }
  });
});

test("update in a folder that isn't set up still deletes the machine key", async (t) => {
  await withEnv(['PINSAY_CONFIG_DIR'], async () => {
    const stub = await stubServer('2026.09.16');
    try {
      const cfg = await fs.mkdtemp(join(tmpdir(), 'pinsay-update-cfg-'));
      process.env.PINSAY_CONFIG_DIR = cfg;
      await fs.writeFile(join(cfg, 'credentials.json'), STORE, 'utf8');
      const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-update-'));
      t.mock.method(console, 'log', () => {});
      t.mock.method(console, 'error', () => {});
      assert.equal(await updateCommand(dir, { server: stub.url }), 1);
      await assert.rejects(fs.access(join(cfg, 'credentials.json')));
    } finally {
      await stub.close();
    }
  });
});

test(
  'update deletes a pre-0.8.0 pointer store only when it is a PinSay store',
  { skip: process.platform === 'win32' && 'XDG paths' },
  async (t) => {
    await withEnv(['PINSAY_CONFIG_DIR', 'XDG_CONFIG_HOME'], async () => {
      const stub = await stubServer('2026.09.16');
      try {
        delete process.env.PINSAY_CONFIG_DIR;
        const xdg = await fs.mkdtemp(join(tmpdir(), 'pinsay-update-xdg-'));
        process.env.XDG_CONFIG_HOME = xdg;
        const file = join(xdg, 'pointer', 'credentials.json');
        await fs.mkdir(join(xdg, 'pointer'), { recursive: true });
        await fs.writeFile(file, '{"https://app.pinsay.dev":{"apiKey":"pnsy_old"}}', 'utf8');
        const dir = await scratch({ server: stub.url, ...CFG });
        t.mock.method(console, 'log', () => {});
        await updateCommand(dir, { server: stub.url });
        await assert.rejects(fs.access(file));
        await assert.rejects(fs.access(join(xdg, 'pointer')));

        await fs.mkdir(join(xdg, 'pointer'), { recursive: true });
        await fs.writeFile(file, '{"other":"tool"}', 'utf8');
        await updateCommand(dir, { server: stub.url });
        await fs.access(file);
      } finally {
        await stub.close();
      }
    });
  },
);
