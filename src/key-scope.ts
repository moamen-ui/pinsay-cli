import { select } from './prompt.js';

/** Where a freshly signed-in API key is saved: the per-machine store, or this repo only. */
export type KeyScope = 'global' | 'repo';

// One question, asked word for word by both `init` and `login`.
export const KEY_SCOPE_QUESTION = 'Where should this API key be stored?';
export const KEY_SCOPE_GLOBAL = 'Global — this machine, every repo (~/.config/pinsay/credentials.json)';
export const KEY_SCOPE_REPO = 'Repo — .pinsay/credentials.env in this repo only (hidden from git)';

/**
 * The scope a flag fixed: `--scope global|repo` (case-insensitive), or `--local-credentials` (an
 * alias for `--scope repo`). `{}` when no flag decided it; `{ error }` for an unknown `--scope`.
 */
export function scopeFromFlags(options: Record<string, string | boolean>): { scope?: KeyScope; error?: string } {
  const raw = options['scope'];
  if (typeof raw === 'string') {
    const value = raw.toLowerCase();
    if (value !== 'global' && value !== 'repo') {
      return { error: `Invalid --scope "${raw}". Valid values: global, repo.` };
    }
    return { scope: value };
  }
  if (options['local-credentials'] === true) return { scope: 'repo' };
  return {};
}

/**
 * A flag wins; otherwise ask when someone is at a terminal; otherwise (no TTY, `--yes`) save
 * globally — the default `login` and `init --yes` have always had, so CI and scripts keep working.
 */
export function decideKeyScope(flagScope: KeyScope | undefined, interactive: boolean): KeyScope | 'ask' {
  if (flagScope) return flagScope;
  return interactive ? 'ask' : 'global';
}

/** Asks `KEY_SCOPE_QUESTION` on the terminal. Call only when `decideKeyScope` returned 'ask'. */
export async function askKeyScope(): Promise<KeyScope> {
  const choice = await select(KEY_SCOPE_QUESTION, [KEY_SCOPE_GLOBAL, KEY_SCOPE_REPO]);
  return choice === KEY_SCOPE_REPO ? 'repo' : 'global';
}
