import { promises as fs } from 'node:fs';
import { join, posix, relative, resolve, sep, isAbsolute } from 'node:path';
import { RepoPathError, linkOrCopy, writeRepoFile } from './lib/repo-paths.js';

/** A failed fetch of a served file. `reason` is short ("HTTP 404", "fetch failed") so warnings group. */
class DownloadError extends Error {
    readonly reason: string;
    constructor(url: string, reason: string) {
        super(`Failed to fetch ${url}: ${reason}`);
        this.name = 'DownloadError';
        this.reason = reason;
    }
}

async function fetchText(url: string): Promise<string> {
    let res: Response;
    try {
        res = await fetch(url);
    } catch (err: any) {
        throw new DownloadError(url, err?.message ?? String(err));
    }
    if (!res.ok) throw new DownloadError(url, `HTTP ${res.status}`);
    return res.text();
}

/** One file PinSay could not install, and what to do about it. `path` is repo-relative with `/`. */
export interface SkillWarning {
    tool: string;
    path: string;
    message: string;
    hint: string;
}

export interface SkillInstallResult {
    /** Repo-relative paths (always `/`) that were written. */
    files: string[];
    /** One per file that was not installed. Empty when everything installed. */
    warnings: SkillWarning[];
    /** Repo-relative paths (with '/') where PinSay files physically landed — for hidePinsayFiles. */
    hide: string[];
}

function toWarning(tool: string, path: string, server: string, err: unknown): SkillWarning {
    if (err instanceof RepoPathError) return { tool, path, message: err.message, hint: err.hint };
    if (err instanceof DownloadError) {
        return {
            tool,
            path,
            message: `could not download the skill files from ${server} (${err.reason}).`,
            hint: 'Check your connection. Then run "npx pinsay-cli update".',
        };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { tool, path, message: `could not install it (${msg}).`, hint: 'Run "npx pinsay-cli update" to try again.' };
}

/**
 * Human lines for skill warnings: one block per distinct problem (same tool, message and hint),
 * listing every file it kept from installing. Callers print them to stderr.
 */
export function formatSkillWarnings(warnings: SkillWarning[]): string[] {
    const groups = new Map<string, { w: SkillWarning; paths: string[] }>();
    for (const w of warnings) {
        const key = `${w.tool}\u0000${w.message}\u0000${w.hint}`;
        const g = groups.get(key);
        if (g) g.paths.push(w.path);
        else groups.set(key, { w, paths: [w.path] });
    }
    const lines: string[] = [];
    for (const { w, paths } of groups.values()) {
        lines.push(`⚠ Skills for ${w.tool}: ${w.message}`);
        lines.push(`  Not installed: ${paths.join(', ')}`);
        lines.push(`  Fix: ${w.hint}`);
    }
    return lines;
}

/**
 * The `pinsay-feedback` skill's sub-files, served at `/skills/<name>.md` alongside the entry file
 * `/skill.md`. `pinsay-init` has no sub-files.
 *
 * A folder-capable install (`claude-code`, `other`, `antigravity`, or any `--skills-dir` override)
 * writes these as siblings of `SKILL.md` in the same `pinsay-feedback/` folder, so the entry file's
 * "read apply.md" references resolve by relative path. A flat-file tool (`cursor`, `windsurf`) has
 * no folder to put siblings in, so `installSkills` concatenates all four into the one rules file
 * instead — see `buildFlatPinSayFeedback`.
 */
export const SUB_SKILLS = ['apply', 'translate', 'advanced'] as const;

const SUB_SKILL_TITLES: Record<(typeof SUB_SKILLS)[number], string> = {
    apply: 'Apply workflow',
    translate: 'Translation',
    advanced: 'Advanced',
};

/**
 * Where each AI tool's two skill files live, relative to the project root.
 *
 * Exported because `doctor` must check exactly the paths `installSkills` writes. When these lived
 * inline in the install routine, the only way to verify an install was to re-derive the layout —
 * and a second copy of a path table drifts.
 *
 * `other` and `antigravity` both use `.agents/skills/<name>/SKILL.md` — the Agent Skills layout
 * read by Antigravity, Codex and other non-Claude, non-Cursor, non-Windsurf tools. Claude Code,
 * Cursor and Windsurf each have their own native location as their PRIMARY path, and additionally
 * get a symlink at this same `.agents/skills/...` path (see `writeOrLink`) so any tool that reads
 * the standard location finds the skill regardless of which tool actually installed it.
 *
 * `claude-code`/`other`/`antigravity` are folder-capable, so their `pinsay-feedback` entry is
 * followed by its three sub-files (`apply.md`, `translate.md`, `advanced.md`) as siblings of
 * `SKILL.md` — `writeOrLink` writes those, this table just documents (and lets `doctor`/`update`
 * check) the paths. `cursor`/`windsurf` have no folder for siblings, so their `pinsay-feedback`
 * entry stays a single flat file that CONTAINS all four sections (see `buildFlatPinSayFeedback`).
 */
export const SKILL_FILES: Record<string, string[]> = {
  'claude-code': [
    '.claude/skills/pinsay-init/SKILL.md',
    '.claude/skills/pinsay-feedback/SKILL.md',
    ...SUB_SKILLS.map((name) => `.claude/skills/pinsay-feedback/${name}.md`),
  ],
  cursor: ['.cursor/rules/pinsay-init.md', '.cursor/rules/pinsay-feedback.md'],
  windsurf: ['.windsurf/rules/pinsay-init.md', '.windsurf/rules/pinsay-feedback.md'],
  other: [
    '.agents/skills/pinsay-init/SKILL.md',
    '.agents/skills/pinsay-feedback/SKILL.md',
    ...SUB_SKILLS.map((name) => `.agents/skills/pinsay-feedback/${name}.md`),
  ],
  antigravity: [
    '.agents/skills/pinsay-init/SKILL.md',
    '.agents/skills/pinsay-feedback/SKILL.md',
    ...SUB_SKILLS.map((name) => `.agents/skills/pinsay-feedback/${name}.md`),
  ],
};

/**
 * Fetches the entry skill (`/skill.md`) plus its three sub-files and concatenates them into the one
 * flat file a rules-file tool (Cursor, Windsurf) needs — the entry first, then each sub-skill under
 * a `## <Title> (<name>.md)` heading preceded by a `<!-- pinsay-skill: <name> -->` marker, so the
 * entry's "read apply.md" style references still resolve by name even without a folder to put them
 * in as siblings.
 */
export async function buildFlatPinSayFeedback(server: string): Promise<string> {
    server = server.replace(/\/$/, '');
    const entry = await fetchText(`${server}/skill.md`);
    const subs = await Promise.all(
        SUB_SKILLS.map(async (name) => ({ name, text: await fetchText(`${server}/skills/${name}.md`) })),
    );

    const parts = [entry.trimEnd()];
    for (const { name, text } of subs) {
        parts.push(
            `---\n\n<!-- pinsay-skill: ${name} -->\n## ${SUB_SKILL_TITLES[name]} (${name}.md)\n\n${text.trim()}`,
        );
    }
    return `${parts.join('\n\n')}\n`;
}

/**
 * Removes the pre-2026-09-16 `.agents/pinsay-init/SKILL.md` / `.agents/pinsay-feedback/SKILL.md`
 * layout (file or symlink), plus its now-empty parent directories, so a repo never ends up
 * carrying both that location and the current `.agents/skills/...` one. Safe to call
 * unconditionally — a repo that never had the old layout simply has nothing to remove.
 */
async function removeLegacyAgentsLayout(cwd: string): Promise<void> {
    for (const name of ['pinsay-init', 'pinsay-feedback']) {
        const filePath = join(cwd, '.agents', name, 'SKILL.md');
        const dirPath = join(cwd, '.agents', name);
        try {
            await fs.rm(filePath, { force: true });
        } catch {
            // Best-effort: a permissions issue here must not block installing the current layout.
        }
        try {
            const remaining = await fs.readdir(dirPath);
            if (remaining.length === 0) await fs.rmdir(dirPath);
        } catch {
            // Directory missing, non-empty, or already gone — nothing to do.
        }
    }
}

/**
 * Installs pinsay.sh and the two skills for `aiTool` (or into `overrideDir`). Never throws for a
 * file-system or download problem: each file is its own step, a failure becomes a `SkillWarning`
 * and the remaining files still install — `init` must never die at its last step because, say,
 * `.claude/skills` is a Git symlink checked out as a plain file on Windows (see repo-paths.ts).
 */
export async function installSkills(
    server: string,
    aiTool: string,
    cwd: string,
    overrideDir?: string,
): Promise<SkillInstallResult> {
    const files: string[] = [];
    const warnings: SkillWarning[] = [];
    const hide: string[] = [];
    server = server.replace(/\/$/, '');

    // Where a file really landed, repo-relative with '/'. A link stub can redirect a write elsewhere in the
    // repo (e.g. docs/skills/pinsay-init/), and that folder must be hidden from git too.
    const landed = (abs: string, folder: boolean) => {
        const rel = relative(resolve(cwd), abs).split(sep).join('/');
        if (rel === '' || rel.startsWith('../') || isAbsolute(rel)) return;
        hide.push(folder ? `${posix.dirname(rel)}/` : rel);
    };

    const step = async (rel: string, work: () => Promise<void>): Promise<void> => {
        try {
            await work();
        } catch (err) {
            warnings.push(toWarning(aiTool, rel, server, err));
        }
    };

    await removeLegacyAgentsLayout(cwd).catch(() => {});

    await step('.pinsay/pinsay.sh', async () => {
        const { abs } = await writeRepoFile(cwd, '.pinsay/pinsay.sh', await fetchText(`${server}/pinsay.sh`));
        await fs.chmod(abs, 0o755).catch(() => {});
        files.push('.pinsay/pinsay.sh');
    });

    // A flat-file tool (no folder of its own to put apply.md/translate.md/advanced.md into as
    // siblings) gets everything concatenated into the one rules file instead — see
    // buildFlatPinSayFeedback. An `overrideDir` always writes the folder shape, regardless of
    // aiTool, so it is excluded here even for cursor/windsurf.
    const isFlatFileTool = !overrideDir && (aiTool === 'cursor' || aiTool === 'windsurf');
    // Returned paths always use '/', on Windows too: they are shown to the user and compared with SKILL_FILES.
    const overrideSlash = overrideDir ? overrideDir.replace(/\\/g, '/') : undefined;

    async function writeOrLink(primaryPath: string, skillName: string) {
        const url = skillName === 'pinsay-init' ? `${server}/pinsay-init.md` : `${server}/skill.md`;
        const rel = overrideSlash ? posix.join(overrideSlash, skillName, 'SKILL.md') : primaryPath;

        let primaryAbs = null as string | null;
        await step(rel, async () => {
            const body =
                skillName === 'pinsay-feedback' && isFlatFileTool
                    ? await buildFlatPinSayFeedback(server)
                    : await fetchText(url);
            primaryAbs = (await writeRepoFile(cwd, rel, body)).abs;
            landed(primaryAbs, !isFlatFileTool);
            files.push(rel);
        });
        // Not written: nothing to mirror or to put siblings next to. The warning already says why.
        if (primaryAbs === null) return;
        const source: string = primaryAbs;

        if (!overrideDir && (aiTool === 'claude-code' || aiTool === 'cursor' || aiTool === 'windsurf')) {
            // The standard Agent Skills location, so any tool that reads it finds the skill. A relative
            // symlink to the primary file, or a copy where links can't be made (see linkOrCopy).
            const mirrorRel = `.agents/skills/${skillName}/SKILL.md`;
            await step(mirrorRel, async () => {
                const m = await linkOrCopy(cwd, source, mirrorRel);
                landed(m.abs, true);
                files.push(mirrorRel);
            });
        }

        // Folder-capable install (native or overrideDir): apply.md/translate.md/advanced.md land as
        // siblings of SKILL.md. A flat-file tool already has all four sections in the one file.
        if (skillName === 'pinsay-feedback' && !isFlatFileTool) {
            const relDir = posix.dirname(rel);
            for (const name of SUB_SKILLS) {
                const subRel = posix.join(relDir, `${name}.md`);
                await step(subRel, async () => {
                    await writeRepoFile(cwd, subRel, await fetchText(`${server}/skills/${name}.md`));
                    files.push(subRel);
                });
            }
        }
    }

    const layout = SKILL_FILES[aiTool] ?? SKILL_FILES.other;
    await writeOrLink(layout[0], 'pinsay-init');
    await writeOrLink(layout[1], 'pinsay-feedback');

    return { files, warnings, hide: [...new Set(hide)] };
}
