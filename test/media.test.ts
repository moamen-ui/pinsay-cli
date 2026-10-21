import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import {
  saveCommentMedia,
  pruneMedia,
  deleteCommentMedia,
  mediaFileName,
  extensionFor,
  MAX_MEDIA_BYTES,
} from '../src/apply/media.js';
import type { CommentMedia } from '../src/apply/types.js';

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

const FILES: Record<string, string> = {
  '/files/shot.png': 'S',
  '/files/a.png': 'AA',
  '/files/s1.png': '1',
  '/files/s2.png': '22',
  '/files/v1.webm': 'VVV',
  '/files/i1.png': 'IMG1',
  '/files/i2.jpg': 'IMG2',
};

function fileHandler(counter?: { n: number }) {
  return (req: any, res: any) => {
    if (counter) counter.n++;
    const body = FILES[req.url ?? ''];
    if (body !== undefined) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };
}

function item(partial: Partial<CommentMedia> & Pick<CommentMedia, 'kind'>): CommentMedia {
  return { url: null, contentType: 'image/png', sizeBytes: 0, ordinal: 0, available: true, ...partial };
}

function fullComment(url: string) {
  return {
    number: 12,
    screenshotUrl: `${url}/files/shot.png`,
    media: [
      item({ kind: 'annotation', url: `${url}/files/a.png`, sizeBytes: 2 }),
      item({ kind: 'step', url: `${url}/files/s1.png`, sizeBytes: 1, ordinal: 1 }),
      item({ kind: 'step', url: `${url}/files/s2.png`, sizeBytes: 2, ordinal: 2 }),
      item({
        kind: 'audio',
        url: `${url}/files/v1.webm`,
        contentType: 'audio/webm',
        sizeBytes: 3,
        ordinal: 1,
        transcript: 'hello',
        transcriptSource: 'browser',
      }),
    ],
  };
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

test('saves screenshot, annotation, steps and voices with their names', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const stub = await stubServer(fileHandler());
  try {
    const result = await saveCommentMedia(fullComment(stub.url), { root, projectKey: 'web', server: stub.url });

    const dir = join(root, '.pinsay', 'media', 'web', '12');
    assert.equal(await fs.readFile(join(dir, 'screenshot.png'), 'utf8'), 'S');
    assert.equal(await fs.readFile(join(dir, 'annotation.png'), 'utf8'), 'AA');
    assert.equal(await fs.readFile(join(dir, 'step-01.png'), 'utf8'), '1');
    assert.equal(await fs.readFile(join(dir, 'step-02.png'), 'utf8'), '22');
    assert.equal(await fs.readFile(join(dir, 'voice-01.webm'), 'utf8'), 'VVV');

    assert.equal(result.screenshot?.path, join(dir, 'screenshot.png'));
    assert.equal(result.screenshot?.error, undefined);
    assert.equal(result.media[0].path, join(dir, 'annotation.png'));
    assert.equal(result.media[1].path, join(dir, 'step-01.png'));
    assert.equal(result.media[2].path, join(dir, 'step-02.png'));
    assert.equal(result.media[3].path, join(dir, 'voice-01.webm'));
    assert.equal(result.media[3].transcript, 'hello');
    assert.equal(result.media[3].transcriptSource, 'browser');
  } finally {
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('creates .pinsay/.gitignore when missing', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const stub = await stubServer(fileHandler());
  try {
    assert.equal(await exists(join(root, '.pinsay', '.gitignore')), false);
    await saveCommentMedia(fullComment(stub.url), { root, projectKey: 'web', server: stub.url });

    const content = await fs.readFile(join(root, '.pinsay', '.gitignore'), 'utf8');
    assert.ok(content.split(/\r?\n/).includes('*'), '.pinsay/.gitignore must contain a "*" line');
  } finally {
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('saves comment and reply images as image-NN', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const stub = await stubServer(fileHandler());
  try {
    const result = await saveCommentMedia(
      {
        number: 14,
        media: [item({ kind: 'image', ordinal: 1, url: `${stub.url}/files/i1.png`, sizeBytes: 4 })],
        replies: [
          {
            id: 7,
            media: [
              item({ kind: 'image', ordinal: 1, url: `${stub.url}/files/i2.jpg`, contentType: 'image/jpeg', sizeBytes: 4 }),
            ],
          },
        ],
      },
      { root, projectKey: 'web', server: stub.url },
    );

    const dir = join(root, '.pinsay', 'media', 'web', '14');
    assert.equal(await fs.readFile(join(dir, 'image-01.png'), 'utf8'), 'IMG1');
    assert.equal(await fs.readFile(join(dir, 'reply-7', 'image-01.jpg'), 'utf8'), 'IMG2');

    assert.equal(result.media[0].path, join(dir, 'image-01.png'));
    assert.equal(result.replies[0].media[0].path, join(dir, 'reply-7', 'image-01.jpg'));
  } finally {
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reply media go under reply-<id> or reply-p<position>', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const stub = await stubServer(fileHandler());
  try {
    const result = await saveCommentMedia(
      {
        number: 5,
        replies: [
          { id: 7, media: [item({ kind: 'annotation', url: `${stub.url}/files/a.png`, sizeBytes: 2 })] },
          { media: [] },
          {
            media: [
              item({
                kind: 'audio',
                url: `${stub.url}/files/v1.webm`,
                contentType: 'audio/webm',
                sizeBytes: 3,
                ordinal: 1,
              }),
            ],
          },
        ],
      },
      { root, projectKey: 'web', server: stub.url },
    );

    const dir = join(root, '.pinsay', 'media', 'web', '5');
    assert.equal(await fs.readFile(join(dir, 'reply-7', 'annotation.png'), 'utf8'), 'AA');
    assert.equal(await fs.readFile(join(dir, 'reply-p3', 'voice-01.webm'), 'utf8'), 'VVV');

    assert.equal(result.replies.length, 2);
    assert.equal(result.replies[0].folder, 'reply-7');
    assert.equal(result.replies[0].replyId, 7);
    assert.equal(result.replies[0].position, 1);
    assert.equal(result.replies[1].folder, 'reply-p3');
    assert.equal(result.replies[1].replyId, undefined);
    assert.equal(result.replies[1].position, 3);
  } finally {
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('skips a file already there with the same size', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const counter = { n: 0 };
  const stub = await stubServer(fileHandler(counter));
  try {
    await saveCommentMedia(fullComment(stub.url), { root, projectKey: 'web', server: stub.url });
    const afterFirst = counter.n;

    await saveCommentMedia(fullComment(stub.url), { root, projectKey: 'web', server: stub.url });
    assert.equal(counter.n, afterFirst, 'no new request when the file is already there with the same size');
  } finally {
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unavailable item is reported, not fetched', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const counter = { n: 0 };
  const stub = await stubServer(fileHandler(counter));
  try {
    const result = await saveCommentMedia(
      { number: 9, media: [item({ kind: 'annotation', url: null, available: false })] },
      { root, projectKey: 'web', server: stub.url },
    );

    assert.equal(result.media[0].path, null);
    assert.equal(result.media[0].error, 'no longer available');
    assert.equal(counter.n, 0);
  } finally {
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('redirect is refused', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const stub = await stubServer((req, res) => {
    if (req.url === '/files/r.png') {
      res.writeHead(302, { location: 'http://example.invalid/x' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const result = await saveCommentMedia(
      { number: 8, media: [item({ kind: 'annotation', url: `${stub.url}/files/r.png`, sizeBytes: 1 })] },
      { root, projectKey: 'web', server: stub.url },
    );

    assert.equal(result.media[0].path, null);
    assert.equal(result.media[0].error, 'redirect refused');
    assert.equal(await exists(join(result.dir, 'annotation.png')), false);
  } finally {
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP error is reported, never thrown', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const stub = await stubServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    const result = await saveCommentMedia(
      { number: 8, media: [item({ kind: 'annotation', url: `${stub.url}/files/missing.png`, sizeBytes: 1 })] },
      { root, projectKey: 'web', server: stub.url },
    );

    assert.equal(result.media[0].path, null);
    assert.equal(result.media[0].error, 'HTTP 404');
  } finally {
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('token only to the server origin; off-origin media is not fetched', async () => {
  const root1 = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const root2 = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const seen: Array<string | undefined> = [];
  const stub = await stubServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('X');
  });
  try {
    await saveCommentMedia(
      { number: 1, media: [item({ kind: 'annotation', url: `${stub.url}/files/x.png`, sizeBytes: 1 })] },
      { root: root1, projectKey: 'web', server: stub.url, token: 't' },
    );
    assert.equal(seen.at(-1), 'Bearer t');

    const before = seen.length;
    const off = await saveCommentMedia(
      { number: 1, media: [item({ kind: 'annotation', url: `${stub.url}/files/x.png`, sizeBytes: 1 })] },
      { root: root2, projectKey: 'web', server: 'http://127.0.0.1:1', token: 't' },
    );
    assert.equal(seen.length, before, 'the off-origin url is not fetched');
    assert.equal(off.media[0].path, null);
    assert.equal(off.media[0].error, 'off-origin url');
  } finally {
    await stub.close();
    await fs.rm(root1, { recursive: true, force: true });
    await fs.rm(root2, { recursive: true, force: true });
  }
});

test('nothing to save creates no folder', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  try {
    const result = await saveCommentMedia(
      { number: 3, media: [] },
      { root, projectKey: 'web', server: 'http://127.0.0.1:1' },
    );

    assert.equal(result.screenshot, null);
    assert.deepEqual(result.media, []);
    assert.deepEqual(result.replies, []);
    assert.equal(await exists(join(root, '.pinsay', 'media')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('pruneMedia removes folders older than 7 days only', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  try {
    const base = join(root, '.pinsay', 'media', 'web');
    await fs.mkdir(join(base, '1'), { recursive: true });
    await fs.mkdir(join(base, '2'), { recursive: true });
    await fs.writeFile(join(base, '1', 'annotation.png'), 'A');
    await fs.writeFile(join(base, '2', 'annotation.png'), 'A');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(join(base, '1'), old, old);

    await pruneMedia(root);

    assert.equal(await exists(join(base, '1')), false, '8-day-old folder must be pruned');
    assert.equal(await exists(join(base, '2')), true, 'fresh folder must stay');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deleteCommentMedia removes one comment folder', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  try {
    const base = join(root, '.pinsay', 'media', 'web');
    await fs.mkdir(join(base, '5'), { recursive: true });
    await fs.mkdir(join(base, '6'), { recursive: true });
    await fs.writeFile(join(base, '5', 'annotation.png'), 'A');
    await fs.writeFile(join(base, '6', 'annotation.png'), 'A');

    await deleteCommentMedia(root, 'web', 5);

    assert.equal(await exists(join(base, '5')), false);
    assert.equal(await exists(join(base, '6')), true);
    await deleteCommentMedia(root, 'web', 5); // no throw when already gone
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('mediaFileName and extensionFor', async () => {
  assert.equal(extensionFor('audio/mp4', null, 'webm'), 'm4a');
  assert.equal(extensionFor(null, 'https://h/x/y.jpeg?sig=1', 'png'), 'jpeg');
  assert.equal(extensionFor(null, null, 'png'), 'png');
  assert.equal(mediaFileName(item({ kind: 'video', url: 'https://x/v.mp4', contentType: 'video/mp4' })), null);
  assert.equal(mediaFileName(item({ kind: 'image', ordinal: 2, contentType: 'image/webp' })), 'image-02.webp');
  assert.equal(mediaFileName(item({ kind: 'image', ordinal: 1, contentType: 'image/gif' })), 'image-01.gif');
});

test('off-origin url is refused without a fetch', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response('X');
  }) as typeof fetch;
  try {
    const result = await saveCommentMedia(
      { number: 3, media: [item({ kind: 'annotation', url: 'https://evil.example/a.png', sizeBytes: 1 })] },
      { root, projectKey: 'web', server: 'https://app.example', fetchImpl },
    );
    assert.equal(result.media[0].path, null);
    assert.equal(result.media[0].error, 'off-origin url');
    assert.equal(calls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('content-length over the cap is refused', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const fetchImpl = (async () =>
    new Response('X', { headers: { 'content-length': String(MAX_MEDIA_BYTES + 1) } })) as typeof fetch;
  try {
    const result = await saveCommentMedia(
      { number: 3, media: [item({ kind: 'annotation', url: 'https://app.example/a.png', sizeBytes: 1 })] },
      { root, projectKey: 'web', server: 'https://app.example', fetchImpl },
    );
    assert.equal(result.media[0].error, 'too large');
    assert.equal(await exists(join(result.dir, 'annotation.png')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a streamed body over the cap is refused, no file', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (sent > 30) return controller.close();
          sent++;
          controller.enqueue(chunk);
        },
      }),
    )) as typeof fetch;
  try {
    const result = await saveCommentMedia(
      { number: 3, media: [item({ kind: 'annotation', url: 'https://app.example/a.png', sizeBytes: 0 })] },
      { root, projectKey: 'web', server: 'https://app.example', fetchImpl },
    );
    assert.equal(result.media[0].error, 'too large');
    assert.equal(await exists(join(result.dir, 'annotation.png')), false);
    assert.equal(await exists(join(result.dir, 'annotation.png.part')), false);
    assert.ok(sent < 30, 'the reader stopped early');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a truncated body is a size mismatch, no file and no .part', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinsay-media-'));
  const fetchImpl = (async () => new Response('12345678')) as typeof fetch;
  try {
    const result = await saveCommentMedia(
      { number: 3, media: [item({ kind: 'annotation', url: 'https://app.example/a.png', sizeBytes: 10 })] },
      { root, projectKey: 'web', server: 'https://app.example', fetchImpl },
    );
    assert.equal(result.media[0].error, 'size mismatch');
    assert.equal(await exists(join(result.dir, 'annotation.png')), false);
    assert.equal(await exists(join(result.dir, 'annotation.png.part')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extensionFor ignores an unknown URL extension', async () => {
  assert.equal(extensionFor('application/octet-stream', 'https://h/x/evil.sh', 'png'), 'png');
});
