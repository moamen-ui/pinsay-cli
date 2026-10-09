import { test } from 'node:test';
import * as assert from 'node:assert';
import { planSkillPaths } from '../src/lib/skill-paths.js';

test('claude-code plan lists the native and the .agents mirror skill paths', () => {
  const paths = planSkillPaths('claude-code');
  for (const name of ['pinsay-init', 'pinsay-feedback']) {
    assert.ok(paths.includes(`.claude/skills/${name}/SKILL.md`));
    assert.ok(paths.includes(`.agents/skills/${name}/SKILL.md`));
  }
});

test('a --skills-dir override and other tools get no mirror', () => {
  assert.ok(!planSkillPaths('claude-code', 'docs/skills').some((p) => p.startsWith('.agents/')));
  assert.equal(planSkillPaths('other').filter((p) => p.endsWith('pinsay-init/SKILL.md')).length, 1);
});
