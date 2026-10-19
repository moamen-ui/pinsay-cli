import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatus, statusLabel, unknownStatusError, type StatusCatalogItem } from '../src/statuses.js';

const catalog: StatusCatalogItem[] = [
  { value: 1, label: 'Open', key: 'open', isCustom: false },
  { value: 5, label: 'Needs info', key: 'c12', isCustom: true, customStatusId: 12 },
  { value: 5, label: 'QA', key: 'c13', isCustom: true, customStatusId: 13 },
];

test('resolveStatus: built-in keys, aliases and numbers', () => {
  assert.deepEqual(resolveStatus('open', catalog), { key: 'open', status: 1, label: 'Open' });
  assert.equal(resolveStatus(' READY ', catalog)?.status, 2);
  assert.equal(resolveStatus('readytoapply')?.key, 'ready');
  assert.equal(resolveStatus('completed')?.key, 'applied');
  assert.equal(resolveStatus('3')?.key, 'applied');
  assert.equal(resolveStatus('archived')?.status, 4);
});

test('resolveStatus: custom by key and by label, case-insensitive', () => {
  assert.deepEqual(resolveStatus('c12', catalog), { key: 'c12', status: 5, label: 'Needs info' });
  assert.equal(resolveStatus('C13', catalog)?.key, 'c13');
  assert.equal(resolveStatus('needs INFO', catalog)?.key, 'c12');
  assert.equal(resolveStatus('qa', catalog)?.key, 'c13');
});

test('resolveStatus: unknown, and old server catalogs without keys', () => {
  assert.equal(resolveStatus('nope', catalog), undefined);
  assert.equal(resolveStatus('', catalog), undefined);
  assert.equal(resolveStatus('Needs info', [{ value: 5, label: 'Needs info' }]), undefined);
  assert.equal(resolveStatus('ready', [{ value: 2, label: 'Ready' }])?.status, 2);
});

test('unknownStatusError lists built-ins and customs with label and key', () => {
  assert.equal(
    unknownStatusError('nope', catalog),
    'Unknown status "nope". This workspace\'s statuses: open, ready, applied, archived, "Needs info" (c12), "QA" (c13)',
  );
});

test('statusLabel fallbacks', () => {
  assert.equal(statusLabel({ status: 5, customStatus: { label: 'Needs info' } }), 'Needs info');
  assert.equal(statusLabel({ status: 5, statusKey: 'c12' }, catalog), 'Needs info');
  assert.equal(statusLabel({ status: 2 }), 'ReadyToApply');
  assert.equal(statusLabel({ status: 5, statusKey: 'c99' }, catalog), 'custom');
  assert.equal(statusLabel({ status: 9 }), '9');
});
