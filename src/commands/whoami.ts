import { findRepoRoot } from '../config.js';
import { api } from '../api.js';
import { resolveApiKey, sourceLabel } from '../credentials.js';
import { resolveServer } from '../server.js';

/** Reports the server, the signed-in account, its workspace, and whether env or the repo answered the API key —
 *  never the key itself. */
export async function whoamiCommand(cwd: string, options: Record<string, string | boolean> = {}): Promise<void> {
  const root = await findRepoRoot(cwd);
  const server = resolveServer();
  const isJson = options['json'] === true;
  const { key, source } = await resolveApiKey(root, server);

  if (!key) {
    if (isJson) {
      console.log(JSON.stringify({ ok: false, server, source: null }));
    } else {
      console.error(`No API key found for ${server} (checked PINSAY_API_KEY and this repo's .pinsay/credentials.env).`);
      console.error('Run `npx pinsay-cli login` to sign in.');
    }
    process.exit(3);
  }

  let displayName: string | undefined;
  let email: string | undefined;
  let workspace: string | undefined;
  try {
    const login = await api<any>(server, '/api/auth/login-with-key', { method: 'POST', body: { apiKey: key } });
    if (login?.status === 'ok' && login.token) {
      // `/me`, not `login.user`: only `/me` carries the workspace name (`tenantName`).
      const me = await api<any>(server, '/api/auth/me', { token: login.token });
      displayName = me?.displayName || undefined;
      email = me?.email || undefined;
      workspace = me?.tenantName || undefined;
    }
  } catch {
    // Best-effort — a server that cannot be reached still gets the key source below.
  }

  if (isJson) {
    console.log(JSON.stringify({ ok: true, server, displayName, email, workspace: workspace ?? null, source }));
    process.exit(0);
  }

  const who = displayName ? `${displayName}${email ? ` (${email})` : ''}` : (email ?? 'unknown user');
  const where = workspace ? ` — workspace: ${workspace}` : '';
  console.log(`${server} — ${who}${where} — key source: ${sourceLabel(source)}`);
  process.exit(0);
}
