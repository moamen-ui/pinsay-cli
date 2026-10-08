import { select } from './prompt.js';

/** Where a freshly signed-in API key is saved: this repo (the default since 0.9.0), or this machine's store. */
export type KeyScope = 'global' | 'repo';

/**
 * The scope a flag fixed: `--global` or `--scope global` → global; `--scope repo` or `--local-credentials` → repo
 * (old flags; repo is the default anyway). `{}` when no flag decided it; `{ error }` for an unknown `--scope`.
 * A returned `scope` means a flag was passed — `login` honours an explicit repo choice even outside a git repo,
 * where the default would be the machine store.
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
  if (options['global'] === true) return { scope: 'global' };
  if (options['local-credentials'] === true) return { scope: 'repo' };
  return {};
}

// --- Pre-0.9.0 question, kept only until `init` stops importing it (T07 removes both). -------------------------
export const KEY_SCOPE_QUESTION = 'Where should this API key be stored?';
export const KEY_SCOPE_GLOBAL = 'Global — this machine, every repo (~/.config/pinsay/credentials.json)';
export const KEY_SCOPE_REPO = 'Repo — .pinsay/credentials.env in this repo only (hidden from git)';

/** @deprecated 0.9.0 saves to the repo without asking; removed with T07. */
export async function askKeyScope(): Promise<KeyScope> {
  const choice = await select(KEY_SCOPE_QUESTION, [KEY_SCOPE_GLOBAL, KEY_SCOPE_REPO]);
  return choice === KEY_SCOPE_REPO ? 'repo' : 'global';
}
