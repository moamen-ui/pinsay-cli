import { findRepoRoot } from '../config.js';
import { removeGlobalCredential, removeRepoCredentials, readRepoApiKey, normalizeServerOrigin } from '../credentials.js';
import { resolveServer } from '../server.js';
import { green, sym } from '../ui/style.js';

export const ENV_KEY_MESSAGE = 'Your key comes from the PINSAY_API_KEY variable. Unset it to sign out.';

/**
 * Removes the key this repo is using — the same source `whoami` reports (SPEC B2, lead-only):
 *   PINSAY_API_KEY set     → nothing removed; says to unset it (exit 0)
 *   --global               → this machine's entry for the server
 *   a repo key exists      → `.pinsay/credentials.env`
 *   otherwise              → this machine's entry
 */
export async function logoutCommand(cwd: string, options: Record<string, string | boolean> = {}): Promise<void> {
  const json = options['json'] === true;
  const server = resolveServer();
  const origin = normalizeServerOrigin(server);
  const root = await findRepoRoot(cwd);

  const finish = (source: 'env' | 'repo' | 'global', removed: boolean, message: string): never => {
    if (json) console.log(JSON.stringify({ ok: true, server: origin, source, removed }));
    else console.log(message);
    process.exit(0);
  };

  if (options['global'] !== true && process.env.PINSAY_API_KEY?.trim()) {
    finish('env', false, ENV_KEY_MESSAGE);
  }

  if (options['global'] !== true && (await readRepoApiKey(root))) {
    const removed = await removeRepoCredentials(root);
    finish('repo', removed, `${green(sym.check)} Signed out: removed this repo's key (.pinsay/credentials.env).`);
  }

  const removed = await removeGlobalCredential(server);
  finish(
    'global',
    removed,
    removed ? `${green(sym.check)} Removed the saved key for ${origin} from this machine.` : `No saved key for ${origin} on this machine.`,
  );
}
