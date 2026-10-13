import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import {
  parseCommentNumber,
  fetchCommentByNumber,
  CommentNotFoundError,
} from '../src/lib/comment-ref.js';
import { toAiCommentView } from '../src/apply/projection.js';

test('parseCommentNumber accepts "12", "#12" and padded input', () => {
  assert.equal(parseCommentNumber('12'), 12);
  assert.equal(parseCommentNumber('#12'), 12);
  assert.equal(parseCommentNumber(' 7 '), 7);
});

test('parseCommentNumber rejects 0, negatives, decimals and non-numbers', () => {
  assert.equal(parseCommentNumber(0), null);
  assert.equal(parseCommentNumber('0'), null);
  assert.equal(parseCommentNumber('-1'), null);
  assert.equal(parseCommentNumber('1.5'), null);
  assert.equal(parseCommentNumber('id:5'), null);
  assert.equal(parseCommentNumber('abc'), null);
  assert.equal(parseCommentNumber(''), null);
});

async function stubServer(
  handler: (req: any, res: any) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('fetchCommentByNumber calls /api/projects/{key}/comments/by-number/{n} and returns the comment', async () => {
  const seen: string[] = [];
  const stub = await stubServer((req, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: true, data: { id: 55, number: 3, body: 'Fix the header' } }));
  });

  try {
    const comment = await fetchCommentByNumber<any>(stub.url, 'test-token', 'my app', 3);
    assert.equal(seen[0], '/api/projects/my%20app/comments/by-number/3');
    assert.equal(comment.id, 55);
    assert.equal(comment.number, 3);
  } finally {
    await stub.close();
  }
});

test('fetchCommentByNumber throws CommentNotFoundError on 404', async () => {
  const stub = await stubServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isSuccess: false, message: 'Not found' }));
  });

  try {
    await assert.rejects(
      () => fetchCommentByNumber(stub.url, 'test-token', 'my app', 3),
      (err: any) => {
        assert.ok(err instanceof CommentNotFoundError);
        assert.equal(err.message, 'No comment #3 in project my app.');
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test('toAiCommentView maps number and internalId', () => {
  const view = toAiCommentView({ id: 42, number: 7, status: 2, environment: 1, body: 'Fix the header' });
  assert.equal(view.number, 7);
  assert.equal(view.internalId, 42);
});
