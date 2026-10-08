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
