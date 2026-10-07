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

/** The per-machine folder name, inside the OS config dir and the OS cache dir. */
const DIR_NAME = 'pinsay';

/**
 * The folder name every CLI before 0.8.0 used. Read once, only to move an existing credential
 * store to `DIR_NAME` (see `migrateLegacyStore`); never written. The old cache folder is simply
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
 * Directory holding the global credential store (and nothing else — the token cache lives under
 * the XDG *cache* dir, see `globalCacheDir`, deliberately not here).
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
 * The pre-0.8.0 store file (`~/.config/pointer/credentials.json`, `%APPDATA%\pointer\...`), or
 * `undefined` when `$PINSAY_CONFIG_DIR` is set: a test's isolated store never migrates anything.
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

/** True for what `writeGlobalStore` writes: a JSON object whose every value has a string `apiKey`. */
function isCredentialStore(value: unknown): value is GlobalCredentialsStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) => !!entry && typeof entry === 'object' && typeof (entry as { apiKey?: unknown }).apiKey === 'string',
  );
}

async function readGlobalStore(): Promise<GlobalCredentialsStore> {
  let raw: string;
  try {
    raw = await fs.readFile(globalCredentialsPath(), 'utf8');
  } catch (err: any) {
    // No store in the new place yet: a machine that signed in with a CLI before 0.8.0 still has
    // it under the old `pointer` folder — move it over once instead of looking logged out.
    if (err?.code === 'ENOENT') return migrateLegacyStore();
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Moves the pre-0.8.0 store (`legacyGlobalCredentialsPath`) to `globalCredentialsPath`, once.
 *
 * Only a file that really is a credential store is moved (a `pointer` folder could belong to
 * another tool). Move, not copy: the key never sits in two places and `logout` stays truthful.
 * If the new file cannot be written the old content is still returned (read-through) and the old
 * file is left where it is. The old folder is removed only when it is empty afterwards.
 */
async function migrateLegacyStore(): Promise<GlobalCredentialsStore> {
  const legacyFile = legacyGlobalCredentialsPath();
  if (!legacyFile) return {};
  let legacy: unknown;
  try {
    legacy = JSON.parse(await fs.readFile(legacyFile, 'utf8'));
  } catch {
    return {};
  }
  if (!isCredentialStore(legacy)) return {};
  try {
    await writeGlobalStore(legacy);
  } catch {
    return legacy;
  }
  await fs.rm(legacyFile, { force: true }).catch(() => {});
  // Never recursive: removes the folder only if nothing else is left in it.
  await fs.rmdir(dirname(legacyFile)).catch(() => {});
  return legacy;
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
  const origin = normalizeServerOrigin(server);
  // api.pinsay.dev became a legacy alias of app.pinsay.dev on 2026-09-28 (same server). A key saved
  // by `login` against the old host is still valid for the new one, so a user who signed in before
  // the switch is not suddenly "logged out". See CANONICAL_SERVER in config.ts.
  if (!store[origin] && origin === 'https://app.pinsay.dev') return store['https://api.pinsay.dev'];
  return store[origin];
}

export async function saveGlobalCredential(
  server: string,
  entry: { apiKey: string; email?: string; displayName?: string },
): Promise<void> {
  const store = await readGlobalStore();
  store[normalizeServerOrigin(server)] = { ...entry, savedAt: new Date().toISOString() };
  await writeGlobalStore(store);
}

/**
 * Returns true when an entry existed and was removed; false when there was nothing to remove.
 * Removing `https://app.pinsay.dev` also removes a key saved against the legacy
 * `https://api.pinsay.dev` — the same alias `getGlobalCredential` reads — or `whoami` would keep
 * answering after `logout`.
 */
export async function removeGlobalCredential(server: string): Promise<boolean> {
  const store = await readGlobalStore();
  const origin = normalizeServerOrigin(server);
  const origins = origin === 'https://app.pinsay.dev' ? [origin, 'https://api.pinsay.dev'] : [origin];
  const present = origins.filter((o) => o in store);
  if (present.length === 0) return false;
  for (const o of present) delete store[o];
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
