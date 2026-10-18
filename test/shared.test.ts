import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promptRef, sharedFromParts, sharedFromApi, withExtraRules } from '../src/apply/shared.js';
import type { AiRuleApplyDto } from '../src/apply/types.js';

const rule = (scope: string, title: string, priority: number, isPersonal = false): AiRuleApplyDto => ({
  title,
  prompt: `p-${title}`,
  scope,
  priority,
  isPersonal,
});

test('promptRef is p_ + first 10 hex of sha256(text NUL prompt)', () => {
  const hex = createHash('sha256').update('Fix\u0000a').digest('hex').slice(0, 10);
  assert.equal(promptRef('Fix', 'a'), `p_${hex}`);
});

test('sharedFromParts numbers common rules first, then Personal rules in item order', () => {
  const ws = rule('Workspace', 'W', 1);
  const pj = rule('Project', 'P', 2);
  const a1 = rule('Personal', 'A1', 4, true);
  const a2 = rule('Personal', 'A2', 4, true);
  const b1 = rule('Personal', 'B1', 4, true);
  const { shared, refs } = sharedFromParts([
    { aiRules: [pj, ws, a1, a2], pickedActions: [] },
    { aiRules: [ws, pj, b1], pickedActions: [] },
  ]);
  assert.deepEqual(shared.aiRules.map((r) => [r.id, r.title, r.appliesTo]), [
    ['r1', 'W', 'all'],
    ['r2', 'P', 'all'],
    ['r3', 'A1', 'author'],
    ['r4', 'A2', 'author'],
    ['r5', 'B1', 'author'],
  ]);
  assert.deepEqual(refs.map((r) => r.aiRuleRefs), [['r3', 'r4'], ['r5']]);
});

test('sharedFromParts: same label with different prompts gives 2 prompts, identical gives 1', () => {
  const two = sharedFromParts([
    { aiRules: [], pickedActions: [{ text: 'Fix', prompt: 'a' }] },
    { aiRules: [], pickedActions: [{ text: 'Fix', prompt: 'b' }] },
  ]);
  assert.equal(two.shared.prompts.length, 2);
  const one = sharedFromParts([
    { aiRules: [], pickedActions: [{ text: 'Fix', prompt: 'a' }] },
    { aiRules: [], pickedActions: [{ text: 'Fix', prompt: 'a' }] },
  ]);
  assert.equal(one.shared.prompts.length, 1);
  assert.deepEqual(one.refs[0].actionIds, one.refs[1].actionIds);
});

test('sharedFromApi reads the dictionaries and per-item refs; null without them', () => {
  const res = {
    aiRules: {
      r2: { title: 'P', prompt: 'pp', scope: 'Personal', priority: 4, isPersonal: true },
      r1: { title: 'W', prompt: 'pw', scope: 'Workspace', priority: 1, isPersonal: false },
    },
    prompts: { p_0123456789: { text: 'Fix', prompt: 'a' } },
    items: [{ aiRuleRefs: ['r2'], pickedActions: [{ text: 'Fix', prompt: '', ref: 'p_0123456789' }] }],
  };
  const parts = sharedFromApi(res, 1)!;
  assert.deepEqual(parts.shared.aiRules.map((r) => [r.id, r.appliesTo]), [['r1', 'all'], ['r2', 'author']]);
  assert.deepEqual(parts.shared.prompts, [{ id: 'p_0123456789', text: 'Fix', prompt: 'a' }]);
  assert.deepEqual(parts.refs, [{ aiRuleRefs: ['r2'], actionIds: ['p_0123456789'] }]);
  assert.equal(sharedFromApi({ items: [] }, 0), null);
  assert.equal(sharedFromApi({ aiRules: [] }, 0), null);
});

test('withExtraRules adds a missing rule as the next id and skips a present one', () => {
  const { shared } = sharedFromParts([{ aiRules: [rule('Workspace', 'W', 1)], pickedActions: [] }]);
  const out = withExtraRules(shared, [rule('Workspace', 'W', 1), rule('Role', 'R', 3)]);
  assert.deepEqual(out.aiRules.map((r) => [r.id, r.title]), [['r1', 'W'], ['r2', 'R']]);
  assert.equal(shared.aiRules.length, 1);
});
