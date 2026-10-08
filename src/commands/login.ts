import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRepoRoot, writeCredentials } from '../config.js';
import { hidePinsayFiles, formatHideWarnings } from '../lib/git-exclude.js';
import { getBranding } from '../branding.js';
import {
  saveGlobalCredential,
  readRepoApiKey,
  removeRepoCredentials,
  globalCredentialsPath,
} from '../credentials.js';
import { ask, closePrompts } from '../prompt.js';
import { scopeFromFlags } from '../key-scope.js';
import { resolveServer } from '../server.js';
import { exchangeKey, InvalidKeyError, NO_KEY_MESSAGE } from '../init/session.js';
import { runDeviceLogin } from '../device-login.js';
import { exitWithError } from '../errors.js';
import { green, sym } from '../ui/style.js';

/** True when `dir` is inside a git work tree. */
function inGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Signs in and saves the API key (SPEC B2/C2, lead-only).
 *
 *   login                 → this repo's `.pinsay/credentials.env` (0600, hidden from git). Outside any git repo and
 *                           any folder with `.pinsay/`, the machine store instead (no stray `.pinsay/` in a home folder).
 *   login --global        → the machine store. In a repo whose own key is valid (and no --key): MOVE that key there
 *                           (no browser) and delete the repo file.
 *   login --key <key>     → validate a pasted key instead of the browser.
 *   --scope global|repo, --local-credentials → old spellings, still accepted.
 */
export async function loginCommand(cwd: string, options: Record<string, string | boolean> = {}): Promise<void> {
  const json = options['json'] === true;
  const flags = scopeFromFlags(options);
  if (flags.error) exitWithError(2, flags.error, json);

  const root = await findRepoRoot(cwd);
  const server = resolveServer();
  await getBranding(server); // fails fast (exit 4) when the server can't be reached

  const inRepo = existsSync(join(root, '.pinsay')) || inGitRepo(root);
  const scope = flags.scope ?? (inRepo ? 'repo' : 'global');
  let flagKey = typeof options['key'] === 'string' ? options['key'].trim() : '';
  if (options['key'] === true) {
    // `--key` with no value: ask with hidden input (keeps the key out of shell history), never the browser.
    if (!process.stdin.isTTY) exitWithError(2, NO_KEY_MESSAGE, json);
    flagKey = (await ask('API key (from PinSay → Profile → API key; input hidden)', { secret: true })).trim();
    if (!flagKey) exitWithError(2, NO_KEY_MESSAGE, json);
  }

  // Move: `login --global` in a repo that already holds a valid key — no browser, no new key.
  if (scope === 'global' && !flagKey) {
    const repoKey = await readRepoApiKey(root);
    if (repoKey) {
      try {
        const { me } = await exchangeKey(server, repoKey);
        await saveGlobalCredential(server, { apiKey: repoKey, email: me.email, displayName: me.displayName });
        await removeRepoCredentials(root);
        done(json, { server, scope: 'global', moved: true, displayName: me.displayName, email: me.email },
          `${green(sym.check)} Moved your key to this machine's store (${globalCredentialsPath()}). Every repo on this machine can use it now.`);
      } catch (err) {
        if (!(err instanceof InvalidKeyError)) throw err;
        // An invalid repo key: sign in fresh below and save the new key to the machine store.
      }
    }
  }

  let key: string;
  let displayName: string | undefined;
  let email: string | undefined;

  if (flagKey) {
    try {
      const { me } = await exchangeKey(server, flagKey);
      key = flagKey;
      displayName = me.displayName;
      email = me.email;
    } catch (err) {
      if (!(err instanceof InvalidKeyError)) throw err;
      exitWithError(3, 'That API key is not valid. Check it in PinSay → Profile → API key.', json);
    }
  } else if (process.stdin.isTTY || options['no-browser'] === true) {
    // The device flow never reads stdin, so `--no-browser` lets it run without a TTY (the link is printed).
    const outcome = await runDeviceLogin(server, { noBrowser: options['no-browser'] === true });
    if (!outcome.ok) {
      exitWithError(3, outcome.reason === 'denied' ? 'Sign-in was denied.' : 'The sign-in code expired. Run npx pinsay-cli login again.', json);
    }
    key = outcome.result.apiKey;
    displayName = outcome.result.displayName;
    email = outcome.result.email;
  } else {
    exitWithError(2, NO_KEY_MESSAGE, json);
  }
  closePrompts();

  const who = displayName ? `${displayName}${email ? ` (${email})` : ''}` : (email ?? 'you');
  if (scope === 'repo') {
    await writeCredentials(root, key);
    const hideWarnings = formatHideWarnings(await hidePinsayFiles(root));
    if (!json) for (const line of hideWarnings) console.error(line);
    done(json, { server, scope: 'repo', moved: false, displayName, email },
      `${green(sym.check)} Signed in as ${who}. Key saved in this repo (.pinsay/credentials.env, hidden from git).`);
  }
  await saveGlobalCredential(server, { apiKey: key, email, displayName });
  done(json, { server, scope: 'global', moved: false, displayName, email },
    inRepo || flags.scope === 'global'
      ? `${green(sym.check)} Signed in as ${who}. Key saved on this machine (${globalCredentialsPath()}) for every repo.`
      : `${green(sym.check)} Signed in as ${who}. No repo here, so the key is saved on this machine (${globalCredentialsPath()}) for every repo.`);
}

function done(json: boolean, payload: Record<string, unknown>, message: string): never {
  if (json) console.log(JSON.stringify({ ok: true, ...payload }));
  else console.log(message);
  process.exit(0);
}
