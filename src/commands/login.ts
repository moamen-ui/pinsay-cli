import { canonicalServer, findRepoRoot, readConfig, writeCredentials } from '../config.js';
import { api } from '../api.js';
import { getBranding } from '../branding.js';
import { saveGlobalCredential } from '../credentials.js';
import { BUILD_DEFAULT_SERVER } from '../build-constants.js';
import { runDeviceLogin } from '../device-login.js';

/**
 * Authenticates once per machine and saves the result to the global credential store (see
 * `credentials.ts`), keyed by server origin — every repo on this machine then resolves a key for
 * that server without asking again (see `resolveApiKey`'s precedence).
 *
 * Two paths to a key:
 *   - No `--key` on a real terminal: the browser ("device code") flow in `device-login.ts` —
 *     mirrors `gh auth login`. This is the default because pasting a long-lived key is the more
 *     error-prone, more copy-pasteable-into-the-wrong-place option.
 *   - `--key <key>`: the original manual path — exchanges the pasted key for the account it
 *     belongs to via `/api/auth/login-with-key` + `/api/auth/me`, unchanged.
 * No `--key` and no TTY (CI, a pipe) has no one to open a browser for or prompt — hard exit 2.
 */
export async function loginCommand(cwd: string, options: Record<string, string | boolean> = {}): Promise<void> {
  // A repo's own `.pinsay/config.json` server is a convenience default only — login is global and
  // not scoped to "this repo" in any other way.
  const root = await findRepoRoot(cwd);
  const config = await readConfig(root).catch(() => ({}) as any);

  const server = (
    (typeof options['server'] === 'string' ? (options['server'] as string) : undefined) ||
    config.server ||
    canonicalServer(process.env.PINSAY_SERVER) ||
    BUILD_DEFAULT_SERVER
  ).replace(/\/$/, '');

  const branding = await getBranding(server);
  const product = branding.productName;

  const flagKey = typeof options['key'] === 'string' ? (options['key'] as string) : undefined;
  let key = flagKey;
  let me: any;

  if (flagKey) {
    // A key handed on the command line is validated exactly once — there is no one to re-prompt
    // when it fails non-interactively, so a bad --key is a hard exit 3, same as `init --yes`.
    try {
      const login = await api<any>(server, '/api/auth/login-with-key', {
        method: 'POST',
        body: { apiKey: flagKey },
      });
      if (login?.status !== 'ok' || !login?.token) throw new Error(login?.status || 'invalid');
      me = login.user ?? (await api(server, '/api/auth/me', { token: login.token }));
    } catch {
      console.error('Invalid API key.');
      process.exit(3);
    }
  } else if (process.stdin.isTTY || options['no-browser'] === true) {
    // The device flow never reads stdin — it only prints a link/code and polls over HTTP — so a
    // real terminal is not actually required to run it safely, only to make opening a browser make
    // sense. `--no-browser` is the explicit "I'll handle the link myself" signal that lets this run
    // without a TTY at all (a script, or a CI step whose log a human is watching); with neither a
    // TTY nor that flag, there is no reasonable way to hand someone a link and no key to fall back
    // to, so this exits fast instead of opening a browser no one asked for.
    const outcome = await runDeviceLogin(server, { noBrowser: options['no-browser'] === true });
    if (!outcome.ok) {
      if (outcome.reason === 'denied') {
        console.error('Sign-in was denied.');
      } else {
        console.error('The sign-in code expired. Run `npx pinsay-cli login` again.');
      }
      process.exit(3);
    }
    key = outcome.result.apiKey;
    me = { displayName: outcome.result.displayName, email: outcome.result.email };
  } else {
    console.error('No key provided and no terminal to sign in from — run `npx pinsay-cli login --key <key>` or set PINSAY_API_KEY.');
    process.exit(2);
  }

  const scope = typeof options['scope'] === 'string' ? String(options['scope']).toLowerCase() : 'global';
  if (scope !== 'global' && scope !== 'repo') {
    console.error(`Invalid --scope "${options['scope']}". Valid values: global, repo.`);
    process.exit(2);
  }
  const who = me?.displayName ? `${me.displayName}${me?.email ? ` (${me.email})` : ''}` : me?.email ?? 'you';
  if (scope === 'repo') {
    // Repo scope: the multi-account case (a second identity on the same server for one repo). The
    // repo file wins over the global store in resolveApiKey, so this overrides a machine-wide key.
    await writeCredentials(root, key!, { server });
    console.log(`✔ Signed in to ${server} as ${who} — saved to .pinsay/credentials.env (this repo only; overrides the global store here)`);
    process.exit(0);
  }
  await saveGlobalCredential(server, { apiKey: key!, email: me?.email, displayName: me?.displayName });
  console.log(`✔ Signed in to ${server} as ${who} — saved for all repos on this machine`);
  process.exit(0);
}
