import { after, before, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { decideTools, detectRepoTools } from '../src/init/tool-detect.js';

let prevNoColor: string | undefined;
before(() => {
  prevNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
});
after(() => {
  if (prevNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = prevNoColor;
});

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-tools-'));
}

test('a .claude folder with a non-PinSay file is a claude-code signal', async () => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, '.claude'));
  await fs.writeFile(path.join(root, '.claude', 'settings.json'), '{}\n');
  assert.deepEqual(await detectRepoTools(root, {}), ['claude-code']);
});

test('an empty .claude folder is a claude-code signal too', async () => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, '.claude'));
  assert.deepEqual(await detectRepoTools(root, {}), ['claude-code']);
});

test("a folder holding only PinSay's own skills is not a signal", async () => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, '.claude', 'skills', 'pinsay-init'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude', 'skills', 'pinsay-init', 'SKILL.md'), '---\n');
  assert.deepEqual(await detectRepoTools(root, {}), []);
});

test('.cursor plus GEMINI.md finds cursor and antigravity, in catalogue order', async () => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
  await fs.writeFile(path.join(root, '.cursor', 'rules', 'main.json'), '{}\n');
  await fs.writeFile(path.join(root, 'GEMINI.md'), '# Gemini\n');
  assert.deepEqual(await detectRepoTools(root, {}), ['cursor', 'antigravity']);
});

test('AGENTS.md alone points to other', async () => {
  const root = await tmpRoot();
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Agents\n');
  assert.deepEqual(await detectRepoTools(root, {}), ['other']);
});

test('a real tool beats other', async () => {
  const root = await tmpRoot();
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Agents\n');
  await fs.mkdir(path.join(root, '.claude'));
  await fs.writeFile(path.join(root, '.claude', 'x'), 'not pinsay\n');
  assert.deepEqual(await detectRepoTools(root, {}), ['claude-code']);
});

test('the environment can be the only signal', async () => {
  const root = await tmpRoot();
  assert.deepEqual(await detectRepoTools(root, { CLAUDECODE: '1' }), ['claude-code']);
});

test('decideTools: the flag wins, then the saved tool', () => {
  assert.deepEqual(decideTools(['cursor'], { flagTool: 'windsurf', interactive: true }), {
    tools: ['windsurf'],
    ask: false,
    preselected: [],
  });
  assert.deepEqual(decideTools(['cursor'], { savedTool: 'opencode', interactive: true }), {
    tools: ['opencode'],
    ask: false,
    preselected: [],
  });
});

test('decideTools: exactly one found tool is used without asking', () => {
  assert.deepEqual(decideTools(['cursor'], { interactive: true }), {
    tools: ['cursor'],
    ask: false,
    preselected: [],
  });
});

test('decideTools: none or several, interactive → ask with the found ones pre-ticked', () => {
  assert.deepEqual(decideTools(['cursor', 'windsurf'], { interactive: true }), {
    tools: [],
    ask: true,
    preselected: ['cursor', 'windsurf'],
  });
  assert.deepEqual(decideTools([], { interactive: true }), {
    tools: [],
    ask: true,
    preselected: ['claude-code'],
  });
});

test('decideTools: none or several, non-interactive → all found, else other', () => {
  assert.deepEqual(decideTools(['cursor', 'windsurf'], { interactive: false }), {
    tools: ['cursor', 'windsurf'],
    ask: false,
    preselected: [],
  });
  assert.deepEqual(decideTools([], { interactive: false }), {
    tools: ['other'],
    ask: false,
    preselected: [],
  });
});
