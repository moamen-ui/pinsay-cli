import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  scopeFromFlags,
  decideKeyScope,
  KEY_SCOPE_QUESTION,
  KEY_SCOPE_GLOBAL,
  KEY_SCOPE_REPO,
} from '../src/key-scope.js';

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

test('decideKeyScope: a flag wins, a terminal asks, otherwise global', () => {
  assert.strictEqual(decideKeyScope('repo', true), 'repo');
  assert.strictEqual(decideKeyScope('global', true), 'global');
  assert.strictEqual(decideKeyScope(undefined, true), 'ask');
  assert.strictEqual(decideKeyScope(undefined, false), 'global');
});

test('the shared question names the pinsay folder, never pointer', () => {
  assert.strictEqual(KEY_SCOPE_QUESTION, 'Where should this API key be stored?');
  assert.match(KEY_SCOPE_GLOBAL, /~\/\.config\/pinsay\/credentials\.json/);
  assert.match(KEY_SCOPE_REPO, /\.pinsay\/credentials\.env/);
  assert.doesNotMatch(KEY_SCOPE_GLOBAL + KEY_SCOPE_REPO, /pointer/);
});
