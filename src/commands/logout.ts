import { canonicalServer, findRepoRoot, readConfig } from '../config.js';
import { removeGlobalCredential, normalizeServerOrigin } from '../credentials.js';
import { BUILD_DEFAULT_SERVER } from '../build-constants.js';

/** Removes this machine's saved global credential for one server (see `login`). Never touches a
 *  repo's own `.pinsay/credentials.env` — that is a separate, explicit opt-out (`--local-credentials`). */
export async function logoutCommand(cwd: string, options: Record<string, string | boolean> = {}): Promise<void> {
  const root = await findRepoRoot(cwd);
  const config = await readConfig(root).catch(() => ({}) as any);

  const server = (
    (typeof options['server'] === 'string' ? (options['server'] as string) : undefined) ||
    config.server ||
    canonicalServer(process.env.PINSAY_SERVER) ||
    BUILD_DEFAULT_SERVER
  ).replace(/\/$/, '');

  const origin = normalizeServerOrigin(server);
  const removed = await removeGlobalCredential(server);

  if (options['json'] === true) {
    console.log(JSON.stringify({ ok: true, server: origin, removed }));
    process.exit(0);
  }

  console.log(
    removed
      ? `✔ Removed the saved key for ${origin} from this machine.`
      : `No saved key for ${origin} on this machine.`,
  );
  process.exit(0);
}
