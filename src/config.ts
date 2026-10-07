import { promises as fs } from 'node:fs';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';

/**
 * One app inside a multi-project (monorepo) repo. Keyed by the PinSay project key in
 * `PinSayConfig.projects`.
 *
 * There is NO default project in multi-project mode — every app must be named explicitly, unlike
 * single-project mode where `path` is implicitly `.`.
 */
export interface ProjectEntry {
  /** Repo-relative directory this app lives in, e.g. `apps/profile`. Required. */
  path: string;
  /**
   * @deprecated Environments and their activation live in the dashboard now, next to the project's
   * URLs — `init` no longer asks which environment(s) an app runs in, and no longer writes this
   * field. Still read, for an entry written by an install from before this change.
   */
  environment?: string;
  /** @deprecated See `environment` above — same reason, never written any more. */
  environments?: string[];
  htmlPath?: string;
  /** Overrides the repo-level default `delivery` for this app only. */
  delivery?: 'embed' | 'extension';
}

/** A `ProjectEntry` with its key attached — what `listProjects`/`resolveProject` hand back. */
export interface ResolvedProject extends ProjectEntry {
  key: string;
}

export interface PinSayConfig {
  /**
   * Single-project mode only. Multi-project configs (see `projects`) never set this — the project
   * for a given app is only ever a key inside `projects`.
   */
  project?: string;
  /**
   * @deprecated Environments and their activation live in the dashboard now, next to the project's
   * URLs — `init` no longer asks which environment(s) an app runs in, and no longer writes this
   * field (only `--environment`'s explicit, opt-in activation PATCH still reads it, transiently, at
   * install time). Still read here, for a config written by an install from before this change.
   */
  environment?: string;
  /**
   * @deprecated Never written since 0.8.0 — the CLI talks to one server only (see `resolveServer`
   * in server.ts). Still read, only so a config naming ANOTHER server can be refused clearly
   * (`serverSettingError`); a config naming app.pinsay.dev or api.pinsay.dev is accepted as is.
   */
  server?: string;
  aiTool?: string;
  skillsDir?: string;
  cliVersion?: string;
  /**
   * @deprecated Every environment an install covered, when more than one was chosen. Same reason as
   * `environment` above — never written any more, still read for backward compatibility.
   */
  environments?: string[];
  /**
   * Where the widget was actually mounted, relative to the repo root.
   *
   * Recorded because `doctor` otherwise guesses from a fixed list of conventional paths
   * (`index.html`, `src/index.html`, …) and reports "Widget not found" for a monorepo app it was
   * explicitly told about — in the same run that just said it injected there.
   */
  htmlPath?: string;
  /**
   * How reviewers open the widget: `embed` (the `<pinsay-feedback>` loader is injected into the
   * app, today's default) or `extension` (no code injection — reviewers install the Chrome
   * extension and activate it on the tab). `init` always writes this, including `'embed'` for an
   * embed install, so a config missing the field (written by an older CLI) can only mean `embed`.
   *
   * In multi-project mode this is the repo-level DEFAULT; a `ProjectEntry.delivery` overrides it
   * for one app.
   */
  delivery?: 'embed' | 'extension';
  /**
   * Whether the apply skill may hand mechanical edits to a cheaper worker model when the AI tool
   * running it supports sub-agents. `auto` (the default — a config without the field means `auto`)
   * lets the orchestrating agent decide per run under the guardrails spelled out in the served
   * `skills/apply.md`; `off` makes it apply every item itself. Never written by `init` — a team
   * sets it by hand; the CLI only reads it to print it in the `apply` prompt header so the agent
   * sees the setting next to `commitStyle` instead of having to open this file.
   */
  delegation?: 'auto' | 'off';
  /**
   * Multi-project (monorepo) mode. When set and non-empty, `project`/`environment`/`environments`/
   * `htmlPath` above are unused — every app is a keyed entry here instead. `isMultiProject` is the
   * one place that decides which mode a config is in.
   */
  projects?: Record<string, ProjectEntry>;
}

const CONFIG_FILE = '.pinsay/config.json';
const CREDENTIALS_FILE = '.pinsay/credentials.env';

/** True when `config.projects` names at least one app — the multi-project (monorepo) schema. */
export function isMultiProject(config: PinSayConfig): boolean {
  return !!config.projects && Object.keys(config.projects).length > 0;
}

/**
 * Every project this config knows about, uniformly shaped whichever schema it is written in.
 *
 * Single-project mode yields exactly one entry with `path: '.'` (built from the top-level
 * `project`/`environment`/… fields) — or none at all if `project` was never set. Multi-project
 * mode yields one entry per key in `projects`, in insertion order.
 */
export function listProjects(config: PinSayConfig): ResolvedProject[] {
  if (isMultiProject(config)) {
    return Object.entries(config.projects!).map(([key, entry]) => ({ key, ...entry }));
  }
  if (!config.project) return [];
  return [
    {
      key: config.project,
      path: '.',
      environment: config.environment,
      environments: config.environments,
      htmlPath: config.htmlPath,
      delivery: config.delivery,
    },
  ];
}

export type ResolveProjectResult =
  | { ok: true; project: ResolvedProject }
  // `none`: no project configured at all. `not-found`: --project named a key that does not exist.
  // `ambiguous`: several projects exist and neither --project nor cwd picked one out — the caller
  // decides whether to fall back to "every project" or to exit 2.
  | { ok: false; reason: 'none' | 'not-found' | 'ambiguous'; keys: string[] };

/**
 * Resolution order (identical for every command that takes a project): `--project <key>` flag →
 * the project whose `path` contains `cwd` → the only configured project → otherwise ambiguous.
 *
 * `root` is the repo root that holds `.pinsay/config.json` (see `findRepoRoot`) — every
 * `ProjectEntry.path` is relative to it, not to `cwd`.
 */
export function resolveProject(
  config: PinSayConfig,
  cwd: string,
  root: string,
  flag?: string,
): ResolveProjectResult {
  const projects = listProjects(config);

  if (flag) {
    const found = projects.find((p) => p.key === flag);
    return found
      ? { ok: true, project: found }
      : { ok: false, reason: 'not-found', keys: projects.map((p) => p.key) };
  }

  if (projects.length === 0) return { ok: false, reason: 'none', keys: [] };

  // The project whose directory contains cwd, preferring the most specific (deepest) match — a
  // `path: '.'` entry would otherwise "contain" every cwd in the repo.
  const cwdAbs = resolveAbs(cwd);
  let best: ResolvedProject | undefined;
  let bestDepth = -1;
  for (const p of projects) {
    const dirAbs = resolveAbs(join(root, p.path));
    if (cwdAbs === dirAbs || cwdAbs.startsWith(dirAbs + sep)) {
      const depth = dirAbs.split(sep).length;
      if (depth > bestDepth) {
        best = p;
        bestDepth = depth;
      }
    }
  }
  if (best) return { ok: true, project: best };

  if (projects.length === 1) return { ok: true, project: projects[0] };

  return { ok: false, reason: 'ambiguous', keys: projects.map((p) => p.key) };
}

function resolveAbs(p: string): string {
  return isAbsolute(p) ? normalizeTrailingSlash(p) : normalizeTrailingSlash(join(process.cwd(), p));
}

function normalizeTrailingSlash(p: string): string {
  return p.endsWith(sep) && p.length > 1 ? p.slice(0, -1) : p;
}

/**
 * Walks up from `cwd` to find the nearest ancestor holding `.pinsay/config.json`, and returns
 * that directory — the repo root every command must resolve relative paths (project `path`,
 * `.pinsay/*`) against. A monorepo app is routinely run from inside `apps/<x>`, and treating THAT
 * as root would look for `.pinsay/config.json` (and every stack/skill file) in the wrong place.
 *
 * Falls back to `cwd` unchanged when no `.pinsay/config.json` is found anywhere above it — the
 * correct behaviour for `init`'s first run, which is what CREATES that file.
 */
export async function findRepoRoot(cwd: string): Promise<string> {
  let dir = resolveAbs(cwd);
  // A filesystem root's parent is itself; that's the loop's stop condition.
  while (true) {
    try {
      await fs.access(join(dir, '.pinsay', 'config.json'));
      return dir;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

/** Convenience: finds the repo root and reads its config in one call. */
export async function resolveRootAndConfig(
  cwd: string,
): Promise<{ root: string; config: PinSayConfig }> {
  const root = await findRepoRoot(cwd);
  const config = await readConfig(root);
  return { root, config };
}

/**
 * api.pinsay.dev became a legacy alias of https://app.pinsay.dev on 2026-09-28: corporate web
 * filters category-block the unknown "api." subdomain while the app host is allowed. Both reach
 * the same server, so a repo initialised earlier is read as the canonical origin. The file on disk
 * is left alone; the next `init` writes the new value.
 */
export const LEGACY_SERVER = 'https://api.pinsay.dev';
export const CANONICAL_SERVER = 'https://app.pinsay.dev';

export function canonicalServer(server: string): string;
export function canonicalServer(server: string | undefined): string | undefined;
export function canonicalServer(server: string | undefined): string | undefined {
  if (!server) return server;
  return server.replace(/\/+$/, '') === LEGACY_SERVER ? CANONICAL_SERVER : server;
}

export async function readConfig(cwd: string): Promise<PinSayConfig> {
  try {
    const content = await fs.readFile(join(cwd, CONFIG_FILE), 'utf8');
    const config: PinSayConfig = JSON.parse(content);
    if (config.server) config.server = canonicalServer(config.server);
    return config;
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    return {};
  }
}

export async function writeConfig(cwd: string, config: PinSayConfig): Promise<void> {
  const file = join(cwd, CONFIG_FILE);
  await fs.mkdir(dirname(file), { recursive: true });
  const existing = await readConfig(cwd);
  const data = JSON.stringify({ ...existing, ...config }, null, 2) + '\n';
  await fs.writeFile(file, data, 'utf8');
}

/**
 * Writes exactly the given object, with no merge against what is already on disk.
 *
 * `writeConfig` merges — the right default, since almost every write is "add/replace one field".
 * The single→multi migration is the one write that must NOT merge: it drops the single-project
 * `project`/`environment`/`htmlPath` top-level fields in favour of `projects`, and a merge would
 * leave the old fields sitting next to the new map.
 */
export async function writeConfigFull(cwd: string, config: PinSayConfig): Promise<void> {
  const file = join(cwd, CONFIG_FILE);
  await fs.mkdir(dirname(file), { recursive: true });
  const data = JSON.stringify(config, null, 2) + '\n';
  await fs.writeFile(file, data, 'utf8');
}

/**
 * Writes `.pinsay/credentials.env`: the key, plus PINSAY_PROJECT when known (`.pinsay/pinsay.sh`, the no-Node
 * fallback, reads the project from here in repos with no `.env`). No PINSAY_SERVER line since 0.8.0: there is one
 * server.
 *
 * Called only when `init` writes the key locally — a `--local-credentials` install, or the answer
 * "no" to "save this key for all repos on this machine?". When the key is instead saved to the
 * global per-machine store (see `credentials.ts`), `init` skips this call entirely: there is no
 * local secret to gitignore. `credentials.env.example` — a template for a file that may not even
 * exist — was dropped along with it; it never held anything but empty placeholders.
 */
export async function writeCredentials(
  cwd: string,
  token: string,
  extra: { project?: string } = {},
): Promise<void> {
  const file = join(cwd, CREDENTIALS_FILE);
  await fs.mkdir(dirname(file), { recursive: true });
  const lines = [`PINSAY_API_KEY=${token}`];
  if (extra.project) lines.push(`PINSAY_PROJECT=${extra.project}`);
  await fs.writeFile(file, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
}

/**
 * Legacy per-repo files an earlier CLI version wrote and no longer does — a repo installed before
 * this version still has them lying around until `init`/`update` clean them up. `credentials.env`
 * itself (the one file this list must never include) is untouched either way: `credentials.env.example`
 * was only ever a template of empty placeholders, dropped once every clone installs its own
 * `credentials.env` instead of committing one; `.token_cache` was the pre-global-store JWT cache
 * (see `tokenCacheFile` in credentials.ts).
 */
const LEGACY_REPO_FILES = ['.pinsay/credentials.env.example', '.pinsay/.token_cache'];

/**
 * Deletes whichever of `LEGACY_REPO_FILES` are present under `cwd`, returning the repo-relative
 * paths actually removed (for the caller to report, one dim line per file) — never
 * `.pinsay/credentials.env`, and never an error for a repo that never had these files at all.
 */
export async function removeLegacyRepoFiles(cwd: string): Promise<string[]> {
  const removed: string[] = [];
  for (const rel of LEGACY_REPO_FILES) {
    const abs = join(cwd, rel);
    try {
      await fs.access(abs);
    } catch {
      continue;
    }
    try {
      await fs.rm(abs, { force: true });
      removed.push(rel);
    } catch {
      // best-effort — a permissions error here must not block init/update
    }
  }
  return removed;
}
