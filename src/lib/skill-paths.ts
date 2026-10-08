import { SKILL_FILES, SUB_SKILLS } from '../skills.js';
import type { PinSayConfig } from '../config.js';

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
