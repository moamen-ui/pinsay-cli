import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/**
 * One server's saved credential in the global store — see `globalCredentialsPath`. `apiKey` is the
 * same long-lived personal key `.pinsay/credentials.env` holds today; `email`/`displayName` are
 * cached from `/api/auth/me` purely so `whoami`/`init`'s join-mode message can greet the user
 * without another round trip.
 */
export interface GlobalCredentialEntry {
  apiKey: string;
  email?: string;
  displayName?: string;
  savedAt: string;
}

/** Keyed by server origin (no trailing slash) — one entry per machine per server. */
export type GlobalCredentialsStore = Record<string, GlobalCredentialEntry>;

/** Where an API key came from, for `whoami` and doctor's `key` check. `null` = none resolved. */
export type ApiKeySource = 'env' | 'repo' | 'global' | null;

export interface ResolvedApiKey {
  key: string | undefined;
  source: ApiKeySource;
}

/** Human label for `ResolvedApiKey.source`, used in doctor/whoami output. */
export function sourceLabel(source: ApiKeySource): string {
  if (source === 'env') return 'env var';
  if (source === 'repo') return 'repo credentials.env';
  if (source === 'global') return 'global store';
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

/**
 * Directory holding the global credential store (and nothing else — the token cache lives under
 * the XDG *cache* dir, see `globalCacheDir`, deliberately not here).
 *
 * `$PINSAY_CONFIG_DIR` overrides everything below it, so tests never touch a real machine's
 * `~/.config`. Otherwise: Windows uses `%APPDATA%\pointer`; everywhere else honours
 * `$XDG_CONFIG_HOME` and falls back to `~/.config/pointer`.
 */
export function globalConfigDir(): string {
  if (process.env.PINSAY_CONFIG_DIR) return process.env.PINSAY_CONFIG_DIR;
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'pointer');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'pointer');
}

export function globalCredentialsPath(): string {
  return join(globalConfigDir(), 'credentials.json');
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
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'pointer', 'cache');
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pointer');
}

/** The cached-JWT file for one (server, apiKey) pair — hashed so the filename never leaks the key. */
export function tokenCacheFile(server: string, apiKey: string): string {
  const hash = createHash('sha256')
    .update(`${normalizeServerOrigin(server)}:${apiKey}`)
    .digest('hex')
    .slice(0, 32);
  return join(globalCacheDir(), `${hash}.json`);
}

async function readGlobalStore(): Promise<GlobalCredentialsStore> {
  try {
    const raw = await fs.readFile(globalCredentialsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeGlobalStore(store: GlobalCredentialsStore): Promise<void> {
  const file = globalCredentialsPath();
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  // chmod explicitly too: a file that already existed (copied from another machine, or created by
  // an older process before this mode was enforced) keeps its old permissions on write() alone —
  // the create-time mode above only applies when the file did not already exist.
  await fs.chmod(file, 0o600).catch(() => {});
}

export async function getGlobalCredential(server: string): Promise<GlobalCredentialEntry | undefined> {
  const store = await readGlobalStore();
  return store[normalizeServerOrigin(server)];
}

export async function saveGlobalCredential(
  server: string,
  entry: { apiKey: string; email?: string; displayName?: string },
): Promise<void> {
  const store = await readGlobalStore();
  store[normalizeServerOrigin(server)] = { ...entry, savedAt: new Date().toISOString() };
  await writeGlobalStore(store);
}

/** Returns true when an entry existed and was removed; false when there was nothing to remove. */
export async function removeGlobalCredential(server: string): Promise<boolean> {
  const store = await readGlobalStore();
  const origin = normalizeServerOrigin(server);
  if (!(origin in store)) return false;
  delete store[origin];
  await writeGlobalStore(store);
  return true;
}

/** The same `.pinsay/credentials.env` `writeCredentials` (config.ts) writes — read here too so
 *  `resolveApiKey` is the one place every caller goes through instead of re-reading the file. */
async function readRepoApiKey(root: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(join(root, '.pinsay', 'credentials.env'), 'utf8');
    return raw.match(/^PINSAY_API_KEY=(.*)$/m)?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The one resolver every command (and the MCP server) uses to find an API key, in order:
 *
 *   1. `PINSAY_API_KEY` env var — CI, or a deliberate one-off override
 *   2. repo `.pinsay/credentials.env` — a repo that opted out of the global store (`--local-credentials`)
 *   3. the global per-machine store, keyed by `server`'s origin
 *
 * `server` is optional only because a couple of callers resolve it after checking whether a key
 * exists at all; pass it whenever it is already known so step 3 actually runs.
 */
export async function resolveApiKey(root: string, server?: string): Promise<ResolvedApiKey> {
  const envKey = process.env.PINSAY_API_KEY?.trim();
  if (envKey) return { key: envKey, source: 'env' };

  const repoKey = await readRepoApiKey(root);
  if (repoKey) return { key: repoKey, source: 'repo' };

  if (server) {
    const globalEntry = await getGlobalCredential(server);
    if (globalEntry?.apiKey) return { key: globalEntry.apiKey, source: 'global' };
  }

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
