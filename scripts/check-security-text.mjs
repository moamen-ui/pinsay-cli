import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillPath = join(__dirname, '../../API/wwwroot/skill.md');
const secTextModulePath = join(__dirname, '../src/apply/security-text.ts');

export function extractSecuritySection(content) {
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

const skillContent = readFileSync(skillPath, 'utf8');
const secTextContent = readFileSync(secTextModulePath, 'utf8');

const skillSec = extractSecuritySection(skillContent);
const moduleSec = extractSecuritySection(secTextContent);

if (skillSec !== moduleSec) {
  console.error('Security text drift detected between API/wwwroot/skill.md and cli/src/apply/security-text.ts!');
  console.error(`skill.md length: ${skillSec.length}, security-text.ts length: ${moduleSec.length}`);
  process.exit(1);
}

console.log('Security text drift check passed: byte-equal.');
