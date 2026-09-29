import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  parseModelsFlag,
  mergeModels,
  primaryModel,
  resolveModels,
  resolveModelsFromArgs,
  delegationWarning,
  ModelsError,
} from '../src/apply/models.js';
import { markApplied, markFailed } from '../src/apply/mark.js';

const TRIO = 'claude-opus-5-5=planner,claude-sonnet-5-5=implementer,claude-opus-5-5=reviewer';

test('parseModelsFlag: parses ids with optional roles, keeps ":" inside ids', () => {
  assert.deepEqual(parseModelsFlag(TRIO), [
    { model: 'claude-opus-5-5', role: 'planner' },
    { model: 'claude-sonnet-5-5', role: 'implementer' },
    { model: 'claude-opus-5-5', role: 'reviewer' },
  ]);
  assert.deepEqual(parseModelsFlag('ollama/llama3:8b, gpt-5.2=Reviewer'), [
    { model: 'ollama/llama3:8b', role: null },
    { model: 'gpt-5.2', role: 'reviewer' },
  ]);
  assert.deepEqual(parseModelsFlag(''), []);
});

test('validation: rejects bad ids, bad roles and > 8 entries', () => {
  assert.throws(() => parseModelsFlag('-bad=planner'), ModelsError);
  assert.throws(() => parseModelsFlag('has space'), ModelsError);
  assert.throws(() => parseModelsFlag('a'.repeat(65)), ModelsError);
  assert.throws(() => parseModelsFlag('gpt-5=boss'), /Invalid role/);
  const nine = Array.from({ length: 9 }, (_, i) => `m${i}`).join(',');
  assert.throws(() => mergeModels(parseModelsFlag(nine)), /at most 8/);
});

test('mergeModels: --models first, dedupes on model (case-insens.) + role', () => {
  const merged = mergeModels(parseModelsFlag('A-1=planner,a-1=planner,a-1=reviewer'), [
    { model: 'A-1', role: null },
    { model: 'a-1', role: null },
  ]);
  assert.deepEqual(merged, [
    { model: 'A-1', role: 'planner' },
    { model: 'a-1', role: 'reviewer' },
    { model: 'A-1', role: null },
  ]);
});

test('primaryModel: implementer, else first, else undefined', () => {
  assert.equal(primaryModel(parseModelsFlag(TRIO)), 'claude-sonnet-5-5');
  assert.equal(primaryModel(parseModelsFlag('x1=planner,y1=reviewer')), 'x1');
  assert.equal(primaryModel([]), undefined);
});

test('resolveModels: env fallbacks and --model merge', () => {
  assert.deepEqual(resolveModels({}, { PINSAY_AI_MODELS: 'a1=planner' } as any), [{ model: 'a1', role: 'planner' }]);
  assert.deepEqual(resolveModels({ models: 'a1=planner', model: 'b1' }, {} as any), [
    { model: 'a1', role: 'planner' },
    { model: 'b1', role: null },
  ]);
  assert.deepEqual(resolveModels({}, { PINSAY_AI_MODEL: 'c1' } as any), [{ model: 'c1', role: null }]);
});

test('resolveModelsFromArgs (MCP): models array + legacy model, validated', () => {
  assert.deepEqual(
    resolveModelsFromArgs({ models: [{ model: 'a1', role: 'planner' }, { model: 'b1' }], model: 'c1' }, {} as any),
    [
      { model: 'a1', role: 'planner' },
      { model: 'b1', role: null },
      { model: 'c1', role: null },
    ],
  );
  assert.throws(() => resolveModelsFromArgs({ models: [{ model: 'a1', role: 'x' }] }, {} as any), ModelsError);
  assert.throws(() => resolveModelsFromArgs({ models: 'nope' }, {} as any), ModelsError);
});

test('delegationWarning: only when delegation auto and < 2 distinct ids', () => {
  const w = delegationWarning('auto', parseModelsFlag('claude-opus-5-5=planner,claude-opus-5-5=reviewer'));
  assert.match(w!, /Delegation is on/);
  assert.match(w!, /--models "<planner>=planner,<worker>=implementer,<reviewer>=reviewer"/);
  assert.ok(delegationWarning('auto', []));
  assert.equal(delegationWarning('auto', parseModelsFlag(TRIO)), null);
  assert.equal(delegationWarning('off', parseModelsFlag('x1=implementer')), null);
});

async function withRepo(
  delegation: 'auto' | 'off',
  fn: (h: { ctx: any; bodies: any[] }) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-models-test-'));
  for (const a of [['init'], ['config', 'user.name', 'D'], ['config', 'user.email', 'dev@example.com']]) {
    spawnSync('git', a, { cwd: dir });
  }
  await fs.writeFile(join(dir, 'README.md'), '# t\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });
  await fs.mkdir(join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    join(dir, '.pinsay/config.json'),
    JSON.stringify({ server: 'x', project: 'my-app', environment: 'local', cliVersion: '0.1.0', delegation }),
  );
  await fs.writeFile(join(dir, 'app.js'), 'x\n');
  spawnSync('git', ['add', 'app.js'], { cwd: dir });
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    const json = (o: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.method === 'GET' && req.url === '/api/branding') return json({ isSuccess: true, data: { productName: 'PinSay' } });
    if (req.method === 'GET') return json({ isSuccess: true, data: { id: 5, body: 'b', commitStyle: 2 } });
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.url !== '/api/events') bodies.push(JSON.parse(data));
      json({ isSuccess: true, data: {} });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    await fn({ ctx: { server: url, project: 'my-app', token: 't', cwd: dir }, bodies });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('markApplied sends aiModels + legacy aiModel (primary = implementer)', async () => {
  await withRepo('auto', async ({ ctx, bodies }) => {
    await markApplied({ id: 5, reply: 'done', tool: 'claude-code', models: parseModelsFlag(TRIO) }, ctx);
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].aiModels, parseModelsFlag(TRIO));
    assert.equal(bodies[0].aiModel, 'claude-sonnet-5-5');
  });
});

test('markApplied warns on stderr under delegation=auto with one model, not with delegation=off', async () => {
  const orig = console.error;
  for (const [delegation, expectWarn] of [['auto', true], ['off', false]] as const) {
    const lines: string[] = [];
    console.error = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      await withRepo(delegation, async ({ ctx }) => {
        await markApplied({ id: 5, reply: 'r', models: parseModelsFlag('claude-opus-5-5=implementer') }, ctx);
      });
    } finally {
      console.error = orig;
    }
    assert.equal(lines.some((l) => /Delegation is on/.test(l)), expectWarn, delegation);
  }
});

test('markApplied --dry-run prints the models it would record', async () => {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    await withRepo('off', async ({ ctx, bodies }) => {
      await markApplied({ id: 5, reply: 'r', dryRun: true, models: parseModelsFlag(TRIO) }, ctx);
      assert.equal(bodies.length, 0);
    });
  } finally {
    console.log = orig;
  }
  assert.ok(lines.some((l) => l.includes('[dry-run] Models: claude-opus-5-5=planner, claude-sonnet-5-5=implementer')));
});

test('markFailed sends aiModels + aiModel', async () => {
  await withRepo('off', async ({ ctx, bodies }) => {
    await markFailed(5, 'nope', ctx, 'claude-code', parseModelsFlag('a1=planner,b1=implementer'));
    assert.deepEqual(bodies[0].aiModels, [
      { model: 'a1', role: 'planner' },
      { model: 'b1', role: 'implementer' },
    ]);
    assert.equal(bodies[0].aiModel, 'b1');
  });
});

test('resolveModels: explicit --models replaces env fallbacks', () => {
  const env = { PINSAY_AI_MODEL: 'stale-model', PINSAY_AI_MODELS: 'stale2=planner' } as NodeJS.ProcessEnv;
  assert.deepEqual(resolveModels({ models: 'a=planner,b=implementer' }, env).map((e) => e.model), ['a', 'b']);
  assert.deepEqual(resolveModels({}, env).map((e) => e.model), ['stale2', 'stale-model']);
});

test('resolveModelsFromArgs: explicit models/model replace env fallbacks', () => {
  const env = { PINSAY_AI_MODEL: 'stale-model' } as NodeJS.ProcessEnv;
  assert.deepEqual(resolveModelsFromArgs({ models: [{ model: 'a', role: 'planner' }] }, env).map((e) => e.model), ['a']);
  assert.deepEqual(resolveModelsFromArgs({}, env).map((e) => e.model), ['stale-model']);
});
