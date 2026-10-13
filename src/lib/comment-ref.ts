import { api, ApiError } from '../api.js';

/** DB-26: a comment is referenced by its number inside its project (`12` or `#12`). */
export class CommentNotFoundError extends Error {
  constructor(public project: string, public number: number) {
    super(`No comment #${number} in project ${project}.`);
    this.name = 'CommentNotFoundError';
  }
}

/** "12" or "#12" → 12. Anything else (0, negatives, decimals, "id:5", "abc", empty) → null. */
export function parseCommentNumber(input: unknown): number | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const s = String(input).trim().replace(/^#/, '');
  if (!/^[1-9]\d*$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export function invalidNumberMessage(input: unknown): string {
  return `Invalid comment number: ${String(input)}. Expected a number like 12 or #12.`;
}

/** GET /api/projects/{key}/comments/by-number/{n} → the comment (its `id` is the internal id, `number` the #). */
export async function fetchCommentByNumber<T = any>(
  server: string,
  token: string | undefined,
  project: string,
  number: number,
): Promise<T> {
  try {
    return await api<T>(server, `/api/projects/${encodeURIComponent(project)}/comments/by-number/${number}`, { token });
  } catch (err) {
    if (err instanceof ApiError && err.code === 404) throw new CommentNotFoundError(project, number);
    throw err;
  }
}
