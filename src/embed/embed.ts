import { promises as fs, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { detectStack, type AppType } from '../detect.js';
import { injectVite, injectStatic } from '../inject/index.js';
import { api } from '../api.js';

export type EmbedPlan = {
    kind: 'inject' | 'skill' | 'already';
    appDir: string;
    htmlPath?: string;
    files: string[];
    stackKind: AppType;
    vite: boolean;
};

const START_MARKER = '<!-- pinsay-feedback:start -->';

function posix(p: string): string {
    return p.split(sep).join('/');
}

/** Repo-relative, forward-slash form of a path that is absolute or relative to the repo root. */
function toRepoRelative(root: string, p: string): string {
    return posix(relative(root, resolve(root, p)));
}

/**
 * Is the widget already in this app's HTML? Tried in order (first match wins): the recorded HTML
 * path, `index.html`, `src/index.html`, `public/index.html`. A file also matches on the start marker alone (the Vite form has no literal tag). `marked` is true when the block is
 * one `pinsay-cli` wrote (it carries the start marker), false for a hand-placed snippet.
 */
export async function findExistingWidget(
    appCwd: string,
    recordedHtml?: string,
): Promise<{ file: string; marked: boolean } | null> {
    const candidates = [...(recordedHtml ? [recordedHtml] : []), 'index.html', 'src/index.html', 'public/index.html'];
    for (const rel of candidates) {
        const content = await fs.readFile(join(appCwd, rel), 'utf8').catch(() => null);
        if (content !== null && (content.includes('<pinsay-feedback') || content.includes(START_MARKER))) {
            return { file: posix(rel), marked: content.includes(START_MARKER) };
        }
    }
    return null;
}

async function readJsonSafe(p: string): Promise<any | null> {
    try {
        return JSON.parse(await fs.readFile(p, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * The HTML file to inject into for one app, tried in order: an explicit `--html` (used as-is,
 * trusted — `injectStatic`/`injectVite` themselves report a clear error if it does not exist),
 * `<appDir>/index.html`, `<appDir>/src/index.html` (the real shape of every app in an Nx workspace
 * like tuwaiq-mono-spa — `detectStack`'s own `<cwd>/index.html`-only check misses this entirely,
 * and an app directory with no `package.json` of its own never resolves to a `vite`/`static` kind
 * in the first place, so injection silently did nothing), `<sourceRoot>/index.html` when the app's
 * `project.json` declares a `sourceRoot` (Nx's own field for exactly this, relative to the repo
 * root rather than the app directory), then `<appDir>/public/index.html` (CRA/Nx-with-webpack).
 * Returns the first that exists, or `undefined` if none do.
 */
export async function resolveHtmlCandidate(root: string, appDir: string, explicitHtml?: string): Promise<string | undefined> {
    if (explicitHtml) return explicitHtml;

    const targetCwd = join(root, appDir);
    const candidates = [join(targetCwd, 'index.html'), join(targetCwd, 'src', 'index.html')];

    const projectJson = await readJsonSafe(join(targetCwd, 'project.json'));
    if (projectJson?.sourceRoot) {
        candidates.push(join(root, projectJson.sourceRoot, 'index.html'));
    }

    candidates.push(join(targetCwd, 'public', 'index.html'));

    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return undefined;
}

/** Does this app directory have its own Vite config? Decides `injectVite` vs `injectStatic`. */
export async function hasViteConfig(appDir: string): Promise<boolean> {
    for (const ext of ['ts', 'js', 'mjs', 'mts']) {
        if (existsSync(join(appDir, `vite.config.${ext}`))) return true;
    }
    return false;
}

/** `--pin`, resolved once per repo (a single manifest fetch) and shared by every app this run
 *  injects into. */
export async function resolvePin(server: string, pin: boolean): Promise<{ version: string; integrity: string } | null> {
    if (!pin) return null;
    try {
        const manifest = await api<any>(server, '/pinsay.version.json');
        const version = manifest?.hash;
        const integrity = manifest?.files?.['widget.js']?.integrity;
        if (!version || !integrity) throw new Error('the server published no hash/integrity for widget.js');
        return { version, integrity };
    } catch (err: any) {
        console.error(
            `Could not pin the widget: ${err?.message ?? err}. Re-run without --pin to install the floating build.`,
        );
        process.exit(1);
    }
}

/** The env file `injectVite` writes: an existing `.env.development`, else `.env.local`, else a new `.env.development`. */
function viteEnvFile(appCwd: string): string {
    for (const name of ['.env.development', '.env.local']) {
        if (existsSync(join(appCwd, name))) return name;
    }
    return '.env.development';
}

/** Decides which files an embed would change, without writing anything. */
export async function planEmbed(
    root: string,
    opts: { appDir?: string; html?: string; recordedHtml?: string; forInit?: boolean },
): Promise<EmbedPlan> {
    const appDir = opts.appDir ?? '.';
    const appCwd = join(root, appDir);

    const stack = await detectStack(appCwd);
    const vite = stack.kind === 'vite' || (await hasViteConfig(appCwd));

    const recordedRel = opts.recordedHtml ? posix(relative(appCwd, resolve(root, opts.recordedHtml))) : undefined;
    const existing = await findExistingWidget(appCwd, recordedRel);
    if (existing && (!existing.marked || opts.forInit)) {
        return {
            kind: 'already',
            appDir,
            htmlPath: posix(join(appDir, existing.file)),
            files: [],
            stackKind: stack.kind,
            vite,
        };
    }

    let html: string | undefined;
    if (opts.html) {
        html = opts.html;
    } else if (appDir === '.' && (stack.kind === 'vite' || stack.kind === 'static')) {
        html = stack.htmlPath ?? join(appCwd, 'index.html');
    } else if (appDir !== '.') {
        html = await resolveHtmlCandidate(root, appDir);
    }

    if (html && (vite || stack.kind === 'static' || opts.html || appDir !== '.')) {
        const htmlRel = toRepoRelative(root, html);
        const files = [htmlRel];
        if (vite) files.push(posix(join(appDir, viteEnvFile(appCwd))));
        return { kind: 'inject', appDir, htmlPath: htmlRel, files, stackKind: stack.kind, vite };
    }
    return { kind: 'skill', appDir, files: [], stackKind: stack.kind, vite };
}

/** Writes the widget into the planned HTML file (and the Vite env file). Nothing to do for other kinds. */
export async function runEmbed(
    root: string,
    plan: EmbedPlan,
    cfg: { server: string; key: string; pin: { version: string; integrity: string } | null },
): Promise<{ files: string[]; htmlPath?: string }> {
    if (plan.kind !== 'inject' || !plan.htmlPath) return { files: [] };
    const appCwd = join(root, plan.appDir);
    const absHtml = resolve(root, plan.htmlPath);

    if (plan.vite) {
        const written = await injectVite(
            appCwd,
            { server: cfg.server, key: cfg.key, environment: 'local', pin: cfg.pin, environmentPinned: false },
            absHtml,
        );
        // injectVite reports the HTML as a bare 'index.html'; the planned path is the real one.
        const rest = written.slice(1).map((f) => posix(join(plan.appDir, f)));
        return { files: [plan.htmlPath, ...rest], htmlPath: plan.htmlPath };
    }
    const written = await injectStatic(appCwd, absHtml, {
        server: cfg.server,
        key: cfg.key,
        environment: 'local',
        pin: cfg.pin,
        environments: ['local'],
        environmentPinned: false,
    });
    return { files: [toRepoRelative(root, written)], htmlPath: plan.htmlPath };
}
