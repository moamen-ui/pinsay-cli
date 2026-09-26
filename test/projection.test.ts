import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAiCommentView } from '../src/apply/projection.js';

test('toAiCommentView emits exactly the whitelisted keys and drops sensitive fields', () => {
  const rawCommentResponse = {
    id: 42,
    status: 2,
    environment: 1,
    body: 'Change header color to indigo',
    authorName: 'Alice',
    authorId: '11111111-2222-3333-4444-555555555555',
    ownerId: '99999999-8888-7777-6666-555555555555',
    hasPayloadFlag: true,
    payloadFlags: ['FLAG_SECRET_TOKEN', 'SUSPICIOUS_PAYLOAD'],
    editedBy: 'attacker-or-admin',
    editedAt: '2026-06-20T12:00:00Z',
    isPrivate: false,
    isBugReport: true,
    createdAt: '2026-06-19T10:00:00Z',
    appliedAt: null,
    appliedBy: null,
    appliedByLabel: null,
    commitUrl: null,
    element: {
      selector: '#main-header',
      snapshot: '<header id="main-header">Title</header>',
      classes: 'bg-blue-500 text-white',
      computedStyles: '{"color":"rgb(255,255,255)"}',
      appliedCssRules: '[{"selector":"header","styles":"background: blue"}]',
      sourcePath: 'src/Header.tsx',
      parentInfo: 'div#root',
      screenshotUrl: 'https://example.com/secret/screenshot.png',
      pageUrl: 'http://localhost:3000/dashboard',
      route: '/dashboard',
      pageTitle: 'Dashboard',
      viewportWidth: 1280,
      viewportHeight: 720,
      deviceType: 'desktop',
      devicePixelRatio: 2,
      userAgent: 'Mozilla/5.0 Chrome/120',
      internalDomTree: { hidden: 'value' },
    },
    replies: [
      {
        id: 101,
        authorId: '22222222-3333-4444-5555-666666666666',
        authorName: 'Bob',
        body: 'Looks good to me',
        createdAt: '2026-06-19T11:00:00Z',
        isAi: false,
        internalModerationScore: 0.99,
      },
    ],
    pickedActions: [
      {
        text: 'Apply indigo theme',
        prompt: 'Replace bg-blue-500 with bg-indigo-600',
        internalAdminId: 123,
      },
    ],
    pageContext: {
      secretTokens: ['bearer-12345'],
      dbDumps: { leaked: true },
    },
  };

  const projected = toAiCommentView(rawCommentResponse);

  // Exact whitelist keys comparison
  const expectedTopLevelKeys = [
    'appliedAt',
    'appliedByLabel',
    'authorName',
    'body',
    'commitUrl',
    'createdAt',
    'element',
    'environment',
    'id',
    'isBugReport',
    'pickedActions',
    'replies',
    'status',
  ].sort();

  const expectedElementKeys = [
    'appliedCssRules',
    'classes',
    'deviceType',
    'pageTitle',
    'pageUrl',
    'parentInfo',
    'route',
    'selector',
    'snapshot',
    'sourcePath',
    'viewportHeight',
    'viewportWidth',
  ].sort();

  const expectedReplyKeys = ['authorName', 'body', 'isAi'].sort();
  const expectedPickedActionKeys = ['prompt', 'text'].sort();

  assert.deepEqual(Object.keys(projected).sort(), expectedTopLevelKeys);
  assert.deepEqual(Object.keys(projected.element).sort(), expectedElementKeys);
  assert.deepEqual(Object.keys(projected.replies[0]).sort(), expectedReplyKeys);
  assert.deepEqual(Object.keys(projected.pickedActions[0]).sort(), expectedPickedActionKeys);

  // Body untrusted structure
  assert.equal(projected.body.value, 'Change header color to indigo');
  assert.equal(projected.body.untrusted, true);
  assert.equal(projected.replies[0].body.value, 'Looks good to me');
  assert.equal(projected.replies[0].body.untrusted, true);

  // Deep scan: forbidden fields must not exist anywhere at any depth
  const jsonStr = JSON.stringify(projected);
  assert.ok(!jsonStr.includes('hasPayloadFlag'), 'hasPayloadFlag must be absent');
  assert.ok(!jsonStr.includes('payloadFlags'), 'payloadFlags must be absent');
  assert.ok(!jsonStr.includes('authorId'), 'authorId must be absent');
  assert.ok(!jsonStr.includes('ownerId'), 'ownerId must be absent');
  assert.ok(!jsonStr.includes('editedBy'), 'editedBy must be absent');
  assert.ok(!jsonStr.includes('secretTokens'), 'pageContext secrets must be absent');
});
