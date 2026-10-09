import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where an API key came from, for `whoami` and doctor's `key` check. `null` = none resolved. */
export type ApiKeySource = 'env' | 'repo' | null;

export interface ResolvedApiKey {
  key: string | undefined;
  source: ApiKeySource;
}

/** Human label for `ResolvedApiKey.source`, used in doctor/whoami output. */
export function sourceLabel(source: ApiKeySource): string {
  if (source === 'env') return 'env var';
  if (source === 'repo') return 'repo credentials.env';
  return 'none';
}

/** The bare origin a server URL normalizes to — the global store's key, so `https://x.com` and
 *  `https://x.com/` (or a URL with a path) all resolve to the same entry. */
export function normalizeServerOrigin(server: string): string {
  try {
    return new URL(server).origin;
  } catch {
    // Not a parseable URL (a test stub without a scheme, say) — fall back to a trimmed literal
    // rather than throwing, since a malformed server string is reported elsewhere, not here.
    return server.replace(/\/+$/, '');
  }
}

/** The per-machine folder name, inside the OS config dir and the OS cache dir. */
const DIR_NAME = 'pinsay';

/**
 * The folder name every CLI before 0.8.0 used. Only looked at by `update`'s cleanup of an old
 * machine-wide key; never written. The old cache folder is simply
 * no longer read — a JWT is re-fetched — and never deleted: a folder called `pointer` might
 * belong to another tool.
 */
const LEGACY_DIR_NAME = 'pointer';

/** The OS config base: `%APPDATA%` on Windows, else `$XDG_CONFIG_HOME` or `~/.config`. */
function configBase(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

/**
 * Directory where CLIs before 0.10.0 kept the machine-wide key (`credentials.json`); read since 0.10.0 only so `update` can delete it.
 *
 * `$PINSAY_CONFIG_DIR` overrides everything below it, so tests never touch a real machine's
 * `~/.config`. Otherwise: Windows uses `%APPDATA%\pinsay`; everywhere else honours
 * `$XDG_CONFIG_HOME` and falls back to `~/.config/pinsay`.
 */
export function globalConfigDir(): string {
  if (process.env.PINSAY_CONFIG_DIR) return process.env.PINSAY_CONFIG_DIR;
  return join(configBase(), DIR_NAME);
}

export function globalCredentialsPath(): string {
  return join(globalConfigDir(), 'credentials.json');
}

/**
 * The pre-0.8.0 machine store (`~/.config/pointer/credentials.json`, `%APPDATA%\pointer\...`), or
 * `undefined` when `$PINSAY_CONFIG_DIR` is set. Only `update` looks at it, to delete it.
 */
export function legacyGlobalCredentialsPath(): string | undefined {
  if (process.env.PINSAY_CONFIG_DIR) return undefined;
  return join(configBase(), LEGACY_DIR_NAME, 'credentials.json');
}

/**
 * Directory for the cached login JWT — separate from the credential store on purpose (XDG splits
 * config from cache, and a cache is disposable in a way credentials.json is not).
 *
 * `$PINSAY_CONFIG_DIR` (the same test override as `globalConfigDir`) redirects this too, so a test
 * pointing at a temp dir gets an isolated cache alongside an isolated credential store instead of
 * writing into a real machine's `~/.cache`.
 */
export function globalCacheDir(): string {
  if (process.env.PINSAY_CONFIG_DIR) return join(process.env.PINSAY_CONFIG_DIR, 'cache');
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), DIR_NAME, 'cache');
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), DIR_NAME);
}

/** The cached-JWT file for one (server, apiKey) pair — hashed so the filename never leaks the key. */
export function tokenCacheFile(server: string, apiKey: string): string {
  const hash = createHash('sha256')
    .update(`${normalizeServerOrigin(server)}:${apiKey}`)
    .digest('hex')
    .slice(0, 32);
  return join(globalCacheDir(), `${hash}.json`);
}

/** True for what an older CLI's machine store held: a JSON object whose every value has a string `apiKey`. */
export function isCredentialStore(value: unknown): value is Record<string, { apiKey: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) => !!entry && typeof entry === 'object' && typeof (entry as { apiKey?: unknown }).apiKey === 'string',
  );
}

/** The same `.pinsay/credentials.env` `writeCredentials` (config.ts) writes — read here too so
 *  `resolveApiKey` is the one place every caller goes through instead of re-reading the file. */
export async function readRepoApiKey(root: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(join(root, '.pinsay', 'credentials.env'), 'utf8');
    return raw.match(/^PINSAY_API_KEY=(.*)$/m)?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** `.pinsay/credentials.env` under `root` — the repo key file `writeCredentials` (config.ts) writes. */
export function repoCredentialsPath(root: string): string {
  return join(root, '.pinsay', 'credentials.env');
}

/** Deletes this repo's key file. True when there was one to delete. */
export async function removeRepoCredentials(root: string): Promise<boolean> {
  const file = repoCredentialsPath(root);
  try {
    await fs.access(file);
  } catch {
    return false;
  }
  await fs.rm(file, { force: true });
  return true;
}

/**
 * The one resolver every command (and the MCP server) uses to find an API key, in order:
 *
 *   1. `PINSAY_API_KEY` env var — CI, or a deliberate one-off override
 *   2. this repo's `.pinsay/credentials.env`
 *
 * Since 0.10.0 there is no machine-wide key. `_server` is unused; it stays so callers need not change.
 */
export async function resolveApiKey(root: string, _server?: string): Promise<ResolvedApiKey> {
  const envKey = process.env.PINSAY_API_KEY?.trim();
  if (envKey) return { key: envKey, source: 'env' };

  const repoKey = await readRepoApiKey(root);
  if (repoKey) return { key: repoKey, source: 'repo' };

  return { key: undefined, source: null };
}

/**
 * Removes the pre-global-store `.pinsay/.token_cache` if a repo still has one (the JWT cache moved
 * to `globalCacheDir()`, keyed by server+key rather than by repo — see `tokenCacheFile`). Best
 * effort and silent: a repo that never had one has nothing to remove, and a permissions error here
 * must not block whatever command triggered the cleanup.
 */
export async function removeStaleRepoTokenCache(root: string): Promise<void> {
  await fs.rm(join(root, '.pinsay', '.token_cache'), { force: true }).catch(() => {});
}
