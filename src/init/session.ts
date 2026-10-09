import { api, ApiError } from '../api.js';
import { resolveApiKey, type ApiKeySource } from '../credentials.js';
import { runDeviceLogin } from '../device-login.js';
import { ask } from '../prompt.js';
import { exitWithError, isOutage } from '../errors.js';

/**
 * Sign-in for `init` (SPEC B3 + B5's quick-access rule). Lead-only: it decides which key a run trusts, and it is
 * the gate that keeps a quick-access account from connecting a repo.
 *
 * Nothing here writes a file: where (and whether) the key is saved is decided after the plan is confirmed.
 */

/** The signed-in account, read from `/api/auth/me` (`MeResponse`: `isAdmin`, `isQuickAccess`). */
export type Profile = {
  displayName: string;
  email?: string;
  roleName?: string;
  isAdmin: boolean;
  isQuickAccess: boolean;
}

/** Where this run's key came from. `env`/`repo` = already saved (nothing to write); the rest are new. */
export type KeyOrigin = 'flag' | 'typed' | 'browser' | Exclude<ApiKeySource, null>;

export type Session = {
  key: string;
  token: string;
  me: Profile;
  origin: KeyOrigin;
}

/** The server said no to this key (wrong, revoked, expired). Outages are never this — they are rethrown. */
export class InvalidKeyError extends Error {
  constructor() {
    super('Invalid API key');
    this.name = 'InvalidKeyError';
  }
}

export function noKeyMessage(product: string): string {
  return `No API key. Pass --key <key> or set PINSAY_API_KEY (get one in ${product} → Profile → API key).`;
}
export const SAVED_KEY_REJECTED = 'Your saved key no longer works (expired or revoked).';
export function quickAccessMessage(product: string): string {
  return (
    "This is a quick-access account. It can leave comments, but it can't connect a repo. Sign in with your full " +
    `${product} account, or ask your workspace admin for one.`
  );
}

function toProfile(raw: any): Profile {
  return {
    displayName: raw?.displayName || raw?.email || 'you',
    email: raw?.email || undefined,
    roleName: raw?.roleName || undefined,
    isAdmin: raw?.isAdmin === true,
    isQuickAccess: raw?.isQuickAccess === true,
  };
}

/**
 * key → JWT → profile. `/api/auth/me` is the source of truth for `isAdmin`/`isQuickAccess` (the `user` that
 * `login-with-key` returns may not carry them); it falls back to that `user` only when `/me` fails for a reason
 * other than an outage.
 */
export async function exchangeKey(server: string, apiKey: string): Promise<{ token: string; me: Profile }> {
  let login: any;
  try {
    login = await api<any>(server, '/api/auth/login-with-key', { method: 'POST', body: { apiKey } });
  } catch (err) {
    if (isOutage(err)) throw err;
    if (err instanceof ApiError) throw new InvalidKeyError();
    throw err;
  }
  if (login?.status !== 'ok' || !login?.token) throw new InvalidKeyError();
  const token: string = login.token;
  let raw: any;
  try {
    raw = await api<any>(server, '/api/auth/me', { token });
  } catch (err) {
    if (isOutage(err)) throw err;
    raw = login.user;
  }
  return { token, me: toProfile(raw ?? login.user) };
}

export type SignInOptions = {
  /** `--key <value>` (string), `--key` with no value (true), or absent. */
  flagKey?: string | true;
  interactive: boolean;
  noBrowser: boolean;
  json: boolean;
  /** Product name from branding, for the hidden-input prompt. */
  product: string;
}

/**
 * The B3 order: `--key <value>` → `--key` (hidden prompt) → a key that already resolves (env, repo, machine store)
 * → the browser. Exits (never returns) on: no key without a terminal (2), a rejected key without a terminal (3),
 * a denied/expired browser sign-in (3), and a quick-access account (3).
 */
export async function signIn(server: string, root: string, opts: SignInOptions): Promise<Session> {
  const session = await obtainSession(server, root, opts);
  if (session.me.isQuickAccess) exitWithError(3, quickAccessMessage(opts.product), opts.json);
  return session;
}

async function obtainSession(server: string, root: string, opts: SignInOptions): Promise<Session> {
  if (typeof opts.flagKey === 'string' && opts.flagKey.trim()) {
    const key = opts.flagKey.trim();
    try {
      const { token, me } = await exchangeKey(server, key);
      return { key, token, me, origin: 'flag' };
    } catch (err) {
      if (!(err instanceof InvalidKeyError)) throw err;
      exitWithError(3, `That API key is not valid. Check it in ${opts.product} → Profile → API key.`, opts.json);
    }
  }

  if (opts.flagKey === true) {
    if (!opts.interactive) exitWithError(2, noKeyMessage(opts.product), opts.json);
    for (let attempt = 1; ; attempt++) {
      const key = (await ask(`API key (from ${opts.product} → Profile → API key; input hidden)`, { secret: true })).trim();
      try {
        const { token, me } = await exchangeKey(server, key);
        return { key, token, me, origin: 'typed' };
      } catch (err) {
        if (!(err instanceof InvalidKeyError)) throw err;
        if (attempt >= 3) exitWithError(3, 'That API key is not valid.', opts.json);
        console.error('That API key is not valid. Try again.');
      }
    }
  }

  const saved = await resolveApiKey(root, server);
  if (saved.key && saved.source) {
    try {
      const { token, me } = await exchangeKey(server, saved.key);
      return { key: saved.key, token, me, origin: saved.source };
    } catch (err) {
      if (!(err instanceof InvalidKeyError)) throw err;
      if (!opts.interactive) {
        exitWithError(3, `${SAVED_KEY_REJECTED} Sign in again: npx pinsay-cli login`, opts.json);
      }
      console.error(`${SAVED_KEY_REJECTED} Sign in again in your browser.`);
    }
  }

  if (!opts.interactive) exitWithError(2, noKeyMessage(opts.product), opts.json);

  const outcome = await runDeviceLogin(server, { noBrowser: opts.noBrowser });
  if (!outcome.ok) {
    exitWithError(
      3,
      outcome.reason === 'denied'
        ? 'Sign-in was denied.'
        : 'The sign-in code expired. Run npx pinsay-cli init again.',
      opts.json,
    );
  }
  const key = outcome.result.apiKey;
  try {
    const { token, me } = await exchangeKey(server, key);
    return { key, token, me, origin: 'browser' };
  } catch (err) {
    if (!(err instanceof InvalidKeyError)) throw err;
    exitWithError(3, 'The key from the browser sign-in was not accepted. Run npx pinsay-cli init again.', opts.json);
  }
}
