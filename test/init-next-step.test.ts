import { after, before, test } from 'node:test';
import * as assert from 'node:assert';
import { nextStepText, otherStoreLines, renderNext } from '../src/init/next-step.js';

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

test('renderNext puts a URL on its own line, indented 6 spaces', () => {
  const text = nextStepText({ kind: 'extension', storeUrl: 'https://pinsay.dev/extension' }, 'PinSay');
  assert.deepEqual(renderNext(text), [
    'Next: install the PinSay Chrome extension, open your app and click the PinSay icon:',
    '      https://pinsay.dev/extension',
    'Check any time: npx pinsay-cli status',
  ]);
  assert.equal(renderNext('Next: start your app and click the PinSay button.')[0], 'Next: start your app and click the PinSay button.');
});

test('every store listed: the Next line keeps Chrome and the others become extra lines', () => {
  const c = {
    kind: 'extension' as const,
    storeUrl: 'https://chromewebstore.google.com/detail/x',
    otherStores: [
      { label: 'Microsoft Edge', url: 'https://microsoftedge.microsoft.com/addons/detail/x' },
      { label: 'Firefox', url: 'https://addons.mozilla.org/firefox/addon/x' },
    ],
  };
  assert.deepEqual(otherStoreLines(c), [
    'Also for Microsoft Edge: https://microsoftedge.microsoft.com/addons/detail/x',
    'Also for Firefox: https://addons.mozilla.org/firefox/addon/x',
  ]);
});

test('only Firefox listed: the Next line points at Firefox and no extra lines follow', () => {
  const c = {
    kind: 'extension' as const,
    storeUrl: '',
    otherStores: [{ label: 'Firefox', url: 'https://addons.mozilla.org/firefox/addon/x' }],
  };
  assert.equal(
    nextStepText(c, 'PinSay'),
    'Next: install the PinSay browser extension, open your app and click the PinSay icon → https://addons.mozilla.org/firefox/addon/x',
  );
  assert.deepEqual(otherStoreLines(c), []);
});

test('renderNext prints the extra store lines dim, before the status hint', () => {
  const c = {
    kind: 'extension' as const,
    storeUrl: 'https://chromewebstore.google.com/detail/x',
    otherStores: [{ label: 'Firefox', url: 'https://addons.mozilla.org/firefox/addon/x' }],
  };
  assert.deepEqual(renderNext(nextStepText(c, 'PinSay'), otherStoreLines(c)), [
    'Next: install the PinSay Chrome extension, open your app and click the PinSay icon:',
    '      https://chromewebstore.google.com/detail/x',
    '      Also for Firefox: https://addons.mozilla.org/firefox/addon/x',
    'Check any time: npx pinsay-cli status',
  ]);
});
