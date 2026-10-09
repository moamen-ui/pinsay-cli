import { SKILL_FILES, SUB_SKILLS } from '../skills.js';
import type { PinSayConfig } from '../config.js';

/**
 * The skill paths an `init` plan lists for `tool`: what `skillFilesFor` gives, plus the
 * `.agents/skills/...` mirrors `installSkills` also writes for claude-code, cursor and windsurf
 * (not with a `--skills-dir` override).
 */
export function planSkillPaths(tool: string, skillsDir?: string): string[] {
  const paths = skillFilesFor({ aiTool: tool, skillsDir });
  if (!skillsDir && (tool === 'claude-code' || tool === 'cursor' || tool === 'windsurf')) {
    paths.push('.agents/skills/pinsay-init/SKILL.md', '.agents/skills/pinsay-feedback/SKILL.md');
  }
  return paths;
}

/**
 * Every file on disk that the server serves and `update` can refresh, for this install.
 *
 * config.json records the AI tool's NAME, not a directory — the mapping from one to the other
 * lives in SKILL_FILES, which `installSkills` also uses, so `doctor` and `update` check exactly
 * the paths `init` wrote. When `init` recorded a `skillsDir` override, that wins for the skill
 * files.
 */
export function skillFilesFor(config: PinSayConfig): string[] {
  const layout = SKILL_FILES[config.aiTool ?? ''] ?? SKILL_FILES.other;

  // A `--skills-dir` override always writes the folder shape (see installSkills' `isFlatFileTool`),
  // so it always gets apply.md/translate.md/advanced.md as siblings too, regardless of aiTool.
  const dir = config.skillsDir?.replace(/\\/g, '/').replace(/\/+$/, '');
  const skillPaths = dir
    ? [
        `${dir}/pinsay-init/SKILL.md`,
        `${dir}/pinsay-feedback/SKILL.md`,
        ...SUB_SKILLS.map((name) => `${dir}/pinsay-feedback/${name}.md`),
      ]
    : [...layout];

  return skillPaths;
}
