import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
    PINSAY_SKILL_PATHS,
    excludeBlockStatus,
    removeExcludeBlock,
    skillsDirExtra,
    trackedPinsayFiles,
} from '../lib/git-exclude.js';
import { readConfig, findRepoRoot } from '../config.js';
import { normalizeServerOrigin, removeGlobalCredential } from '../credentials.js';
import { resolveServer } from '../server.js';
import { exitWithError } from '../errors.js';
import { isInteractive } from '../ui/interactive.js';
import { confirm, closePrompts } from '../prompt.js';
import { dim, green, sym } from '../ui/style.js';

export type Removal = {
    kind: 'path' | 'exclude-block' | 'html-block' | 'env-lines' | 'global-key';
    target: string;
};

/** Config filenames Vite honours, in the order Vite itself resolves them (same list as source-map.ts). */
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'];

const ENV_FILES = ['.env.development', '.env.local'];

const HTML_BLOCK_START = '<!-- pinsay-feedback:start -->';

async function pathExists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

function cleanRel(p: string): string {
    const cleaned = p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    return cleaned === '' ? '.' : cleaned;
}

function joinRel(root: string, rel: string): string | null {
    const abs = resolve(root, rel);
    const back = relative(resolve(root), abs);
    // isAbsolute: on Windows a cross-drive relative() result is an absolute path ('D:\x') — outside root.
    if (back === '' || back.startsWith('..') || isAbsolute(back)) return null;
    return abs;
}

async function readIfExists(p: string): Promise<string | null> {
    return fs.readFile(p, 'utf8').catch(() => null);
}

/** True when `abs`'s realpath stays strictly inside `root` — never write through a symlink that points out of the repo. */
async function writableInsideRoot(root: string, abs: string): Promise<boolean> {
    try {
        const back = relative(resolve(root), await fs.realpath(abs));
        return back !== '' && !back.startsWith('..') && !isAbsolute(back);
    } catch {
        return false;
    }
}

/** Everything PinSay could remove here, without writing anything. Reads config first — it lives in the `.pinsay/` this plans to delete. */
export async function collectRemovals(
    root: string,
    opts: { global: boolean; server: string },
): Promise<{ removals: Removal[]; byHand: string[]; tracked: string[] }> {
    const config = await readConfig(root);
    const removals: Removal[] = [];

    if (await pathExists(join(root, '.pinsay'))) {
        removals.push({ kind: 'path', target: '.pinsay/' });
    }
    for (const p of PINSAY_SKILL_PATHS) {
        if (await pathExists(join(root, p))) removals.push({ kind: 'path', target: p });
    }
    for (const p of skillsDirExtra(config.skillsDir)) {
        const abs = joinRel(root, p);
        if (abs !== null && (await pathExists(abs))) removals.push({ kind: 'path', target: p });
    }

    if ((await excludeBlockStatus(root)) === 'ok') {
        removals.push({ kind: 'exclude-block', target: '.git/info/exclude' });
    }

    const htmlPaths = new Set<string>();
    if (config.htmlPath) htmlPaths.add(cleanRel(config.htmlPath));
    for (const entry of Object.values(config.projects ?? {})) {
        if (entry.htmlPath) htmlPaths.add(cleanRel(entry.htmlPath));
    }
    for (const rel of htmlPaths) {
        const abs = joinRel(root, rel);
        if (!abs) continue;
        const content = await readIfExists(abs);
        if (content !== null && content.includes(HTML_BLOCK_START)) {
            removals.push({ kind: 'html-block', target: rel });
        }
    }

    const multi = !!config.projects && Object.keys(config.projects).length > 0;
    const appDirs = (multi ? Object.values(config.projects!).map((p) => cleanRel(p.path)) : ['.']).filter(
        (d) => d === '.' || joinRel(root, d) !== null,
    );
    for (const appDir of appDirs) {
        for (const envName of ENV_FILES) {
            const rel = appDir === '.' ? envName : `${appDir}/${envName}`;
            const content = await readIfExists(join(root, rel));
            if (content !== null && /^VITE_PINSAY_[A-Z_]*=/m.test(content)) {
                removals.push({ kind: 'env-lines', target: rel });
            }
        }
    }

    if (opts.global) {
        removals.push({ kind: 'global-key', target: normalizeServerOrigin(opts.server) });
    }

    const byHand: string[] = [];
    for (const appDir of appDirs) {
        for (const name of VITE_CONFIGS) {
            const rel = appDir === '.' ? name : `${appDir}/${name}`;
            const content = await readIfExists(join(root, rel));
            if (content !== null && content.includes('pinsay/vite')) byHand.push(rel);
        }
    }

    const tracked = await trackedPinsayFiles(root);
    return { removals, byHand, tracked };
}

/** The exact inverse of injectStatic's insertion: the block went in before `</body>` as `block + '\n'`, or was appended as `'\n' + block`. */
function stripHtmlBlock(content: string): string | null {
    const m = content.match(/<!-- pinsay-feedback:start -->[\s\S]*?<!-- pinsay-feedback:end -->/);
    if (!m || m.index === undefined) return null;
    const rest = content.slice(m.index + m[0].length);
    const bodyMatch = rest.match(/^(\r?\n)<\/body>/i);
    if (bodyMatch) return content.slice(0, m.index) + rest.slice(bodyMatch[1].length);
    if (rest === '' && m.index > 0 && content[m.index - 1] === '\n') return content.slice(0, m.index - 1);
    return content.slice(0, m.index) + rest;
}

async function removeEmptyParents(root: string, abs: string): Promise<void> {
    let dir = dirname(abs);
    const stop = resolve(root);
    while (resolve(dir) !== stop) {
        try {
            await fs.rmdir(dir);
        } catch {
            return;
        }
        dir = dirname(dir);
    }
}

/** One command removes everything PinSay put in this repo — and nothing else — after showing the list and asking (default No). Works offline. */
export async function removeCommand(cwd: string, options: Record<string, string | boolean>): Promise<void> {
    const json = options['json'] === true;
    const interactive = isInteractive(options);
    const server = resolveServer();
    const root = await findRepoRoot(cwd);

    const { removals, byHand, tracked } = await collectRemovals(root, {
        global: options['global'] === true,
        server,
    });

    if (removals.length === 0) {
        if (json) console.log(JSON.stringify({ ok: true, removed: [] }));
        else console.log("This folder isn't set up. Nothing to remove.");
        return;
    }

    if (!json) {
        console.log('Will remove:');
        for (const r of removals) {
            const reason =
                r.kind === 'exclude-block' || r.kind === 'html-block'
                    ? ' (PinSay block)'
                    : r.kind === 'env-lines'
                      ? ' (VITE_PINSAY_* lines)'
                      : r.kind === 'global-key'
                        ? ` (this machine's key for ${r.target})`
                        : '';
            console.log(`  ${r.target}${reason ? dim(reason) : ''}`);
        }
        if (byHand.length > 0) {
            console.log('Remove by hand:');
            for (const f of byHand) console.log(`  ${f} ${dim('(pinsay/vite plugin line)')}`);
        }
        if (tracked.length > 0) {
            console.log(dim('Git tracks some of these; the deletion will show in git status.'));
        }
    }

    if (options['dry-run'] === true) {
        if (json) console.log(JSON.stringify({ ok: true, dryRun: true, removals, byHand }));
        else console.log('Dry run: nothing was removed.');
        return;
    }

    if (interactive) {
        const go = await confirm('Remove these?', { defaultYes: false });
        closePrompts();
        if (!go) {
            console.log('Nothing was removed.');
            process.exit(0);
        }
    } else if (options['yes'] !== true) {
        exitWithError(2, 'Pass --yes to remove without a terminal.', json);
    }

    for (const r of removals) {
        if (r.kind !== 'html-block') continue;
        const abs = joinRel(root, r.target);
        if (!abs) continue;
        const content = await readIfExists(abs);
        if (content === null) continue;
        const next = stripHtmlBlock(content);
        if (next === null || next === content) continue;
        if (await writableInsideRoot(root, abs)) await fs.writeFile(abs, next, 'utf8');
    }

    for (const r of removals) {
        if (r.kind !== 'env-lines') continue;
        const abs = joinRel(root, r.target);
        if (!abs) continue;
        const content = await readIfExists(abs);
        if (content === null) continue;
        const next = content.replace(/^VITE_PINSAY_[A-Z_]*=.*(?:\r?\n)?/gm, '');
        if (next === '') await fs.rm(abs, { force: true });
        else if (next !== content && (await writableInsideRoot(root, abs))) await fs.writeFile(abs, next, 'utf8');
    }

    for (const r of removals) {
        if (r.kind === 'exclude-block') await removeExcludeBlock(root);
    }

    for (const r of removals) {
        if (r.kind !== 'path' || r.target === '.pinsay/') continue;
        const abs = joinRel(root, r.target);
        if (!abs) continue;
        await fs.rm(abs, { recursive: true, force: true });
        await removeEmptyParents(root, abs);
    }

    for (const r of removals) {
        if (r.kind === 'path' && r.target === '.pinsay/') {
            const abs = joinRel(root, r.target);
            if (!abs) continue;
            await fs.rm(abs, { recursive: true, force: true });
        } else if (r.kind === 'global-key') {
            await removeGlobalCredential(server);
        }
    }

    if (json) console.log(JSON.stringify({ ok: true, removed: removals }));
    else console.log(`${green(sym.check)} Removed ${removals.length} item(s).`);
    closePrompts();
    process.exit(0);
}
