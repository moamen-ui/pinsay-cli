import { BUILD_DEFAULT_SERVER } from './build-constants.js';
import { canonicalServer, findRepoRoot, readConfig, type PinSayConfig } from './config.js';
import { normalizeServerOrigin } from './credentials.js';

/**
 * The one server this CLI talks to. Since 0.8.0 there is no server choice: no `--server` flag, no
 * "Server URL" prompt, no `server` read from `.pinsay/config.json`.
 *
 * `PINSAY_SERVER` is a hidden developer/test override (the e2e suite and the unit tests point it at
 * a local API or a stub). It is deliberately absent from every help text, prompt and doc. To bring
 * a user-facing server choice back, add it here: every command resolves the server through this.
 */
export function resolveServer(): string {
  const override = process.env.PINSAY_SERVER?.trim();
  return canonicalServer(override || BUILD_DEFAULT_SERVER).replace(/\/+$/, '');
}

/**
 * Why this run must stop before talking to any server, or `null` when it may go on:
 *  - `--server` was passed: the flag is gone, and silently ignoring it would send the key to a
 *    different server than the one the user named.
 *  - `.pinsay/config.json` names a server other than `resolveServer()`: the repo was set up against
 *    another server. Our own origins (`app.pinsay.dev`, and the legacy `api.pinsay.dev`, which
 *    `readConfig` canonicalises) are accepted silently and the file is left as it is.
 */
export async function serverSettingError(
  cwd: string,
  parsed: Record<string, string | boolean>,
): Promise<string | null> {
  const server = resolveServer();
  if (parsed['server'] !== undefined) {
    return `--server was removed: this CLI talks only to ${server}.`;
  }
  const root = await findRepoRoot(cwd);
  const config: PinSayConfig = await readConfig(root).catch(() => ({}));
  if (config.server && normalizeServerOrigin(config.server) !== normalizeServerOrigin(server)) {
    return (
      `.pinsay/config.json sets "server": "${config.server}", but this CLI talks only to ${server}.\n` +
      'Remove the "server" line from .pinsay/config.json, then run the command again.'
    );
  }
  return null;
}
