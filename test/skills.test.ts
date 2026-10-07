import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { formatSkillWarnings, installSkills, SKILL_FILES, SUB_SKILLS } from '../src/skills.js';
import { canSymlink, NO_SYMLINK } from './symlink-support.js';
import { gitSymlinkStub } from './git-stub.js';

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
    const { files: installed } = await installSkills(stub.url, 'claude-code', dir);

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

test('A: claude-code fresh install', { skip: !canSymlink && NO_SYMLINK }, async () => {
  const stub = await stubServer();
  const dir = await scratchDir();
  try {
    const { files, warnings } = await installSkills(stub.url, 'claude-code', dir);
    assert.deepEqual(warnings, []);
    const mirrorPath = join(dir, '.agents/skills/pinsay-init/SKILL.md');
    const st = await fs.lstat(mirrorPath);
    assert.ok(st.isSymbolicLink());
    const target = await fs.readlink(mirrorPath);
    assert.equal(target, join('..', '..', '..', '.claude', 'skills', 'pinsay-init', 'SKILL.md'));
    assert.ok(files.includes('.agents/skills/pinsay-init/SKILL.md'));
    assert.ok(files.includes('.pinsay/pinsay.sh'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('B: claude-code, .claude/skills is a plain file', async () => {
  const stub = await stubServer();
  const dir = await scratchDir();
  try {
    await fs.mkdir(join(dir, '.claude'), { recursive: true });
    await fs.writeFile(join(dir, '.claude/skills'), 'notes\nmore notes\n', 'utf8');

    const { files, warnings } = await installSkills(stub.url, 'claude-code', dir);
    assert.ok(await fs.stat(join(dir, '.pinsay/pinsay.sh')));
    assert.equal(warnings.length, 2);
    for (const w of warnings) {
      assert.equal(w.tool, 'claude-code');
      assert.match(w.message, /\.claude\/skills is a file, not a folder/);
    }
    assert.deepEqual(
      warnings.map((w) => w.path).sort(),
      ['.claude/skills/pinsay-init/SKILL.md', '.claude/skills/pinsay-feedback/SKILL.md'].sort(),
    );
    const content = await fs.readFile(join(dir, '.claude/skills'), 'utf8');
    assert.equal(content, 'notes\nmore notes\n');
    await assert.rejects(fs.access(join(dir, '.agents/skills')));
    assert.deepEqual(files, ['.pinsay/pinsay.sh']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('C: claude-code, .agents/skills dir exists, .claude/skills plain file ../.agents/skills', async () => {
  const stub = await stubServer();
  const dir = await scratchDir();
  try {
    await fs.mkdir(join(dir, '.agents/skills'), { recursive: true });
    await fs.mkdir(join(dir, '.claude'), { recursive: true });
    await fs.writeFile(join(dir, '.claude/skills'), '../.agents/skills', 'utf8');

    const { warnings } = await installSkills(stub.url, 'claude-code', dir);
    assert.deepEqual(warnings, []);
    const initSt = await fs.lstat(join(dir, '.agents/skills/pinsay-init/SKILL.md'));
    assert.ok(initSt.isFile());
    const initContent = await fs.readFile(join(dir, '.agents/skills/pinsay-init/SKILL.md'), 'utf8');
    assert.match(initContent, /# init/);
    const applyContent = await fs.readFile(join(dir, '.agents/skills/pinsay-feedback/apply.md'), 'utf8');
    assert.match(applyContent, /apply body/);
    const stubContent = await fs.readFile(join(dir, '.claude/skills'), 'utf8');
    assert.equal(stubContent, '../.agents/skills');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('installSkills through a Git symlink checked out as a plain file (core.symlinks=false), target missing', async () => {
  const stub = await stubServer();
  const dir = await scratchDir();
  try {
    gitSymlinkStub(dir, '.claude/skills', '../docs/skills');

    // Git itself wrote the stub: a plain text file whose content is the link target — the exact
    // shape the CEO's Windows checkout has.
    const stubSt = await fs.lstat(join(dir, '.claude/skills'));
    assert.ok(stubSt.isFile());
    assert.equal(await fs.readFile(join(dir, '.claude/skills'), 'utf8'), '../docs/skills');

    const { warnings } = await installSkills(stub.url, 'claude-code', dir);
    assert.deepEqual(warnings, []);

    const initContent = await fs.readFile(join(dir, 'docs/skills/pinsay-init/SKILL.md'), 'utf8');
    assert.match(initContent, /# init/);
    await fs.access(join(dir, 'docs/skills/pinsay-feedback/apply.md'));

    assert.equal(await fs.readFile(join(dir, '.claude/skills'), 'utf8'), '../docs/skills');

    const mirrorContent = await fs.readFile(join(dir, '.agents/skills/pinsay-init/SKILL.md'), 'utf8');
    assert.equal(mirrorContent, initContent);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('D: claude-code, .claude/skills = symlink ../.agents/skills (missing target)', { skip: !canSymlink && NO_SYMLINK }, async () => {
  const stub = await stubServer();
  const dir = await scratchDir();
  try {
    await fs.mkdir(join(dir, '.claude'), { recursive: true });
    await fs.symlink('../.agents/skills', join(dir, '.claude/skills'), 'dir');

    const { warnings } = await installSkills(stub.url, 'claude-code', dir);
    assert.deepEqual(warnings, []);
    const content = await fs.readFile(join(dir, '.claude/skills/pinsay-init/SKILL.md'), 'utf8');
    assert.match(content, /# init/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('E: claude-code with symlink failure (EPERM fallback to copy)', async (t) => {
  const stub = await stubServer();
  const dir = await scratchDir();
  t.mock.method(fs, 'symlink', async () => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  });
  try {
    const { warnings } = await installSkills(stub.url, 'claude-code', dir);
    assert.deepEqual(warnings, []);
    const mirrorPath = join(dir, '.agents/skills/pinsay-init/SKILL.md');
    const st = await fs.lstat(mirrorPath);
    assert.ok(st.isFile());
    const mirrorContent = await fs.readFile(mirrorPath, 'utf8');
    const primaryContent = await fs.readFile(join(dir, '.claude/skills/pinsay-init/SKILL.md'), 'utf8');
    assert.equal(mirrorContent, primaryContent);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('F: claude-code: run E mocked install, restore mock, run installSkills again', { skip: !canSymlink && NO_SYMLINK }, async (t) => {
  const stub = await stubServer();
  const dir = await scratchDir();
  t.mock.method(fs, 'symlink', async () => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  });
  try {
    await installSkills(stub.url, 'claude-code', dir);
    t.mock.restoreAll();
    const { warnings } = await installSkills(stub.url, 'claude-code', dir);
    assert.deepEqual(warnings, []);
    const mirrorPath = join(dir, '.agents/skills/pinsay-init/SKILL.md');
    const st = await fs.lstat(mirrorPath);
    assert.ok(st.isSymbolicLink());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('G: claude-code against closed port', async () => {
  const dir = await scratchDir();
  try {
    const { files, warnings } = await installSkills('http://127.0.0.1:9', 'claude-code', dir);
    assert.deepEqual(files, []);
    for (const w of warnings) {
      assert.match(w.message, /could not download the skill files from http:\/\/127\.0\.0\.1:9/);
    }
    const lines = formatSkillWarnings(warnings);
    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith('⚠ Skills for claude-code:'));
    assert.ok(lines[1].startsWith('  Not installed: .pinsay/pinsay.sh, '));
    assert.ok(lines[2].startsWith('  Fix: '));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('H: formatSkillWarnings unit grouping', () => {
  const warnings = [
    { tool: 'cursor', path: 'a', message: 'm', hint: 'h' },
    { tool: 'cursor', path: 'b', message: 'm', hint: 'h' },
    { tool: 'cursor', path: 'c', message: 'other', hint: 'h' },
  ];
  const lines = formatSkillWarnings(warnings);
  assert.equal(lines.length, 6);
  assert.equal(lines[1], '  Not installed: a, b');
  assert.equal(lines[4], '  Not installed: c');
});

test('I: cursor with .cursor/rules as a plain file', async () => {
  const stub = await stubServer();
  const dir = await scratchDir();
  try {
    await fs.mkdir(join(dir, '.cursor'), { recursive: true });
    await fs.writeFile(join(dir, '.cursor/rules'), 'x', 'utf8');

    const { files, warnings } = await installSkills(stub.url, 'cursor', dir);
    assert.ok(files.includes('.pinsay/pinsay.sh'));
    const paths = warnings.map((w) => w.path).sort();
    assert.deepEqual(paths, ['.cursor/rules/pinsay-feedback.md', '.cursor/rules/pinsay-init.md'].sort());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

