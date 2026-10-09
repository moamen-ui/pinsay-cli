import { findRepoRoot } from '../config.js';
import { removeRepoCredentials, readRepoApiKey, normalizeServerOrigin } from '../credentials.js';
import { scopeFromFlags } from '../key-scope.js';
import { resolveServer } from '../server.js';
import { exitWithError } from '../errors.js';
import { green, sym } from '../ui/style.js';

export const ENV_KEY_MESSAGE = 'Your key comes from the PINSAY_API_KEY variable. Unset it to sign out.';

/**
 * Removes this repo's key (SPEC B2, lead-only):
 *   PINSAY_API_KEY set         → nothing removed; says to unset it (exit 0)
 *   a repo key exists          → `.pinsay/credentials.env`
 *   otherwise                  → nothing to remove (exit 0)
 *   --global / --scope global  → exit 2 (`GLOBAL_KEY_REMOVED`); `update` deletes an old machine-wide key.
 */
export async function logoutCommand(cwd: string, options: Record<string, string | boolean> = {}): Promise<void> {
  const json = options['json'] === true;
  const flags = scopeFromFlags(options);
  if (flags.error) exitWithError(2, flags.error, json);
  const server = resolveServer();
  const origin = normalizeServerOrigin(server);
  const root = await findRepoRoot(cwd);

  const finish = (source: 'env' | 'repo', removed: boolean, message: string): never => {
    if (json) console.log(JSON.stringify({ ok: true, server: origin, source, removed }));
    else console.log(message);
    process.exit(0);
  };

  if (process.env.PINSAY_API_KEY?.trim()) finish('env', false, ENV_KEY_MESSAGE);

  if (await readRepoApiKey(root)) {
    const removed = await removeRepoCredentials(root);
    finish('repo', removed, `${green(sym.check)} Signed out: removed this repo's key (.pinsay/credentials.env).`);
  }

  finish('repo', false, 'No key saved in this repo.');
}
