import { test } from 'node:test';
import * as assert from 'node:assert';
import { scopeFromFlags, GLOBAL_KEY_REMOVED } from '../src/key-scope.js';

test('scopeFromFlags: --global and --scope global are rejected (0.10.0)', () => {
  assert.strictEqual(scopeFromFlags({ scope: 'global' }).error, GLOBAL_KEY_REMOVED);
  assert.strictEqual(scopeFromFlags({ scope: 'GLOBAL' }).error, GLOBAL_KEY_REMOVED);
  assert.strictEqual(scopeFromFlags({ global: true }).error, GLOBAL_KEY_REMOVED);
  assert.deepStrictEqual(scopeFromFlags({ global: true, scope: 'repo' }), { explicitRepo: true }, 'an explicit --scope is read first');
});

test('scopeFromFlags: --scope repo and --local-credentials are the old spelling of the only choice', () => {
  assert.deepStrictEqual(scopeFromFlags({ scope: 'repo' }), { explicitRepo: true });
  assert.deepStrictEqual(scopeFromFlags({ scope: 'Repo' }), { explicitRepo: true });
  assert.deepStrictEqual(scopeFromFlags({ 'local-credentials': true }), { explicitRepo: true });
  assert.deepStrictEqual(scopeFromFlags({}), {});
});

test('scopeFromFlags: an unknown --scope is an error naming the valid value', () => {
  assert.match(scopeFromFlags({ scope: 'machine' }).error ?? '', /Invalid --scope "machine". Valid value: repo\./);
});
