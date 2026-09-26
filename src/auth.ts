import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { api, ApiError } from './api.js';
import { resolveApiKey, tokenCacheFile, removeStaleRepoTokenCache, type ApiKeySource } from './credentials.js';

/**
 * Resolves the API key for `cwd`'s repo, honouring the full precedence in `resolveApiKey`
 * (env -> repo credentials.env -> global store). Pass `server` whenever it is already known so the
 * global-store step actually runs — see `credentials.ts` for why it is optional here.
 */
export async function readApiKey(cwd: string, server?: string): Promise<string | undefined> {
  const { key } = await resolveApiKey(cwd, server);
  return key;
}

/** Same as `readApiKey`, but also reports which of the three sources answered — for `whoami`/doctor. */
export async function readApiKeyWithSource(
  cwd: string,
  server?: string,
): Promise<{ key: string | undefined; source: ApiKeySource }> {
  return resolveApiKey(cwd, server);
}

/**
 * True when `token` decodes as a JWT whose `exp` claim is already in the past (a few seconds of
 * slack so a token expiring right this instant is still treated as dead, not raced against). A
 * string that isn't a three-segment JWT — a test fixture's plain `'jwt-for-test'`, say — decodes
 * to nothing here and is treated as NOT expired: this check only ever discards a cache entry it
 * can positively prove is dead, never one it merely doesn't understand.
 */
function isJwtExpired(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now() + 5000;
  } catch {
    return false;
  }
}

/**
 * Exchanges an API key for a JWT, caching the result under the global per-(server,key) cache file
 * (see `tokenCacheFile`) so repeated commands in the same repo — or a different repo against the
 * same server and key — don't re-login every time.
 */
export async function resolveToken(
  server: string,
  cwd: string,
  explicitApiKey?: string,
): Promise<string | undefined> {
  // Best-effort cleanup of the old repo-local cache this replaces — see removeStaleRepoTokenCache.
  await removeStaleRepoTokenCache(cwd);

  const apiKey = explicitApiKey || (await readApiKey(cwd, server));
  if (!apiKey) return undefined;

  const cacheFile = tokenCacheFile(server, apiKey);
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    const token = typeof cached?.token === 'string' ? cached.token.trim() : '';
    // A cached JWT past its own `exp` is worse than no cache at all: every command silently
    // fails 401 against a dead token until someone thinks to clear ~/.cache/pointer by hand.
    // Fall through to a fresh exchange instead of trusting it.
    if (token && !isJwtExpired(token)) return token;
  } catch {
    // Missing, unreadable, or not JSON — fall through to a fresh login.
  }

  try {
    const login = await api<{ status?: string; token?: string }>(
      server,
      '/api/auth/login-with-key',
      {
        method: 'POST',
        body: { apiKey },
      },
    );

    if (login?.token) {
      try {
        await fs.mkdir(dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify({ token: login.token }), 'utf8');
      } catch {
        // A cache write failure must not fail the login itself.
      }
      return login.token;
    }
  } catch (err: any) {
    if (err instanceof ApiError && err.code === 401) {
      // invalid key
      return undefined;
    }
  }

  return undefined;
}
