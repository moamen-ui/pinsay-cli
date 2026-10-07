import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Safe paths inside the user's repository for files PinSay writes (skills, pinsay.sh).
 *
 * `fs.mkdir(dir, { recursive: true })` throws ENOTDIR when a folder on the way is not a folder:
 * a regular file, or a link whose target is missing. The usual Windows case is a repo that
 * commits `.claude/skills` as a Git symlink: Git for Windows without symlink support
 * (core.symlinks=false) checks it out as a plain text file holding the link target. This module
 * walks the path one segment at a time and decides what to do with each, the same way on every OS:
 * follow a link stub or a broken link to its target when that target is inside the repo, and
 * otherwise stop with a `RepoPathError` that says what is in the way and how to fix it.
 * It never deletes, renames or rewrites anything the user owns.
 */

export type RepoPathProblem =
    | 'file-in-the-way'
    | 'link-outside-repo'
    | 'link-loop'
    | 'directory-in-the-way'
    | 'io-error';

export class RepoPathError extends Error {
    readonly kind: RepoPathProblem;
    /** Repo-relative path of what is in the way, always with `/`. */
    readonly blocker: string;
    /** What the user should do, as commands that work in PowerShell, cmd and POSIX shells. */
    readonly hint: string;

    constructor(kind: RepoPathProblem, blocker: string, message: string, hint: string) {
        super(message);
        this.name = 'RepoPathError';
        this.kind = kind;
        this.blocker = blocker;
        this.hint = hint;
    }
}

export interface ResolvedRepoPath {
    /** Where to read or write. */
    abs: string;
    /** Repo-relative path (with `/`) of the first link stub or broken link that was followed. */
    redirectedVia?: string;
}

const MAX_HOPS = 8;
const STUB_MAX_BYTES = 1024;
const THEN_UPDATE = 'Then run "npx pinsay-cli update".';

function toSlash(p: string): string {
    return p.split(sep).join('/');
}

/** `p`'s segments below `base`, or null when `p` is not inside `base`. */
function segmentsBelow(base: string, p: string): string[] | null {
    const rel = relative(base, p);
    if (rel === '') return [];
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return rel.split(sep).filter(Boolean);
}

/** The repo root as given and, when different, its real path (macOS tmp dirs live under a link). */
async function rootForms(root: string): Promise<string[]> {
    const abs = resolve(root);
    const real = await fs.realpath(abs).catch(() => abs);
    return real === abs ? [abs] : [abs, real];
}

function segmentsInRepo(roots: string[], target: string): string[] | null {
    for (const r of roots) {
        const s = segmentsBelow(r, target);
        if (s !== null) return s;
    }
    return null;
}

/** Same path? Case-insensitive on Windows. */
export function samePath(a: string, b: string): boolean {
    const x = resolve(a);
    const y = resolve(b);
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

async function realOr(p: string): Promise<string> {
    return fs.realpath(p).catch(() => resolve(p));
}

/** True when Git tracks `abs` as a symlink (index mode 120000). False when git is missing or it is not tracked. */
async function isGitSymlink(rootAbs: string, abs: string): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync('git', ['ls-files', '-s', '--', toSlash(relative(rootAbs, abs))], {
            cwd: rootAbs,
            windowsHide: true,
        });
        return stdout.startsWith('120000 ');
    } catch {
        return false;
    }
}

/**
 * If the regular file `abs` stands for a link (a Git symlink checked out as text), returns the absolute
 * path it points to; otherwise null. It is a stub when it is small, one line, and either Git tracks it
 * as a symlink or the path it names already exists as a folder — so arbitrary text never makes PinSay
 * create folders.
 */
export async function linkStubTarget(rootAbs: string, abs: string): Promise<string | null> {
    let st;
    try {
        st = await fs.lstat(abs);
    } catch {
        return null;
    }
    if (!st.isFile() || st.size === 0 || st.size > STUB_MAX_BYTES) return null;
    const text = (await fs.readFile(abs, 'utf8')).replace(/\r?\n$/, '');
    if (text === '' || /[\r\n\0]/.test(text)) return null;
    const target = resolve(dirname(abs), text.replace(/\\/g, '/'));
    if (await isGitSymlink(rootAbs, abs)) return target;
    try {
        if ((await fs.stat(target)).isDirectory()) return target;
    } catch {
        // Target missing: not provably a link, so it stays a file in the way.
    }
    return null;
}

function fileInTheWay(blocker: string, what: string): RepoPathError {
    return new RepoPathError(
        'file-in-the-way',
        blocker,
        `${blocker} ${what}, not a folder, so the skills can't go inside it. PinSay left it unchanged.`,
        `If ${blocker} is a Git symlink checked out as a plain file (Windows without symlink support): turn on Developer Mode, then run "git config core.symlinks true" and "git checkout -- ${blocker}". Otherwise move it away. ${THEN_UPDATE}`,
    );
}

function outsideRepo(blocker: string, target: string): RepoPathError {
    return new RepoPathError(
        'link-outside-repo',
        blocker,
        `${blocker} points to ${target}, outside this repository. PinSay only writes inside the repository and left it unchanged.`,
        `Fix or remove the link, or choose another folder with "npx pinsay-cli init --skills-dir <folder>". ${THEN_UPDATE}`,
    );
}

function linkLoop(blocker: string): RepoPathError {
    return new RepoPathError(
        'link-loop',
        blocker,
        `${blocker} starts a chain of links PinSay could not follow (more than ${MAX_HOPS} links, or a loop). PinSay left it unchanged.`,
        `Fix the links. ${THEN_UPDATE}`,
    );
}

function dirInTheWay(blocker: string): RepoPathError {
    return new RepoPathError(
        'directory-in-the-way',
        blocker,
        `${blocker} is a folder where PinSay writes a file. PinSay left it unchanged.`,
        `Move the folder away. ${THEN_UPDATE}`,
    );
}

function ioError(blocker: string, err: unknown): RepoPathError {
    const msg = err instanceof Error ? err.message : String(err);
    return new RepoPathError(
        'io-error',
        blocker,
        `could not write ${blocker} (${msg}).`,
        `Check the folder's permissions, or close programs that lock it. ${THEN_UPDATE}`,
    );
}

/**
 * Resolves the repo-relative file path `rel` (separators `/` or `\`) to where it really lives,
 * creating missing folders when `opts.create` is set. See the module comment for the rules.
 * A lookup (`create: false`) never creates anything: at the first missing folder it returns the
 * plain path, so the caller's `fs.access` fails as usual.
 */
export async function resolveRepoPath(
    root: string,
    rel: string,
    opts: { create: boolean },
): Promise<ResolvedRepoPath> {
    const roots = await rootForms(root);
    const rootAbs = roots[0];
    const naive = resolve(rootAbs, rel.replace(/\\/g, '/'));
    const below = segmentsBelow(rootAbs, naive);
    if (below === null || below.length === 0) {
        // Outside the repository: only an explicit `--skills-dir ../x` or an absolute path gets here.
        // The user chose it, so it keeps the plain mkdir -p behaviour.
        if (opts.create) await fs.mkdir(dirname(naive), { recursive: true });
        return { abs: naive };
    }

    let segments = below;
    const fileName = segments.pop() as string;
    const shown = (p: string) => toSlash(relative(rootAbs, p)) || '.';
    let cur = rootAbs;
    let i = 0;
    let hops = 0;
    let redirectedVia: string | undefined;

    while (i < segments.length) {
        const next = join(cur, segments[i]);
        let st;
        try {
            st = await fs.lstat(next);
        } catch (err: any) {
            if (err?.code !== 'ENOENT') throw ioError(shown(next), err);
            if (!opts.create) return { abs: join(next, ...segments.slice(i + 1), fileName), redirectedVia };
            try {
                await fs.mkdir(next);
            } catch (e: any) {
                if (e?.code !== 'EEXIST') throw ioError(shown(next), e);
            }
            continue; // look again at what is there now
        }

        if (st.isDirectory()) {
            cur = next;
            i++;
            continue;
        }

        let target: string;
        if (st.isSymbolicLink()) {
            const live = await fs.stat(next).catch(() => null);
            if (live?.isDirectory()) {
                cur = next;
                i++;
                continue;
            }
            if (live) throw fileInTheWay(shown(next), 'points to a file');
            // A broken link or junction: follow it by hand, so the folder it names gets created.
            let raw: string;
            try {
                raw = await fs.readlink(next);
            } catch (e) {
                throw ioError(shown(next), e);
            }
            target = resolve(dirname(next), raw);
        } else if (st.isFile()) {
            const stub = await linkStubTarget(rootAbs, next);
            if (stub === null) throw fileInTheWay(shown(next), 'is a file');
            target = stub;
        } else {
            throw fileInTheWay(shown(next), 'is not a folder');
        }

        const targetSegments = segmentsInRepo(roots, target);
        if (targetSegments === null) throw outsideRepo(shown(next), target);
        hops++;
        if (hops > MAX_HOPS) throw linkLoop(redirectedVia ?? shown(next));
        redirectedVia ??= shown(next);
        segments = [...targetSegments, ...segments.slice(i + 1)];
        cur = rootAbs;
        i = 0;
    }

    return { abs: join(cur, fileName), redirectedVia };
}

/**
 * Writes `content` to the repo-relative `rel`, through `resolveRepoPath`. At the final path: a folder
 * stops it; a broken link is replaced (it holds no data); a live link is written through (kept).
 */
export async function writeRepoFile(root: string, rel: string, content: string): Promise<ResolvedRepoPath> {
    const r = await resolveRepoPath(root, rel, { create: true });
    const shown = toSlash(relative(resolve(root), r.abs));
    const st = await fs.lstat(r.abs).catch(() => null);
    if (st?.isDirectory()) throw dirInTheWay(shown);
    try {
        if (st?.isSymbolicLink() && !(await fs.stat(r.abs).catch(() => null))) await fs.unlink(r.abs);
        await fs.writeFile(r.abs, content, 'utf8');
    } catch (err) {
        throw ioError(shown, err);
    }
    return r;
}

/**
 * Makes `destRel` (a PinSay-owned path such as `.agents/skills/pinsay-init/SKILL.md`) a relative
 * symlink to `sourceAbs`, or a copy of it when links can't be made (Windows without Developer Mode
 * or admin: EPERM; filesystems without links). `same`: dest already IS the source file, e.g. because
 * `.claude/skills` was a link stub to `.agents/skills` — nothing to do.
 */
export async function linkOrCopy(
    root: string,
    sourceAbs: string,
    destRel: string,
): Promise<{ abs: string; mode: 'link' | 'copy' | 'same' }> {
    const dest = await resolveRepoPath(root, destRel, { create: true });
    const shown = toSlash(relative(resolve(root), dest.abs));
    const sourceReal = await realOr(sourceAbs);
    const st = await fs.lstat(dest.abs).catch(() => null);

    if (st && samePath(await realOr(dest.abs), sourceReal) && !st.isSymbolicLink()) {
        return { abs: dest.abs, mode: 'same' };
    }
    if (st?.isDirectory()) throw dirInTheWay(shown);
    try {
        if (st?.isSymbolicLink()) {
            const real = await fs.realpath(dest.abs).catch(() => null);
            if (real !== null && samePath(real, sourceReal)) return { abs: dest.abs, mode: 'link' };
            await fs.unlink(dest.abs); // a stale or broken link at a PinSay-owned path
        } else if (st) {
            await fs.unlink(dest.abs); // an earlier copy at a PinSay-owned path
        }
    } catch (err) {
        throw ioError(shown, err);
    }

    try {
        await fs.symlink(relative(dirname(dest.abs), sourceAbs), dest.abs, 'file');
        return { abs: dest.abs, mode: 'link' };
    } catch {
        try {
            await fs.copyFile(sourceAbs, dest.abs);
        } catch (err) {
            throw ioError(shown, err);
        }
        return { abs: dest.abs, mode: 'copy' };
    }
}
