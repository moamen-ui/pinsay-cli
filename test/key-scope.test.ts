import { test } from 'node:test';
import * as assert from 'node:assert';
import { scopeFromFlags } from '../src/key-scope.js';

test('scopeFromFlags: --scope global|repo, any case', () => {
  assert.deepStrictEqual(scopeFromFlags({ scope: 'global' }), { scope: 'global' });
  assert.deepStrictEqual(scopeFromFlags({ scope: 'REPO' }), { scope: 'repo' });
});

test('scopeFromFlags: --local-credentials means repo; nothing means undecided', () => {
  assert.deepStrictEqual(scopeFromFlags({ 'local-credentials': true }), { scope: 'repo' });
  assert.deepStrictEqual(scopeFromFlags({}), {});
});

test('scopeFromFlags: an unknown --scope is an error naming the valid values', () => {
  assert.match(scopeFromFlags({ scope: 'machine' }).error ?? '', /Invalid --scope "machine". Valid values: global, repo\./);
});

test('scopeFromFlags: --global means global (0.9.0)', () => {
  assert.deepStrictEqual(scopeFromFlags({ global: true }), { scope: 'global' });
  assert.deepStrictEqual(scopeFromFlags({ global: true, scope: 'repo' }), { scope: 'repo' }, 'an explicit --scope wins');
});
