import { after, before, test } from 'node:test';
import * as assert from 'node:assert';
import { nextStepText } from '../src/init/next-step.js';

let prevNoColor: string | undefined;
before(() => {
  prevNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
});
after(() => {
  if (prevNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = prevNoColor;
});

test('extension with a store URL', () => {
  assert.equal(
    nextStepText({ kind: 'extension', storeUrl: 'https://pinsay.dev/extension' }, 'PinSay'),
    'Next: install the PinSay Chrome extension, open your app and click the PinSay icon → https://pinsay.dev/extension',
  );
});

test('extension without a store URL (white-label)', () => {
  assert.equal(
    nextStepText({ kind: 'extension', storeUrl: '' }, 'PinSay'),
    'Next: ask your admin for the PinSay Chrome extension link (PinSay → Settings → Extension).',
  );
});

test('embedded this run, or already in the code', () => {
  assert.equal(nextStepText({ kind: 'embedded' }, 'PinSay'), 'Next: start your app and click the PinSay button.');
});

test('a stack the skill must embed', () => {
  assert.equal(
    nextStepText({ kind: 'skill', tool: 'cursor' }, 'PinSay'),
    'Next: in cursor, run /pinsay-init to add the widget.',
  );
});

test('join: the repo is already set up', () => {
  assert.equal(nextStepText({ kind: 'join' }, 'PinSay'), 'Next: tell your AI agent: Apply the new PinSay comments');
});
