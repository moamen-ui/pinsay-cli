import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Keeps every file PinSay writes into a user's repository out of `git status`, without touching the
 * repo's tracked `.gitignore` (CEO, 2026-10-07: "users ... never feel there are new files in their
 * repo"). Two layers:
 *  - a marked block in the clone's own ignore list, `.git/info/exclude` (found with
 *    `git rev-parse --git-path info/exclude`, so linked worktrees and submodules work);
 *  - `.pinsay/.gitignore`, which ignores itself and the rest of `.pinsay/`, so a credentials file is
 *    safe even in a folder that only becomes a git repository later.
 * Nothing here ever throws to its caller: a problem becomes `status: 'failed'`.
 */

export const EXCLUDE_BEGIN = '# pinsay-cli: begin (managed by pinsay-cli; rewritten by init/update)';
export const EXCLUDE_END = '# pinsay-cli: end';

/**
 * `.pinsay/` files a team may choose to commit (PLAN § Open questions 1). Empty = hide ALL of `.pinsay/`
 * (CEO's words). To keep them committable instead, set to ['config.json', 'stack.json', 'projects/'].
 */
export const TEAM_FILES: string[] = [];

/** Team files are never reported as "tracked by mistake": a team that committed them did it on purpose. */
const TEAM_FILE_PATHS = ['.pinsay/config.json', '.pinsay/stack.json', '.pinsay/projects/'];

/**
 * Every path PinSay writes outside `.pinsay/`, for every AI tool layout (see SKILL_FILES in skills.ts),
 * relative to the folder `.pinsay/` lives in. Only PinSay's own `pinsay-*` names: never a user's skills.
 */
export const PINSAY_SKILL_PATHS = [
    '.claude/skills/pinsay-init/',
    '.claude/skills/pinsay-feedback/',
    '.agents/skills/pinsay-init/',
    '.agents/skills/pinsay-feedback/',
    // Legacy pre-2026-09-16 layout; installSkills removes it, older clones may still have it.
    '.agents/pinsay-init/',
    '.agents/pinsay-feedback/',
    '.cursor/rules/pinsay-init.md',
    '.cursor/rules/pinsay-feedback.md',
    '.windsurf/rules/pinsay-init.md',
    '.windsurf/rules/pinsay-feedback.md',
];

export interface HideResult {
    status: 'written' | 'unchanged' | 'not-a-repo' | 'failed';
    /** The exclude file, when in a repo. */
    file?: string;
    /** PinSay files git already tracks (exclude can't hide those), repo-relative to cwd with '/'. */
    tracked: string[];
    error?: string;
}

/** Escapes gitignore pattern specials in a literal path. */
function literal(p: string): string {
    return p.replace(/([\\*?[\]!#])/g, '\\$1');
}

/** `{ excludeFile, prefix }` for the repo containing `cwd`, or null outside a repo / without git. */
async function gitInfo(cwd: string): Promise<{ excludeFile: string; prefix: string } | null> {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude', '--show-prefix'], {
            cwd,
            windowsHide: true,
        });
        const [path, prefix = ''] = stdout.split(/\r?\n/);
        if (!path) return null;
        return { excludeFile: resolve(cwd, path.trim()), prefix: prefix.trim() };
    } catch {
        return null;
    }
}

/** Repo-relative extra paths (`--skills-dir` folders, folders a link stub redirected to), cleaned. */
function cleanExtra(extra: string[]): string[] {
    return extra
        .map((e) => e.replace(/\\/g, '/').replace(/^\.\/+/, ''))
        .filter((e) => e !== '' && !e.startsWith('../') && e !== '..' && !/^[A-Za-z]:\//.test(e) && !e.startsWith('/'));
}

/** A `--skills-dir` override's two PinSay folders, for hidePinsayFiles. */
export function skillsDirExtra(dir: string | undefined): string[] {
    if (!dir) return [];
    const d = dir.replace(/\\/g, '/').replace(/\/+$/, '');
    return [`${d}/pinsay-init/`, `${d}/pinsay-feedback/`];
}

/** The lines between the markers, for a `.pinsay/` that lives at `prefix` (from `--show-prefix`). */
export function excludeLines(prefix: string, extra: string[] = []): string[] {
    const p = `/${literal(prefix)}`;
    const pinsay =
        TEAM_FILES.length === 0
            ? [`${p}.pinsay/`]
            : [`${p}.pinsay/*`, ...TEAM_FILES.map((f) => `!${p}.pinsay/${f}`)];
    const lines = [
        ...pinsay,
        ...PINSAY_SKILL_PATHS.map((s) => `${p}${s}`),
        ...cleanExtra(extra).map((e) => `${p}${literal(e)}`),
    ];
    return [...new Set(lines)];
}

/** Content of the self-ignoring `.pinsay/.gitignore`. */
export function pinsayDirGitignore(): string {
    const body = TEAM_FILES.length === 0 ? ['*'] : ['/*', ...TEAM_FILES.map((f) => `!/${f}`)];
    return [
        '# Written by pinsay-cli. Keeps PinSay\'s per-machine files (credentials, scripts, caches) out of git,',
        '# even before this folder is in a git repository. It ignores itself too.',
        ...body,
        '',
    ].join('\n');
}

async function writePinsayDirGitignore(cwd: string): Promise<void> {
    const file = join(cwd, '.pinsay', '.gitignore');
    const want = pinsayDirGitignore();
    const have = await fs.readFile(file, 'utf8').catch(() => null);
    if (have === want) return;
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, want, 'utf8');
}

/** PinSay files git tracks (so exclude can't hide them), except team files. */
export async function trackedPinsayFiles(cwd: string, extra: string[] = []): Promise<string[]> {
    const specs = ['.pinsay', ...PINSAY_SKILL_PATHS, ...cleanExtra(extra)].map((s) => s.replace(/\/$/, ''));
    try {
        const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--', ...specs], { cwd, windowsHide: true });
        return stdout
            .split('\0')
            .filter(Boolean)
            .filter((f) => !TEAM_FILE_PATHS.some((t) => (t.endsWith('/') ? f.startsWith(t) : f === t)))
            .sort();
    } catch {
        return [];
    }
}

/**
 * Writes `.pinsay/.gitignore` and refreshes PinSay's block in `.git/info/exclude` (idempotent). `extra`:
 * repo-relative paths PinSay wrote that the fixed list doesn't cover. Lines of an older block that name a
 * `pinsay-init`/`pinsay-feedback` path are kept (an earlier run's extra paths); everything else in the
 * block is regenerated. Lines outside the block are never changed.
 */
export async function hidePinsayFiles(cwd: string, extra: string[] = []): Promise<HideResult> {
    try {
        await writePinsayDirGitignore(cwd);
    } catch {
        // Best effort: the exclude block below still hides everything inside a repo.
    }

    const info = await gitInfo(cwd);
    if (!info) return { status: 'not-a-repo', tracked: [] };

    let status: HideResult['status'] = 'unchanged';
    let error: string | undefined;
    try {
        const content = await fs.readFile(info.excludeFile, 'utf8').catch(() => '');
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = content === '' ? [] : content.split(/\r?\n/);
        const b = lines.findIndex((l) => l.startsWith('# pinsay-cli: begin'));
        const e = b >= 0 ? lines.indexOf(EXCLUDE_END, b + 1) : -1;
        const kept =
            b >= 0 && e > b
                ? lines.slice(b + 1, e).filter((l) => /\/pinsay-(init|feedback)(\/|\.md)$/.test(l) && !l.startsWith('!'))
                : [];
        const block = [EXCLUDE_BEGIN, ...new Set([...excludeLines(info.prefix, extra), ...kept]), EXCLUDE_END];

        let next: string[];
        if (b >= 0 && e > b) {
            next = [...lines.slice(0, b), ...block, ...lines.slice(e + 1)];
        } else {
            const base = [...lines];
            while (base.length > 0 && base[base.length - 1] === '') base.pop();
            next = [...base, ...(base.length > 0 ? [''] : []), ...block];
        }
        while (next.length > 0 && next[next.length - 1] === '') next.pop();
        const out = next.join(eol) + eol;
        if (out !== content) {
            await fs.mkdir(dirname(info.excludeFile), { recursive: true });
            await fs.writeFile(info.excludeFile, out, 'utf8');
            status = 'written';
        }
    } catch (err) {
        status = 'failed';
        error = err instanceof Error ? err.message : String(err);
    }

    return { status, file: info.excludeFile, tracked: await trackedPinsayFiles(cwd, extra), error };
}

/** Human lines for a HideResult worth telling the user about (failed, or tracked files). Empty otherwise. */
export function formatHideWarnings(r: HideResult): string[] {
    const lines: string[] = [];
    if (r.status === 'failed') {
        lines.push(`⚠ Could not update ${r.file ?? '.git/info/exclude'} (${r.error}), so PinSay's files may show in git status.`);
        lines.push('  Fix: check that file\'s permissions. Then run "npx pinsay-cli update".');
    }
    if (r.tracked.length > 0) {
        lines.push(`⚠ Git already tracks these PinSay files, so they can't be hidden: ${r.tracked.join(', ')}`);
        lines.push(`  To stop tracking them (the files stay on disk), run: git rm -r --cached -- ${r.tracked.join(' ')}`);
    }
    return lines;
}

/** For `doctor`: is PinSay's block present (or is this not a repo)? */
export async function excludeBlockStatus(cwd: string): Promise<'ok' | 'missing' | 'not-a-repo'> {
    const info = await gitInfo(cwd);
    if (!info) return 'not-a-repo';
    const content = await fs.readFile(info.excludeFile, 'utf8').catch(() => '');
    return content.includes(EXCLUDE_END) && /^# pinsay-cli: begin/m.test(content) ? 'ok' : 'missing';
}

/**
 * Removes PinSay's whole block (the `# pinsay-cli: begin` line through `EXCLUDE_END`, inclusive) plus
 * the one blank line `hidePinsayFiles` inserts between the user's lines and the block — the exact
 * inverse of its insertion, so user lines → hidePinsayFiles → removeExcludeBlock reproduces the
 * original bytes. Lines outside the block are never touched. Returns whether a block was found;
 * outside a git repo → false. `dryRun` reports without writing.
 */
export async function removeExcludeBlock(cwd: string, opts: { dryRun?: boolean } = {}): Promise<boolean> {
    const info = await gitInfo(cwd);
    if (!info) return false;
    const content = await fs.readFile(info.excludeFile, 'utf8').catch(() => '');
    const lines = content === '' ? [] : content.split(/\r?\n/);
    const b = lines.findIndex((l) => l.startsWith('# pinsay-cli: begin'));
    if (b < 0) return false;
    const e = lines.indexOf(EXCLUDE_END, b + 1);
    if (e < 0) return false;
    if (opts.dryRun) return true;
    const start = b > 0 && lines[b - 1] === '' ? b - 1 : b;
    const next = [...lines.slice(0, start), ...lines.slice(e + 1)];
    while (next.length > 0 && next[next.length - 1] === '') next.pop();
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const out = next.length > 0 ? next.join(eol) + eol : '';
    if (out !== content) {
        await fs.mkdir(dirname(info.excludeFile), { recursive: true });
        await fs.writeFile(info.excludeFile, out, 'utf8');
    }
    return true;
}
