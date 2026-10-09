import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRepoRoot, writeCredentials } from '../config.js';
import { hidePinsayFiles, formatHideWarnings } from '../lib/git-exclude.js';
import { getBranding } from '../branding.js';
import { ask, closePrompts } from '../prompt.js';
import { scopeFromFlags } from '../key-scope.js';
import { resolveServer } from '../server.js';
import { exchangeKey, InvalidKeyError, noKeyMessage } from '../init/session.js';
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
 * Signs in and saves the API key in this repo's `.pinsay/credentials.env` (0600, hidden from git), the only place a key
 * is kept since 0.10.0 (SPEC B2/C2, lead-only).
 *
 *   login                     → this repo. Outside any git repo and any folder with `.pinsay/`: exit 2 (no stray
 *                               `.pinsay/` in a home folder), unless `--scope repo` / `--local-credentials` names this folder.
 *   login --key <key>         → validate a pasted key instead of the browser.
 *   --global, --scope global  → exit 2 (`GLOBAL_KEY_REMOVED`).
 */
export async function loginCommand(cwd: string, options: Record<string, string | boolean> = {}): Promise<void> {
  const json = options['json'] === true;
  const flags = scopeFromFlags(options);
  if (flags.error) exitWithError(2, flags.error, json);

  const root = await findRepoRoot(cwd);
  const inRepo = existsSync(join(root, '.pinsay')) || inGitRepo(root);
  if (!inRepo && !flags.explicitRepo) {
    exitWithError(2, "Run this inside your project's repo: the key is saved there (.pinsay/credentials.env).", json);
  }
  const server = resolveServer();
  const branding = await getBranding(server); // fails fast (exit 4) when the server can't be reached
  const product = branding.productName;

  let flagKey = typeof options['key'] === 'string' ? options['key'].trim() : '';
  if (options['key'] === true) {
    // `--key` with no value: ask with hidden input (keeps the key out of shell history), never the browser.
    if (!process.stdin.isTTY) exitWithError(2, noKeyMessage(product), json);
    flagKey = (await ask(`API key (from ${product} → Profile → API key; input hidden)`, { secret: true })).trim();
    if (!flagKey) exitWithError(2, noKeyMessage(product), json);
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
      exitWithError(3, `That API key is not valid. Check it in ${product} → Profile → API key.`, json);
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
    exitWithError(2, noKeyMessage(product), json);
  }
  closePrompts();

  const who = displayName ? `${displayName}${email ? ` (${email})` : ''}` : (email ?? 'you');
  await writeCredentials(root, key);
  const hideWarnings = formatHideWarnings(await hidePinsayFiles(root));
  if (!json) for (const line of hideWarnings) console.error(line);
  done(json, { server, scope: 'repo', moved: false, displayName, email },
    `${green(sym.check)} Signed in as ${who}. Key saved in this repo (.pinsay/credentials.env, hidden from git).`);
}

function done(json: boolean, payload: Record<string, unknown>, message: string): never {
  if (json) console.log(JSON.stringify({ ok: true, ...payload }));
  else console.log(message);
  process.exit(0);
}
