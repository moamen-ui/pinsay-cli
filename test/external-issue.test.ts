import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalIssueTag } from '../src/lib/external-issue.js';
import { buildApplyPrompt } from '../src/apply/prompt.js';
import type { ApplyProjectContext, QueueItem } from '../src/apply/types.js';

test('externalIssueTag shows [GitHub #n] for a GitHub issue link', () => {
  assert.equal(externalIssueTag({ externalIssue: { provider: 'github', number: 89 } }), '[GitHub #89]');
  assert.equal(externalIssueTag({ externalIssue: { provider: 'github', number: '89' } }), '[GitHub #89]');
});

test('externalIssueTag ignores other providers and missing links', () => {
  assert.equal(externalIssueTag({ externalIssue: { provider: 'linear', number: 89 } }), '');
  assert.equal(externalIssueTag({ externalIssue: null }), '');
  assert.equal(externalIssueTag({}), '');
  assert.equal(externalIssueTag(null), '');
  assert.equal(externalIssueTag(undefined), '');
});

test('externalIssueTag refuses numbers that are not positive integers', () => {
  for (const number of [0, -1, 1.5, '89; rm -rf']) {
    assert.equal(externalIssueTag({ externalIssue: { provider: 'github', number } }), '');
  }
});

test('externalIssueTag shows [Jira KEY] for a Jira issue link', () => {
  assert.equal(externalIssueTag({ externalIssue: { provider: 'jira', key: 'WEB-123', state: 'open' } }), '[Jira WEB-123]');
});

test('externalIssueTag refuses Jira keys that do not match the pattern', () => {
  for (const key of ['web-123', 'WEB-1\n', 'WEB-1]', 'WEB-0', 'WEB', 42]) {
    assert.equal(externalIssueTag({ externalIssue: { provider: 'jira', key, state: 'open' } }), '');
  }
});

test('externalIssueTag prints nothing for a Jira issue deleted in Jira', () => {
  assert.equal(externalIssueTag({ externalIssue: { provider: 'jira', key: 'WEB-123', state: 'deleted' } }), '');
});

test('externalIssueTag ignores providers other than github and jira', () => {
  assert.equal(externalIssueTag({ externalIssue: { provider: 'linear', key: 'WEB-123', state: 'open' } }), '');
});

test('buildApplyPrompt puts the GitHub tag on the item heading', () => {
  const context: ApplyProjectContext = {
    productName: 'PinSay',
    projectName: 'My App',
    projectKey: 'my-app',
    commitStyle: 'Separate',
    stack: {},
  };
  const item: QueueItem = {
    id: 9,
    number: 1,
    status: 2,
    environment: 1,
    body: 'Fix this',
    authorName: 'Sam',
    authorKind: 'member',
    createdAt: '2026-01-01T00:00:00Z',
    element: {},
    replies: [],
    pickedActions: [],
    aiRules: [],
    isBugReport: false,
    externalIssue: { provider: 'github', number: 89, url: 'https://github.com/o/r/issues/89', state: 'open' },
  };
  const prompt = buildApplyPrompt([item], context);
  assert.ok(prompt.includes('### #1 — '));
  assert.ok(prompt.includes('[GitHub #89]'));
});
