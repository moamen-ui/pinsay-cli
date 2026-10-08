import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readStamp } from '../src/lib/skill-stamp.js';
import { skillFilesFor } from '../src/lib/skill-paths.js';

async function write(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-stamp-'));
  const path = join(dir, name);
  await fs.writeFile(path, content, 'utf8');
  return path;
}

test('reads the stamp that follows a markdown file\'s frontmatter', async () => {
  const path = await write('SKILL.md', [
    '---',
    'name: pinsay-feedback',
    'description: something',
    '---',
    '<!-- pinsay-skill-version: 2026.09.12 -->',
    '',
    '# Heading',
  ].join('\n'));

  assert.equal(await readStamp(path), '2026.09.12');
});

test('locates the stamp by scanning, not by line number', async () => {
  // The frontmatter grows over time; a fixed line number would silently stop finding the stamp.
  const path = await write('SKILL.md', [
    '---',
    'name: pinsay-feedback',
    'description: a much longer block',
    'allowed-tools: Bash, Read',
    'extra: another key',
    '---',
    '<!-- pinsay-skill-version: 9.9.9 -->',
  ].join('\n'));

  assert.equal(await readStamp(path), '9.9.9');
});

test('REJECTS a stamp on line 1 of a markdown file when frontmatter follows', async () => {
  // This is the rule worth guarding. AI tools parse the YAML frontmatter block; anything before
  // it breaks that parse. Accepting such a file would bless an install the tool cannot read.
  const path = await write('SKILL.md', [
    '<!-- pinsay-skill-version: 1.2.3 -->',
    '---',
    'name: pinsay-feedback',
    '---',
  ].join('\n'));

  assert.equal(await readStamp(path), null);
});

test('reads the stamp on line 1 of a markdown file without frontmatter (sub-skill shape)', async () => {
  // Served sub-skills like apply.md, translate.md, advanced.md have no frontmatter block.
  // Their first line carries the stamp comment directly.
  const path = await write('apply.md', [
    '<!-- pinsay-skill-version: 2026.09.16 -->',
    '',
    '# Apply workflow (apply.md)',
    '',
    'Body text here.',
  ].join('\n'));

  assert.equal(await readStamp(path), '2026.09.16');
});

test('reads the stamp within the first 3 non-empty lines without frontmatter', async () => {
  const path = await write('sub.md', [
    '',
    '# Sub skill',
    '<!-- pinsay-skill-version: 2026.09.16 -->',
    '',
    'Body text here.',
  ].join('\n'));

  assert.equal(await readStamp(path), '2026.09.16');
});

test('returns null when the stamp is beyond the first 3 non-empty lines without frontmatter', async () => {
  const path = await write('late-stamp.md', [
    '# Sub skill',
    'Line 1',
    'Line 2',
    '<!-- pinsay-skill-version: 2026.09.16 -->',
  ].join('\n'));

  assert.equal(await readStamp(path), null);
});

test('returns null for an unstamped markdown file without frontmatter', async () => {
  const path = await write('unstamped-sub.md', [
    '# Sub skill without stamp',
    '',
    'Some prose here.',
  ].join('\n'));

  assert.equal(await readStamp(path), null);
});

test('reads the stamp on line 2 of a shell script', async () => {
  const path = await write('pinsay.sh', [
    '#!/usr/bin/env bash',
    '# pinsay-skill-version: 2026.09.12',
    'echo hi',
  ].join('\n'));

  assert.equal(await readStamp(path), '2026.09.12');
});

test('returns null for an unstamped file, a missing file, and an unknown type', async () => {
  const unstamped = await write('SKILL.md', ['---', 'name: x', '---', '', '# Heading'].join('\n'));
  assert.equal(await readStamp(unstamped), null);

  const shNoStamp = await write('pinsay.sh', ['#!/bin/sh', 'echo hi'].join('\n'));
  assert.equal(await readStamp(shNoStamp), null);

  assert.equal(await readStamp('/nonexistent/nope.md'), null);

  const other = await write('notes.txt', '# pinsay-skill-version: 1.0.0');
  assert.equal(await readStamp(other), null);
});

test('does not mistake a later mention in the prose for the stamp', async () => {
  const path = await write('SKILL.md', [
    '---',
    'name: x',
    '---',
    '',
    '# Heading',
    '',
    'The file carries a pinsay-skill-version: 4.5.6 comment near the top.',
  ].join('\n'));

  assert.equal(await readStamp(path), null);
});

test('skillFilesFor maps each AI tool to the paths init actually wrote', () => {
  // Folder-capable tools (claude-code, and the .agents/skills/ fallbacks below) get
  // apply.md/translate.md/advanced.md as siblings of SKILL.md — see skills.ts SUB_SKILLS.
  assert.deepEqual(skillFilesFor({ aiTool: 'claude-code' }), [
    '.claude/skills/pinsay-init/SKILL.md',
    '.claude/skills/pinsay-feedback/SKILL.md',
    '.claude/skills/pinsay-feedback/apply.md',
    '.claude/skills/pinsay-feedback/translate.md',
    '.claude/skills/pinsay-feedback/advanced.md',
  ]);

  // cursor/windsurf have no folder for siblings — their pinsay-feedback entry stays one flat
  // file containing all four sections (see buildFlatPinSayFeedback), so no sub-file paths here.
  assert.deepEqual(skillFilesFor({ aiTool: 'cursor' }), [
    '.cursor/rules/pinsay-init.md',
    '.cursor/rules/pinsay-feedback.md',
  ]);

  // An unknown or absent tool falls back to the same layout installSkills uses: the standard
  // Agent Skills location (`.agents/skills/<name>/SKILL.md`), current as of 2026-09-16.
  assert.deepEqual(skillFilesFor({ aiTool: 'something-else' }), [
    '.agents/skills/pinsay-init/SKILL.md',
    '.agents/skills/pinsay-feedback/SKILL.md',
    '.agents/skills/pinsay-feedback/apply.md',
    '.agents/skills/pinsay-feedback/translate.md',
    '.agents/skills/pinsay-feedback/advanced.md',
  ]);
  assert.deepEqual(skillFilesFor({}), [
    '.agents/skills/pinsay-init/SKILL.md',
    '.agents/skills/pinsay-feedback/SKILL.md',
    '.agents/skills/pinsay-feedback/apply.md',
    '.agents/skills/pinsay-feedback/translate.md',
    '.agents/skills/pinsay-feedback/advanced.md',
  ]);
  assert.deepEqual(skillFilesFor({ aiTool: 'antigravity' }), [
    '.agents/skills/pinsay-init/SKILL.md',
    '.agents/skills/pinsay-feedback/SKILL.md',
    '.agents/skills/pinsay-feedback/apply.md',
    '.agents/skills/pinsay-feedback/translate.md',
    '.agents/skills/pinsay-feedback/advanced.md',
  ]);
});

test('a recorded skillsDir overrides the tool mapping', () => {
  // A --skills-dir override always writes the folder shape, regardless of aiTool (here cursor's
  // normal aiTool would mean "flat file") — see skillFilesFor's and installSkills' handling.
  assert.deepEqual(skillFilesFor({ aiTool: 'claude-code', skillsDir: 'custom/skills' }), [
    'custom/skills/pinsay-init/SKILL.md',
    'custom/skills/pinsay-feedback/SKILL.md',
    'custom/skills/pinsay-feedback/apply.md',
    'custom/skills/pinsay-feedback/translate.md',
    'custom/skills/pinsay-feedback/advanced.md',
  ]);
});
