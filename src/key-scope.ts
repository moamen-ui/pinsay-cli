/** Since 0.10.0 the API key is saved in the repo only (`.pinsay/credentials.env`); there is no machine-wide key. */
export const GLOBAL_KEY_REMOVED =
  '--global is no longer supported: the API key is saved in this repo only (.pinsay/credentials.env). ' +
  'Run npx pinsay-cli update to delete a machine-wide key an older version saved.';

/**
 * Checks the old key-location flags. `--global` / `--scope global` → `{ error: GLOBAL_KEY_REMOVED }`;
 * `--scope repo` / `--local-credentials` → `{ explicitRepo: true }` (old spellings of the only choice; `login`
 * honours them outside a git repo); any other `--scope` → `{ error }`; no flag → `{}`.
 */
export function scopeFromFlags(options: Record<string, string | boolean>): { explicitRepo?: boolean; error?: string } {
  const raw = options['scope'];
  if (typeof raw === 'string') {
    const value = raw.toLowerCase();
    if (value === 'global') return { error: GLOBAL_KEY_REMOVED };
    if (value !== 'repo') return { error: `Invalid --scope "${raw}". Valid value: repo.` };
    return { explicitRepo: true };
  }
  if (options['global'] === true) return { error: GLOBAL_KEY_REMOVED };
  if (options['local-credentials'] === true) return { explicitRepo: true };
  return {};
}
