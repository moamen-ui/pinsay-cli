import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.text();
}

async function download(url: string, dest: string, chmod = false) {
    const txt = await fetchText(url);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.writeFile(dest, txt, 'utf8');
    if (chmod) {
        await fs.chmod(dest, 0o755).catch(() => {});
    }
}

async function makeSymlink(target: string, path: string) {
    await fs.mkdir(dirname(path), { recursive: true });
    try {
        await fs.symlink(target, path);
    } catch (err: any) {
        if (err.code === 'EPERM' && process.platform === 'win32') {
            await fs.copyFile(target, path);
        } else if (err.code !== 'EEXIST') {
            throw err;
        }
    }
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

export async function installSkills(server: string, aiTool: string, cwd: string, overrideDir?: string): Promise<string[]> {
    const files: string[] = [];
    server = server.replace(/\/$/, '');

    await removeLegacyAgentsLayout(cwd);

    // Download pinsay.sh
    const pinsayShPath = join(cwd, '.pinsay', 'pinsay.sh');
    await download(`${server}/pinsay.sh`, pinsayShPath, true);
    files.push('.pinsay/pinsay.sh');

    // A flat-file tool (no folder of its own to put apply.md/translate.md/advanced.md into as
    // siblings) gets everything concatenated into the one rules file instead — see
    // buildFlatPinSayFeedback. An `overrideDir` always writes the folder shape (see finalPath
    // below), regardless of aiTool, so it is excluded here even for cursor/windsurf.
    const isFlatFileTool = !overrideDir && (aiTool === 'cursor' || aiTool === 'windsurf');

    async function writeOrLink(primaryPath: string, skillName: string) {
        const url = skillName === 'pinsay-init' ? `${server}/pinsay-init.md` : `${server}/skill.md`;

        const finalPath = overrideDir ? join(cwd, overrideDir, skillName, 'SKILL.md') : join(cwd, primaryPath);

        if (skillName === 'pinsay-feedback' && isFlatFileTool) {
            const combined = await buildFlatPinSayFeedback(server);
            await fs.mkdir(dirname(finalPath), { recursive: true });
            await fs.writeFile(finalPath, combined, 'utf8');
        } else {
            await download(url, finalPath);
        }
        files.push(overrideDir ? join(overrideDir, skillName, 'SKILL.md') : primaryPath);

        if (!overrideDir && (aiTool === 'claude-code' || aiTool === 'cursor' || aiTool === 'windsurf')) {
            // The standard Agent Skills location, three levels deep (.agents/skills/<name>/SKILL.md)
            // — one deeper than the pre-2026-09-16 layout (.agents/<name>/SKILL.md), so the relative
            // symlink target needs one more `..` to still land back at the repo root.
            const symDest = join(cwd, '.agents', 'skills', skillName, 'SKILL.md');
            await makeSymlink(join('..', '..', '..', primaryPath), symDest);
            files.push(`.agents/skills/${skillName}/SKILL.md`);
        }

        // Folder-capable install (native or overrideDir): apply.md/translate.md/advanced.md land as
        // siblings of SKILL.md in the same folder. A flat-file tool already has all four sections
        // in the one file written above, so there is nothing more to write here.
        if (skillName === 'pinsay-feedback' && !isFlatFileTool) {
            const siblingDir = dirname(finalPath);
            const relDir = overrideDir ? join(overrideDir, skillName) : dirname(primaryPath);
            for (const name of SUB_SKILLS) {
                await download(`${server}/skills/${name}.md`, join(siblingDir, `${name}.md`));
                files.push(join(relDir, `${name}.md`));
            }
        }
    }

    const layout = SKILL_FILES[aiTool] ?? SKILL_FILES.other;
    await writeOrLink(layout[0], 'pinsay-init');
    await writeOrLink(layout[1], 'pinsay-feedback');

    return files;
}
