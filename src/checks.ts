import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig, isMultiProject, listProjects, type PinSayConfig, type ResolvedProject } from './config.js';
import { api, ApiError } from './api.js';
import { detectStack } from './detect.js';
import { resolveRepoPath } from './lib/repo-paths.js';
import { readStamp } from './lib/skill-stamp.js';
import { skillFilesFor } from './lib/skill-paths.js';
import { stackFileRelPath } from './stack/stackfile.js';
import { resolveApiKey, sourceLabel } from './credentials.js';
import { resolveServer } from './server.js';

const execFileAsync = promisify(execFile);

export interface CheckResult {
  id: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  hint?: string;
  /** Set by a check that --fix can repair. */
  fixable?: boolean;
}

export type MetaResponse = {
  version?: string;
  apiVersion?: number;
  minCliVersion?: string;
  latestCliVersion?: string;
  skillVersion?: string | null;
  productName?: string;
  serverTime?: string;
};

/**
 * Compares two semver-ish strings. Returns <0, 0, >0 like a comparator.
 *
 * Hand-rolled because the CLI ships with zero runtime dependencies — a version comparison is not
 * worth an install on a `npx -y` cold start. Pre-release suffixes sort BELOW their release
 * (1.0.0-beta < 1.0.0), which is what semver requires and what makes "is my CLI new enough?"
 * answer correctly for a pre-release build.
 */
/**
 * The one place the "your CLI is too old" wording lives.
 *
 * Every caller must include the upgrade command. Saying only what is wrong leaves the user at a
 * dead end — the CLI is the thing that is out of date, so it is the only party that knows what to
 * run. doctor carried the hint; init, apply and mcp each said only that the version was wrong.
 */
export function tooOldMessage(cliVersion: string, min: string): string {
  return `CLI ${cliVersion} is older than the server requires (${min}). Upgrade with: npx -y pinsay@latest`;
}

export const UPGRADE_HINT = 'Run `npx -y pinsay@latest doctor`';

export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = String(v ?? '0.0.0').trim().replace(/^v/, '').split('-');
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;   // release > pre-release
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** A fetch with a deadline — an unreachable server must fail fast, not hang the whole run. */
async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the install diagnostics. Order matters: `doctor` applies exit-code precedence to the
 * results, and a caller that stops early (CLI too old) must not have run the later checks, whose
 * answers would be meaningless against a newer server.
 *
 * Never throws — a check that cannot run reports `error` with its reason. A diagnostic tool that
 * crashes on a broken install is useless precisely when it is needed.
 */
export async function runInitChecks(
  cwd: string,
  overrides: { server?: string; project?: string } = {},
  cliVersion = '0.0.0',
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const config: PinSayConfig = await readConfig(cwd);
  const server = (overrides.server || resolveServer()).replace(/\/$/, '');
  const multiProject = isMultiProject(config);
  // Single-project mode: the one project this repo has (possibly overridden — legacy behaviour,
  // unchanged). Multi-project mode: every configured project, or just the one `--project` named.
  const allProjects = listProjects(config);
  const projectTargets = multiProject && overrides.project
    ? allProjects.filter((p) => p.key === overrides.project)
    : allProjects;
  const project = overrides.project || config.project || '';
  const environment = config.environment || 'local';

  // config ------------------------------------------------------------------
  if (multiProject) {
    if (server && allProjects.length > 0) {
      checks.push({
        id: 'config',
        status: 'ok',
        message: `${allProjects.length} project${allProjects.length === 1 ? '' : 's'} @ ${server}: ${allProjects.map((p) => p.key).join(', ')}`,
      });
    } else {
      checks.push({
        id: 'config',
        status: 'error',
        message: 'No .pinsay/config.json',
        hint: 'Run `npx -y pinsay-cli init`',
      });
      return checks;
    }
  } else if (server && project) {
    checks.push({ id: 'config', status: 'ok', message: `${project} @ ${server} (${environment})` });
  } else {
    checks.push({
      id: 'config',
      status: 'error',
      message: 'No .pinsay/config.json',
      hint: 'Run `npx -y pinsay-cli init`',
    });
    // Everything below needs a server; there is nothing further to say.
    return checks;
  }

  // server ------------------------------------------------------------------
  let serverReachable = false;
  // Captured here so the extension-delivery check below can reuse it instead of a second request —
  // this endpoint is already fetched to prove the server is reachable at all.
  let branding: { extension?: { storeUrl?: string; zipUrl?: string } } | null = null;
  try {
    const res = await fetchWithTimeout(`${server}/api/branding`, 3000);
    serverReachable = res.ok;
    if (res.ok) {
      try {
        const body = await res.json();
        branding = body?.data !== undefined ? body.data : body;
      } catch {
        // Non-JSON or empty body — the extension check below just won't have a URL to report.
      }
    }
    checks.push(
      res.ok
        ? { id: 'server', status: 'ok', message: `Reached ${server}` }
        : { id: 'server', status: 'error', message: `Cannot reach ${server} (HTTP ${res.status})` },
    );
  } catch {
    checks.push({ id: 'server', status: 'error', message: `Cannot reach ${server}` });
  }

  // meta --------------------------------------------------------------------
  let meta: MetaResponse | null = null;
  if (serverReachable) {
    try {
      meta = await api<MetaResponse>(server, '/api/meta');
      const min = meta?.minCliVersion || '0.0.0';
      if (compareSemver(cliVersion, min) < 0) {
        checks.push({
          id: 'meta',
          status: 'error',
          message: tooOldMessage(cliVersion, min),
          hint: UPGRADE_HINT,
        });
        // Precedence rule 1: stop here. Later checks may be meaningless against a newer server.
        return checks;
      }
      checks.push({ id: 'meta', status: 'ok', message: `Server ${meta?.version ?? 'unknown'} (api v${meta?.apiVersion ?? '?'})` });
    } catch (err: any) {
      checks.push(
        err instanceof ApiError && err.code === 404
          ? { id: 'meta', status: 'warn', message: 'Server predates /api/meta' }
          : { id: 'meta', status: 'warn', message: `Could not read /api/meta: ${err?.message ?? err}` },
      );
    }
  }

  // clock -------------------------------------------------------------------
  if (meta?.serverTime) {
    const skewMs = Math.abs(Date.now() - new Date(meta.serverTime).getTime());
    const skewSeconds = Math.round(skewMs / 1000);
    // The endpoint is cached for 60s, so serverTime can legitimately be that stale. The threshold
    // must stay well above it — never tighten below 2 minutes.
    checks.push(
      skewMs < 5 * 60_000
        ? { id: 'clock', status: 'ok', message: `Clock within ${skewSeconds}s of the server` }
        : { id: 'clock', status: 'warn', message: `Clock skew ${skewSeconds}s — logins may fail` },
    );
  }

  // key ---------------------------------------------------------------------
  const { key: apiKey, source: apiKeySource } = await resolveApiKey(cwd, server);
  let token: string | undefined;
  if (!apiKey) {
    checks.push({
      id: 'key',
      status: 'error',
      message: 'No API key found (env, repo, or global store)',
      hint: 'Run `npx pinsay-cli login`',
    });
  } else if (!serverReachable) {
    checks.push({ id: 'key', status: 'warn', message: 'Server unreachable — key not verified' });
  } else {
    try {
      const login = await api<{ status?: string; token?: string }>(server, '/api/auth/login-with-key', {
        method: 'POST',
        body: { apiKey },
      });
      if (login?.status === 'ok' && login.token) {
        token = login.token;
        checks.push({ id: 'key', status: 'ok', message: `API key accepted (${sourceLabel(apiKeySource)})` });
      } else {
        checks.push({ id: 'key', status: 'error', message: 'API key rejected', hint: 'Regenerate it in Profile → API key' });
      }
    } catch {
      checks.push({ id: 'key', status: 'error', message: 'API key invalid', hint: 'Regenerate it in Profile → API key' });
    }
  }

  // project / widget / extension ---------------------------------------------
  //
  // Single-project mode: exactly as before, one check of each id. Multi-project mode: one of each
  // per configured app (or the one `--project` named), with the key folded into the message so
  // `[tuwaiq-profile] Widget found in apps/profile/src/index.html` reads as belonging to that app.
  for (const target of multiProject ? projectTargets : [{ key: project, path: '.', environment, delivery: config.delivery } as ResolvedProject]) {
    const prefix = multiProject ? `[${target.key}] ` : '';
    const appCwd = multiProject ? join(cwd, target.path) : cwd;

    if (token) {
      try {
        const projects = await api<any[]>(server, '/api/admin/projects', { token });
        const found = projects.find((p) => p.key === target.key);
        if (!found) {
          checks.push({ id: 'project', status: 'error', message: `${prefix}Project ${target.key} not found in this workspace` });
        } else {
          // Reported from the server's row alone — never gated on a configured environment.
          // Environments and their activation are a dashboard concern now (next to the project's
          // URLs); `init` no longer records one to check against, and a repo whose config predates
          // that change should not have doctor keep pretending its `environment` field still means
          // anything.
          const activeEnvs = (['local', 'staging', 'production'] as const).filter((e) => {
            const field = e === 'production' ? 'isActiveProduction' : e === 'staging' ? 'isActiveStaging' : 'isActiveLocal';
            return found[field] === true;
          });
          checks.push(
            activeEnvs.length === 0
              ? {
                  id: 'project',
                  status: 'warn',
                  message: `${prefix}Project ${target.key} not active for any environment`,
                  hint: 'Activate environments in the dashboard',
                }
              : { id: 'project', status: 'ok', message: `${prefix}Project ${target.key} active for: ${activeEnvs.join(', ')}` },
          );
        }
      } catch (err: any) {
        checks.push({ id: 'project', status: 'warn', message: `${prefix}Could not list projects: ${err?.message ?? err}` });
      }
    }

    const perTargetConfig: PinSayConfig = multiProject
      ? { ...config, htmlPath: target.htmlPath, delivery: target.delivery ?? config.delivery }
      : config;
    checks.push(await widgetCheck(appCwd, perTargetConfig, prefix));

    // Only meaningful in extension-delivery installs: the widgetCheck above already reports `ok`
    // there (there is nothing to find in source), but the reviewer still cannot install anything
    // until a super admin sets the Web Store URL. Non-fatal — the install itself is fine either way.
    const effectiveDelivery = target.delivery ?? config.delivery;
    if (effectiveDelivery === 'extension' && serverReachable) {
      const storeUrl = branding?.extension?.storeUrl ?? '';
      if (!storeUrl) {
        checks.push({
          id: 'extension',
          status: 'warn',
          message: `${prefix}Chrome Web Store URL not set`,
          hint: 'Ask the super admin to set the Chrome Web Store URL (Settings → Extension)',
        });
      }
    }

    // stack ------------------------------------------------------------------
    try {
      await fs.access(join(cwd, stackFileRelPath(multiProject ? target.key : undefined)));
      checks.push({ id: 'stack', status: 'ok', message: `${prefix}Stack registered` });
    } catch {
      checks.push({ id: 'stack', status: 'warn', message: `${prefix}Stack not registered`, fixable: true });
    }

    // source-map ---------------------------------------------------------------
    checks.push(await sourceMapCheck(appCwd, prefix));
  }

  // widget-served -----------------------------------------------------------
  if (serverReachable) {
    try {
      const res = await fetchWithTimeout(`${server}/widget.js`, 3000);
      const type = res.headers.get('content-type') || '';
      checks.push(
        res.ok && type.includes('javascript')
          ? { id: 'widget-served', status: 'ok', message: 'Widget script served' }
          : { id: 'widget-served', status: 'error', message: `Widget script not served (HTTP ${res.status})` },
      );
    } catch {
      checks.push({ id: 'widget-served', status: 'error', message: 'Widget script not served' });
    }
  }

  // skills ------------------------------------------------------------------
  checks.push(await skillsCheck(cwd, config));

  // stale ---------------------------------------------------------------------
  // A skill file installed months ago is frozen prose describing an API that has moved on. The
  // developer has no way to notice; the server stamps a version into every served copy so this
  // check can say so. Warning, not error: a stale skill still works, it is just behind.
  if (meta?.skillVersion) {
    const stale: string[] = [];
    for (const rel of skillFilesFor(config)) {
      const abs = join(cwd, rel);
      try {
        await fs.access(abs);
      } catch {
        continue; // not installed for this tool
      }
      if ((await readStamp(abs)) !== meta.skillVersion) stale.push(rel);
    }
    checks.push(
      stale.length === 0
        ? { id: 'stale', status: 'ok', message: `Skills match the server (${meta.skillVersion})` }
        : {
            id: 'stale',
            status: 'warn',
            message: `${stale.length} file${stale.length === 1 ? '' : 's'} behind the server (${meta.skillVersion}): ${stale.join(', ')}`,
            hint: 'Run `npx -y pinsay-cli update`',
          },
    );
  }

  // gitignore ---------------------------------------------------------------
  checks.push(...(await gitignoreChecks(cwd)));

  // `stack` and `source-map` are pushed inside the project/widget/extension loop above — one per
  // project in multi-project mode, matching `stack.json`'s own per-project split.

  return checks;
}

/**
 * Is the component manifest present, when the plugin that needs it is configured?
 *
 * A stale or missing manifest is not cosmetic: every `sourcePath` the widget captured is an opaque
 * hash, and without the manifest nothing can turn one back into a file — the apply step silently
 * degrades to grepping, which is precisely what the stamping exists to avoid.
 */
async function sourceMapCheck(cwd: string, prefix = ''): Promise<CheckResult> {
  const configured = await (async () => {
    for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) {
      const body = await fs.readFile(join(cwd, name), 'utf8').catch(() => '');
      if (body.includes('pinsay/vite')) return true;
    }
    return false;
  })();

  if (!configured) {
    return {
      id: 'source-map',
      status: 'ok',
      message: `${prefix}Source mapping not configured (optional)`,
    };
  }

  try {
    const raw = await fs.readFile(join(cwd, '.pinsay/manifest.json'), 'utf8');
    const count = Object.keys(JSON.parse(raw)?.entries ?? {}).length;
    return count > 0
      ? { id: 'source-map', status: 'ok', message: `${prefix}Source manifest present (${count} components)` }
      : { id: 'source-map', status: 'warn', message: `${prefix}Source manifest is empty`, fixable: true };
  } catch {
    return {
      id: 'source-map',
      status: 'warn',
      message: `${prefix}Source manifest missing — component hashes cannot be resolved to files`,
      fixable: true,
    };
  }
}

/**
 * Warn, never error: a Next or Angular install mounts the widget from a component file this
 * scan does not read, so "not found" is genuinely inconclusive.
 */
async function widgetCheck(cwd: string, config: PinSayConfig = {}, prefix = ''): Promise<CheckResult> {
  if (config.delivery === 'extension') {
    // Nothing was ever injected — that is the point of extension delivery, not a fault. Reporting
    // "Widget not found" here was the exact false warning this mode exists to avoid.
    return {
      id: 'widget',
      status: 'ok',
      message: `${prefix}Extension delivery — the browser extension injects the widget; no embed expected`,
    };
  }

  const detection = await detectStack(cwd).catch(() => null);
  // The recorded path first: init knows where it wrote, and in a monorepo no amount of convention
  // guessing will find apps/<app>/src/index.html.
  const candidates = [config.htmlPath, detection?.htmlPath, 'index.html', 'public/index.html', 'src/index.html'].filter(Boolean) as string[];

  // One level of subdirectories covers the common "app lives in a folder" layout (react/,
  // apps/web/, web/) — typical for skill-routed installs, where nothing recorded the htmlPath.
  try {
    for (const entry of await fs.readdir(cwd, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        candidates.push(join(entry.name, 'index.html'));
      }
    }
  } catch {
    // cwd unreadable — the fixed candidates above still apply.
  }

  for (const rel of candidates) {
    try {
      const html = await fs.readFile(join(cwd, rel), 'utf8');
      if (html.includes('<!-- pinsay-feedback:start -->') || html.includes('<pinsay-feedback')) {
        return { id: 'widget', status: 'ok', message: `${prefix}Widget found in ${rel}` };
      }
    } catch {
      // Missing candidate file is expected — keep looking.
    }
  }

  for (const envFile of ['.env', '.env.local', '.env.development']) {
    try {
      const env = await fs.readFile(join(cwd, envFile), 'utf8');
      if (/^VITE_PINSAY_PROJECT=/m.test(env)) {
        return { id: 'widget', status: 'ok', message: `${prefix}Widget env configured in ${envFile}` };
      }
    } catch {
      // Same — absence is not evidence.
    }
  }

  return {
    id: 'widget',
    status: 'warn',
    message: `${prefix}Widget not found in this app`,
    hint: 'Run `init`, or the pinsay-init skill for framework installs',
  };
}

async function skillsCheck(cwd: string, config: PinSayConfig): Promise<CheckResult> {
  const tool = config.aiTool;
  if (!tool) return { id: 'skills', status: 'warn', message: 'No AI tool configured' };

  // skillFilesFor = exactly the paths installSkills writes (a --skills-dir install included) plus
  // .pinsay/pinsay.sh. Looked up through resolveRepoPath, so an install that went through a link
  // stub (a Git symlink checked out as a plain file on Windows) is found where it really is.
  const missing: string[] = [];
  for (const rel of skillFilesFor(config)) {
    try {
      await fs.access((await resolveRepoPath(cwd, rel, { create: false })).abs);
    } catch {
      missing.push(rel);
    }
  }

  return missing.length === 0
    ? { id: 'skills', status: 'ok', message: `Skills installed for ${tool}` }
    : {
        id: 'skills',
        status: 'warn',
        message: 'Skills not installed — run `npx pinsay-cli update`',
        hint: `Missing: ${missing.join(', ')}`,
        fixable: true,
      };
}

/**
 * Two separate concerns under one id in the contract, and only one of them is an error:
 * missing ignore lines are a warning, but credentials.env actually being TRACKED means the key is
 * in git history and is the single most serious thing doctor can find.
 */
async function gitignoreChecks(cwd: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  let tracked = false;
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '.pinsay/credentials.env'], { cwd });
    tracked = true; // exits 0 only when the file IS tracked
  } catch {
    tracked = false; // non-zero: untracked, or not a git repo at all
  }

  if (tracked) {
    results.push({
      id: 'gitignore',
      status: 'error',
      message: '.pinsay/credentials.env is tracked by git!',
      hint: 'Run `git rm --cached .pinsay/credentials.env`, then rotate the key — it is in your history',
    });
    return results;
  }

  try {
    const ignore = await fs.readFile(join(cwd, '.gitignore'), 'utf8');
    results.push(
      ignore.includes('.pinsay/')
        ? { id: 'gitignore', status: 'ok', message: 'Credentials ignored by git' }
        : { id: 'gitignore', status: 'warn', message: '.gitignore is missing the .pinsay/ entries', fixable: true },
    );
  } catch {
    results.push({ id: 'gitignore', status: 'warn', message: 'No .gitignore found', fixable: true });
  }

  return results;
}
