import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { hidePinsayFiles } from '../lib/git-exclude.js';
import type { CommentMedia, SavedCommentMedia, SavedMedia, SavedReplyMedia } from './types.js';

/**
 * Rich comments (PLAN § S2): the CLI saves a comment's files under
 * `<root>/.pinsay/media/<projectKey>/<number>/` so the agent can open them by path. `.pinsay/` is hidden from git
 * by `.pinsay/.gitignore` (never the repo's own `.gitignore`, CEO 2026-10-07). A failed download is reported on
 * the item (`error`), never thrown.
 */

export const MEDIA_DIR = join('.pinsay', 'media');
export const MEDIA_MAX_AGE_DAYS = 7;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type MediaSource = {
  number: number;
  screenshotUrl?: string | null;
  media?: CommentMedia[] | null;
  replies?: Array<{ id?: number | null; media?: CommentMedia[] | null }> | null;
};

export type SaveMediaOptions = {
  root: string;
  projectKey: string;
  server: string;
  token?: string;
  /** Tests inject a fetch; defaults to the global one. */
  fetchImpl?: typeof fetch;
};

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

export function extensionFor(contentType: string | null | undefined, url: string | null | undefined, fallback: string): string {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type];
  if (url) {
    try {
      const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url, 'http://x').pathname);
      if (m) return m[1].toLowerCase();
    } catch {
      // not a URL: fall through
    }
  }
  return fallback;
}

function two(n: number): string {
  return String(Math.max(0, Math.trunc(n))).padStart(2, '0');
}

/** The file name an item gets inside its folder; null for a kind this CLI does not know (skipped). */
export function mediaFileName(item: CommentMedia): string | null {
  const kind = String(item.kind ?? '').toLowerCase();
  if (kind === 'annotation') return `annotation.${extensionFor(item.contentType, item.url, 'png')}`;
  if (kind === 'screenshot') return `screenshot.${extensionFor(item.contentType, item.url, 'png')}`;
  if (kind === 'step') return `step-${two(item.ordinal)}.${extensionFor(item.contentType, item.url, 'png')}`;
  if (kind === 'audio') return `voice-${two(item.ordinal)}.${extensionFor(item.contentType, item.url, 'webm')}`;
  return null;
}

export function commentMediaDir(root: string, projectKey: string, number: number): string {
  return join(root, MEDIA_DIR, projectKey, String(number));
}

async function ensureHidden(root: string): Promise<void> {
  const marker = join(root, '.pinsay', '.gitignore');
  const exists = await fs
    .stat(marker)
    .then(() => true)
    .catch(() => false);
  if (!exists) await hidePinsayFiles(root);
}

/** Downloads one URL to `file`. Returns an error text, or null on success (or when the same-size file is there). */
async function download(
  url: string,
  file: string,
  expectedSize: number | null,
  opts: SaveMediaOptions,
): Promise<string | null> {
  let target: URL;
  let serverOrigin: string;
  try {
    serverOrigin = new URL(opts.server).origin;
    target = new URL(url, opts.server);
  } catch {
    return 'invalid url';
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return 'invalid url';

  const have = await fs.stat(file).catch(() => null);
  if (have && have.isFile() && (expectedSize === null ? have.size > 0 : have.size === expectedSize)) return null;

  const headers: Record<string, string> = {};
  if (opts.token && target.origin === serverOrigin) headers['Authorization'] = `Bearer ${opts.token}`;
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(target.toString(), {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    return (err as Error)?.message || 'network error';
  }
  if (res.status >= 300 && res.status < 400) return 'redirect refused';
  if (!res.ok) return `HTTP ${res.status}`;
  try {
    const bytes = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(file, bytes);
  } catch (err) {
    return (err as Error)?.message || 'write failed';
  }
  return null;
}

async function saveItems(items: CommentMedia[], dir: string, opts: SaveMediaOptions): Promise<SavedMedia[]> {
  const out: SavedMedia[] = [];
  for (const item of items) {
    const name = mediaFileName(item);
    if (!name) {
      out.push({ ...item, path: null, error: `unknown kind "${item.kind}"` });
      continue;
    }
    if (!item.available || !item.url) {
      out.push({ ...item, path: null, error: 'no longer available' });
      continue;
    }
    const file = join(dir, name);
    const err = await download(item.url, file, typeof item.sizeBytes === 'number' ? item.sizeBytes : null, opts);
    out.push(err ? { ...item, path: null, error: err } : { ...item, path: file });
  }
  return out;
}

/**
 * Saves the comment's screenshot, its media and each reply's media. Folders are created only when there is
 * something to save. Never throws for a download problem.
 */
export async function saveCommentMedia(comment: MediaSource, opts: SaveMediaOptions): Promise<SavedCommentMedia> {
  const dir = commentMediaDir(opts.root, opts.projectKey, comment.number);
  const media = Array.isArray(comment.media) ? comment.media : [];
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  const hasAnything =
    Boolean(comment.screenshotUrl) || media.length > 0 || replies.some((r) => Array.isArray(r.media) && r.media.length > 0);
  const result: SavedCommentMedia = { dir, screenshot: null, media: [], replies: [] };
  if (!hasAnything) return result;

  await ensureHidden(opts.root);
  await fs.mkdir(dir, { recursive: true });

  if (comment.screenshotUrl) {
    const ext = extensionFor(null, comment.screenshotUrl, 'png');
    const file = join(dir, `screenshot.${ext}`);
    const err = await download(comment.screenshotUrl, file, null, opts);
    result.screenshot = err
      ? { url: comment.screenshotUrl, path: null, error: err }
      : { url: comment.screenshotUrl, path: file };
  }

  result.media = await saveItems(media, dir, opts);

  for (let i = 0; i < replies.length; i++) {
    const r = replies[i];
    const items = Array.isArray(r.media) ? r.media : [];
    if (items.length === 0) continue;
    const replyId = typeof r.id === 'number' ? r.id : undefined;
    const folder = replyId !== undefined ? `reply-${replyId}` : `reply-p${i + 1}`;
    const replyDir = join(dir, folder);
    await fs.mkdir(replyDir, { recursive: true });
    const saved: SavedReplyMedia = {
      folder,
      ...(replyId !== undefined ? { replyId } : {}),
      position: i + 1,
      media: await saveItems(items, replyDir, opts),
    };
    result.replies.push(saved);
  }
  return result;
}

/** Removes comment folders (`<project>/<number>`) last modified more than `maxAgeDays` ago. Never throws. */
export async function pruneMedia(root: string, maxAgeDays = MEDIA_MAX_AGE_DAYS, now: number = Date.now()): Promise<void> {
  const base = join(root, MEDIA_DIR);
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const projects = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const projectDir = join(base, p.name);
    const comments = await fs.readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const c of comments) {
      if (!c.isDirectory()) continue;
      const commentDir = join(projectDir, c.name);
      const st = await fs.stat(commentDir).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.rm(commentDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Deletes one comment's folder (after it was marked applied). Never throws. */
export async function deleteCommentMedia(root: string, projectKey: string, number: number): Promise<void> {
  await fs.rm(commentMediaDir(root, projectKey, number), { recursive: true, force: true }).catch(() => undefined);
}
