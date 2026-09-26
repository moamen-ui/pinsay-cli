import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SECURITY_TEXT } from '../src/apply/security-text.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillPath = join(__dirname, '../../API/wwwroot/skill.md');
const secTextModulePath = join(__dirname, '../src/apply/security-text.ts');

function extractSecuritySection(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trimStart().startsWith('## ⚠️ SECURITY'));
  if (start === -1) {
    throw new Error('Could not find line starting with "## ⚠️ SECURITY"');
  }
  const end = lines.findIndex((l, i) => i > start && l.trimStart().startsWith('## '));
  const slice = end === -1 ? lines.slice(start) : lines.slice(start, end);
  return slice
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\\`/g, '`')
    .replace(/`;\s*$/, '');
}

test('heading-scoped security text drift test between skill.md and security-text.ts', () => {
  const skillContent = readFileSync(skillPath, 'utf8');
  const secTextFile = readFileSync(secTextModulePath, 'utf8');

  const skillExtracted = extractSecuritySection(skillContent);
  const moduleExtracted = extractSecuritySection(secTextFile);
  const constantExtracted = extractSecuritySection(SECURITY_TEXT);

  // Require byte equality per contract extraction rule
  assert.equal(moduleExtracted, skillExtracted, 'security-text.ts file must match skill.md exactly');
  assert.equal(constantExtracted, skillExtracted, 'SECURITY_TEXT constant must match skill.md exactly');

  // Verify the rewritten commit-authority bullet
  assert.ok(
    skillExtracted.includes('only the human developer pushes'),
    'must contain only the human developer pushes',
  );
  assert.ok(
    skillExtracted.includes('is never permitted'),
    'must contain git push is never permitted',
  );
});
