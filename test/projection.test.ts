import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAiCommentView } from '../src/apply/projection.js';
import type { SavedCommentMedia } from '../src/apply/types.js';

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
    aiRules: [{ title: 'R', prompt: 'P', scope: 'Role', priority: 3, isPersonal: false, roleName: 'Backend', extra: 'x' }],
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
    'internalId',
    'isBugReport',
    'media',
    'number',
    'pickedActions',
    'aiRules',
    'replies',
    'status',
    'textSource',
  ].sort();

  const expectedElementKeys = [
    'appliedCssRules',
    'classes',
    'deviceType',
    'pageTitle',
    'pageUrl',
    'parentInfo',
    'route',
    'screenshotPath',
    'screenshotUrl',
    'selector',
    'snapshot',
    'sourcePath',
    'viewportHeight',
    'viewportWidth',
  ].sort();

  const expectedReplyKeys = ['authorName', 'body', 'isAi', 'media'].sort();
  const expectedPickedActionKeys = ['prompt', 'text'].sort();

  assert.deepEqual(Object.keys(projected).sort(), expectedTopLevelKeys);
  assert.deepEqual(Object.keys(projected.element).sort(), expectedElementKeys);
  assert.deepEqual(Object.keys(projected.replies[0]).sort(), expectedReplyKeys);
  assert.deepEqual(Object.keys(projected.pickedActions[0]).sort(), expectedPickedActionKeys);
  assert.deepEqual(Object.keys(projected.aiRules[0]).sort(), ['isPersonal', 'priority', 'prompt', 'roleName', 'scope', 'title']);

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

test('toAiCommentView: a raw comment without aiRules projects aiRules: []', () => {
  assert.deepEqual(toAiCommentView({ id: 1, body: 'x' }).aiRules, []);
});

test('projects media with saved paths and untrusted transcripts', () => {
  const raw = {
    id: 5,
    number: 5,
    body: 'b',
    element: {},
    media: [
      { kind: 'annotation', ordinal: 1, url: 'https://x/a.png', contentType: 'image/png', sizeBytes: 10, available: true },
      { kind: 'step', ordinal: 1, url: 'https://x/s1.png', contentType: 'image/png', sizeBytes: 11, available: true },
      {
        kind: 'audio', ordinal: 1, url: 'https://x/v1.webm', contentType: 'audio/webm', sizeBytes: 12,
        durationMs: 3200, transcript: 'make it blue', transcriptSource: 'browser', available: true,
      },
    ],
    replies: [
      {
        body: 'still red',
        media: [{ kind: 'audio', ordinal: 1, url: 'https://x/r1.webm', contentType: 'audio/webm', sizeBytes: 13, transcript: 'x', available: true }],
      },
    ],
  };

  const saved: SavedCommentMedia = {
    dir: '/r',
    screenshot: null,
    media: [
      { kind: 'annotation', ordinal: 1, url: 'https://x/a.png', contentType: 'image/png', sizeBytes: 10, available: true, path: '/r/a.png' },
      { kind: 'step', ordinal: 1, url: 'https://x/s1.png', contentType: 'image/png', sizeBytes: 11, available: true, path: '/r/s1.png' },
      { kind: 'audio', ordinal: 1, url: 'https://x/v1.webm', contentType: 'audio/webm', sizeBytes: 12, durationMs: 3200, transcript: 'make it blue', transcriptSource: 'browser', available: true, path: '/r/v1.webm' },
    ],
    replies: [
      {
        folder: 'reply-p1',
        position: 1,
        media: [
          { kind: 'audio', ordinal: 1, url: 'https://x/r1.webm', contentType: 'audio/webm', sizeBytes: 13, transcript: 'x', available: true, path: '/r/reply-p1/v1.webm' },
        ],
      },
    ],
  };

  const view = toAiCommentView(raw, undefined, saved);
  assert.equal(view.media[2].path, '/r/v1.webm');
  assert.deepEqual(view.media[2].transcript, { untrusted: true, value: 'make it blue' });
  assert.equal(view.replies[0].media[0].path, '/r/reply-p1/v1.webm');

  // Without `saved` every path is null (transcripts still project).
  const unsaved = toAiCommentView(raw);
  assert.ok(unsaved.media.every((m) => m.path === null));
  assert.ok(unsaved.replies[0].media.every((m) => m.path === null));

  // A raw with no `media` gives media: [].
  assert.deepEqual(toAiCommentView({ id: 1, body: 'x', replies: [] }).media, []);
});
