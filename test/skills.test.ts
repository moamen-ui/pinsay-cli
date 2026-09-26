import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { installSkills, SKILL_FILES, SUB_SKILLS } from '../src/skills.js';

/** A stub PinSay server serving fixed, distinguishable bodies for the four skill files. */
async function stubServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const bodies: Record<string, string> = {
    '/pinsay-init.md': '---\nname: pinsay-init\n---\n<!-- pinsay-skill-version: 1.0.0 -->\n\n# init\n',
    '/skill.md': '---\nname: pinsay-feedback\n---\n<!-- pinsay-skill-version: 1.0.0 -->\n\n# entry\n\nRead next: apply.md, translate.md, advanced.md.\n',
    '/skills/apply.md': '<!-- pinsay-skill-version: 1.0.0 -->\n\n# Apply workflow (apply.md)\n\napply body\n',
    '/skills/translate.md': '<!-- pinsay-skill-version: 1.0.0 -->\n\n# Translation (translate.md)\n\ntranslate body\n',
    '/skills/advanced.md': '<!-- pinsay-skill-version: 1.0.0 -->\n\n# Advanced (advanced.md)\n\nadvanced body\n',
    '/pinsay.sh': '#!/bin/sh\n# pinsay-skill-version: 1.0.0\necho hi\n',
  };
  const server: Server = createServer((req, res) => {
    const body = bodies[req.url ?? ''];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function scratchDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'pinsay-skills-'));
}

test('SUB_SKILLS lists exactly the three sub-skill names, in read order', () => {
  assert.deepEqual([...SUB_SKILLS], ['apply', 'translate', 'advanced']);
});

test('installSkills for a folder-capable tool (claude-code) writes SKILL.md plus the three sub-files as siblings', async () => {
  const stub = await stubServer();
  const dir = await scratchDir();
  try {
    const installed = await installSkills(stub.url, 'claude-code', dir);

    const feedbackDir = join(dir, '.claude/skills/pinsay-feedback');
    const skillMd = await fs.readFile(join(feedbackDir, 'SKILL.md'), 'utf8');
    assert.match(skillMd, /# entry/);

    for (const name of SUB_SKILLS) {
      const content = await fs.readFile(join(feedbackDir, `${name}.md`), 'utf8');
      assert.match(content, new RegExp(`${name} body`), `${name}.md should contain its own served body`);
    }

    // installSkills' return value accounts for every sibling it wrote.
    for (const name of SUB_SKILLS) {
      assert.ok(
        installed.includes(join('.claude/skills/pinsay-feedback', `${name}.md`)),
        `installed files should include ${name}.md`,
      );
    }

    // pinsay-init has no sub-files — only its own SKILL.md.
    await assert.rejects(fs.access(join(dir, '.claude/skills/pinsay-init/apply.md')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('installSkills for a flat-file tool (cursor) writes ONE pinsay-feedback.md containing all three markers', async () => {
  const stub = await stubServer();
  const dir = await scratchDir();
  try {
    await installSkills(stub.url, 'cursor', dir);

    const rulesPath = join(dir, '.cursor/rules/pinsay-feedback.md');
    const content = await fs.readFile(rulesPath, 'utf8');

    assert.match(content, /# entry/, 'the entry content must lead the file');
    for (const name of SUB_SKILLS) {
      assert.ok(content.includes(`<!-- pinsay-skill: ${name} -->`), `missing marker for ${name}`);
      assert.match(content, new RegExp(`${name} body`), `missing ${name}'s own body`);
    }

    // No sibling sub-files — everything lives in the one file.
    await assert.rejects(fs.access(join(dir, '.cursor/rules/apply.md')));
    await assert.rejects(fs.access(join(dir, '.cursor/rules/pinsay-feedback/apply.md')));

    // The markers appear in read order: apply, then translate, then advanced.
    const positions = SUB_SKILLS.map((name) => content.indexOf(`<!-- pinsay-skill: ${name} -->`));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('installSkills for windsurf also concatenates into one file', async () => {
  const stub = await stubServer();
  const dir = await scratchDir();
  try {
    await installSkills(stub.url, 'windsurf', dir);
    const content = await fs.readFile(join(dir, '.windsurf/rules/pinsay-feedback.md'), 'utf8');
    for (const name of SUB_SKILLS) {
      assert.ok(content.includes(`<!-- pinsay-skill: ${name} -->`));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('installSkills with a custom skillsDir writes the folder shape regardless of aiTool', async () => {
  const stub = await stubServer();
  const dir = await scratchDir();
  try {
    // cursor's aiTool would normally mean "flat file", but a --skills-dir override always writes
    // the folder shape (see installSkills' isFlatFileTool).
    await installSkills(stub.url, 'cursor', dir, 'custom-skills');

    const feedbackDir = join(dir, 'custom-skills/pinsay-feedback');
    await fs.access(join(feedbackDir, 'SKILL.md'));
    for (const name of SUB_SKILLS) {
      await fs.access(join(feedbackDir, `${name}.md`));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('SKILL_FILES: folder-capable tools list all three sub-files, flat-file tools list none', () => {
  for (const tool of ['claude-code', 'other', 'antigravity']) {
    for (const name of SUB_SKILLS) {
      assert.ok(
        SKILL_FILES[tool].some((p) => p.endsWith(`/${name}.md`)),
        `${tool} should list ${name}.md`,
      );
    }
  }
  for (const tool of ['cursor', 'windsurf']) {
    assert.equal(SKILL_FILES[tool].length, 2, `${tool} keeps its two-file layout`);
  }
});
