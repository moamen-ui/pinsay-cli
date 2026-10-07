import { findRepoRoot } from '../config.js';
import { api } from '../api.js';
import { resolveApiKey, getGlobalCredential, sourceLabel } from '../credentials.js';
import { resolveServer } from '../server.js';

/** Reports the server, the signed-in account, and which of env/repo/global answered the API key —
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
      console.error(`No API key found for ${server} (checked env var, repo, and global store).`);
      console.error('Run `npx pinsay-cli login` to sign in.');
    }
    process.exit(3);
  }

  let displayName: string | undefined;
  let email: string | undefined;
  try {
    const login = await api<any>(server, '/api/auth/login-with-key', { method: 'POST', body: { apiKey: key } });
    if (login?.status === 'ok' && login.token) {
      const me = login.user ?? (await api<any>(server, '/api/auth/me', { token: login.token }));
      displayName = me?.displayName;
      email = me?.email;
    }
  } catch {
    // Best-effort — a server that cannot be reached still gets an answer below, falling back to
    // whatever the global store cached the last time login/init succeeded.
  }

  if (source === 'global' && (!displayName || !email)) {
    const cached = await getGlobalCredential(server);
    displayName = displayName ?? cached?.displayName;
    email = email ?? cached?.email;
  }

  if (isJson) {
    console.log(JSON.stringify({ ok: true, server, displayName, email, source }));
    process.exit(0);
  }

  const who = displayName ? `${displayName}${email ? ` (${email})` : ''}` : (email ?? 'unknown user');
  console.log(`${server} — ${who} — key source: ${sourceLabel(source)}`);
  process.exit(0);
}
