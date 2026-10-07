import { removeGlobalCredential, normalizeServerOrigin } from '../credentials.js';
import { resolveServer } from '../server.js';

/** Removes this machine's saved global key (see `login`). Never touches a
 *  repo's own `.pinsay/credentials.env` — that is a separate, explicit opt-out (`--local-credentials`). */
export async function logoutCommand(_cwd: string, options: Record<string, string | boolean> = {}): Promise<void> {
  const server = resolveServer();

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
