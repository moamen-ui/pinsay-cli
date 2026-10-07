import { promises as fs } from 'node:fs';
import { readConfig, isMultiProject, removeLegacyRepoFiles } from '../config.js';
import { api } from '../api.js';
import { readStamp } from '../lib/skill-stamp.js';
import { skillFilesFor } from '../lib/skill-paths.js';
import { installSkills, buildFlatPinSayFeedback, formatSkillWarnings } from '../skills.js';
import { resolveRepoPath } from '../lib/repo-paths.js';
import type { MetaResponse } from '../checks.js';
import { resolveServer } from '../server.js';

export interface UpdateOptions {
  server?: string;
  check?: boolean;
}

/**
 * Which served file backs each installed path. `null` means the path needs its own fetch logic
 * instead of a straight body copy — see the flat-file (Cursor/Windsurf) case in the stale loop
 * below, where `pinsay-feedback`'s single rules file is rebuilt from all four served sources
 * (skill.md + the three skills/*.md sub-files), not overwritten with just `/skill.md`'s body.
 */
function sourceFor(path: string): string | null {
  if (path.endsWith('pinsay.sh')) return '/pinsay.sh';
  if (path.includes('pinsay-init')) return '/pinsay-init.md';
  if (path.endsWith('/apply.md')) return '/skills/apply.md';
  if (path.endsWith('/translate.md')) return '/skills/translate.md';
  if (path.endsWith('/advanced.md')) return '/skills/advanced.md';
  if (path.includes('pinsay-feedback')) return '/skill.md';
  return null;
}

/** True for the single flat pinsay-feedback rules file a Cursor/Windsurf install writes — see
 * `buildFlatPinSayFeedback`. That file must be rebuilt from all four served sources on refresh,
 * not overwritten with just `/skill.md`'s body (which would drop the concatenated sub-sections). */
function isFlatPinSayFeedbackFile(path: string, aiTool: string | undefined, skillsDir: string | undefined): boolean {
  return !skillsDir && (aiTool === 'cursor' || aiTool === 'windsurf') && path.endsWith('pinsay-feedback.md');
}

/**
 * Refreshes the served skills and pinsay.sh in place, and installs them when they are missing
 * entirely.
 *
 * A skill file installed months ago is frozen prose describing an API that has moved on — the
 * problem the version stamp exists to make visible and this command exists to fix. Since skills
 * and pinsay.sh are gitignored (derived, per-machine state — see `config.ts`'s
 * `upsertGitignore`), a fresh clone of a repo that already has PinSay set up has NEITHER: there
 * is nothing to refresh, only something to install, which used to be silently skipped here.
 *
 * Symlinks are preserved deliberately: installSkills points `.agents/<name>/SKILL.md` at the
 * tool-specific copy for several tools, so writing through the link keeps that arrangement intact,
 * whereas replacing the file would break it.
 */
export async function updateCommand(cwd: string, options: UpdateOptions): Promise<number> {
  // A repo installed by an older CLI may still have files that version wrote and this one no
  // longer does — see `removeLegacyRepoFiles`. Unconditional: this must happen whether or not the
  // rest of the command finds anything to update.
  const removedLegacyFiles = await removeLegacyRepoFiles(cwd);
  for (const f of removedLegacyFiles) console.log(`\x1b[2mremoved legacy ${f}\x1b[0m`);

  const config = await readConfig(cwd);
  const server = (options.server || resolveServer()).replace(/\/$/, '');

  if (!config.project && !isMultiProject(config)) {
    console.error('No .pinsay/config.json here — run `npx -y pinsay-cli init` first.');
    return 1;
  }

  let served: string | null = null;
  try {
    const meta = await api<MetaResponse>(server, '/api/meta');
    served = meta?.skillVersion ?? null;
  } catch {
    console.error(`Could not reach ${server}.`);
    return 1;
  }

  const files = skillFilesFor(config);
  const missing: string[] = [];
  const stale: { path: string; installed: string | null }[] = [];

  for (const rel of files) {
    let abs: string;
    try {
      abs = (await resolveRepoPath(cwd, rel, { create: false })).abs;
      await fs.access(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    const installed = await readStamp(abs);
    if (installed !== served) stale.push({ path: rel, installed });
  }

  if (missing.length === 0 && stale.length === 0) {
    console.log(`Up to date (skill version ${served ?? 'unknown'}).`);
    return 0;
  }

  if (options.check) {
    if (missing.length > 0) {
      console.log(`${missing.length} file${missing.length === 1 ? '' : 's'} not installed:`);
      for (const f of missing) console.log(`  ${f}`);
    }
    if (stale.length > 0) {
      console.log(`${stale.length} file${stale.length === 1 ? '' : 's'} out of date (server ${served ?? 'unknown'}):`);
      for (const f of stale) console.log(`  ${f.path} (${f.installed ?? 'unstamped'})`);
    }
    return 0;
  }

  let installedCount = 0;
  if (missing.length > 0) {
    if (!config.aiTool) {
      // No tool recorded at all (a config written before `aiTool` existed, and never re-run
      // through `init`): there is nothing to tell `installSkills` to install FOR.
      console.error('No AI tool configured — run `npx -y pinsay-cli init` to record one, then `update` again.');
    } else {
      try {
        const r = await installSkills(server, config.aiTool, cwd, config.skillsDir);
        for (const line of formatSkillWarnings(r.warnings)) console.error(line);
      } catch (err: any) {
        console.error(`  failed to install missing skills: ${err?.message ?? err}`);
      }
      // Count what is really there now, not what we hoped to write.
      const nowPresent: string[] = [];
      for (const rel of missing) {
        try {
          await fs.access((await resolveRepoPath(cwd, rel, { create: false })).abs);
          nowPresent.push(rel);
        } catch {
          // still missing — the warning above says why
        }
      }
      installedCount = nowPresent.length;
      if (installedCount > 0) {
        console.log(`installed ${installedCount} file${installedCount === 1 ? '' : 's'}: ${nowPresent.join(', ')}`);
      }
    }
  }

  let updated = 0;
  const from = stale[0]?.installed ?? 'unstamped';

  for (const f of stale) {
    const flat = isFlatPinSayFeedbackFile(f.path, config.aiTool, config.skillsDir);
    const source = sourceFor(f.path);
    if (!flat && !source) continue;
    try {
      let body: string;
      if (flat) {
        body = await buildFlatPinSayFeedback(server);
      } else {
        const res = await fetch(`${server}${source}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = await res.text();
      }

      const abs = (await resolveRepoPath(cwd, f.path, { create: true })).abs;
      // Writing through the path (not unlink+create) is what preserves a symlink.
      await fs.writeFile(abs, body, 'utf8');
      if (abs.endsWith('.sh')) await fs.chmod(abs, 0o755).catch(() => {});
      updated++;
    } catch (err: any) {
      console.error(`  failed to update ${f.path}: ${err?.message ?? err}`);
    }
  }

  if (stale.length > 0) {
    console.log(`updated ${updated} file${updated === 1 ? '' : 's'} (skill version ${from} → ${served ?? 'unknown'})`);
  }

  const installedOk = missing.length === 0 || installedCount === missing.length;
  const updatedOk = updated === stale.length;
  return installedOk && updatedOk ? 0 : 1;
}
