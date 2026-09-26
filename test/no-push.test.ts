import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as gitModule from '../src/apply/git.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(__dirname, '../dist/cli.js');

test('security invariant: git.ts exposes no push function', () => {
  const exportedFunctions = Object.keys(gitModule);
  for (const fnName of exportedFunctions) {
    assert.ok(
      !fnName.toLowerCase().includes('push'),
      `git.ts must not export any push function, found: ${fnName}`,
    );
  }
});

test('security invariant: no command spawned by apply code contains push', () => {
  const applySourceDir = join(__dirname, '../src/apply');
  // Every file in apply/, discovered at run time. A hardcoded list silently stops covering the
  // module someone adds next — which is exactly when this check matters.
  const files = readdirSync(applySourceDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 5, 'expected to discover the apply modules');

  for (const file of files) {
    const content = readFileSync(join(applySourceDir, file), 'utf8');
    // Check all spawnSync calls
    const spawnRegex = /spawnSync\([^,]+,\s*(\[[^\]]+\])/g;
    let match: RegExpExecArray | null;
    while ((match = spawnRegex.exec(content)) !== null) {
      assert.ok(
        !match[1].toLowerCase().includes('push'),
        `Spawned args in ${file} must not contain 'push': ${match[1]}`,
      );
    }
  }
});

test('security invariant: no command spawned by mcp code contains push', () => {
  const mcpSourceDir = join(__dirname, '../src/mcp');
  const files = readdirSync(mcpSourceDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 2, 'expected to discover the mcp modules');

  for (const file of files) {
    const content = readFileSync(join(mcpSourceDir, file), 'utf8');
    const spawnRegex = /spawnSync\([^,]+,\s*(\[[^\]]+\])/g;
    let match: RegExpExecArray | null;
    while ((match = spawnRegex.exec(content)) !== null) {
      assert.ok(
        !match[1].toLowerCase().includes('push'),
        `Spawned args in mcp/${file} must not contain 'push': ${match[1]}`,
      );
    }
  }
});

test('no-push: after masking security text, /\\bpush\\b/ has zero matches in dist/cli.js', () => {
  let bundle = readFileSync(bundlePath, 'utf8');

  // 1. Mask the SECURITY_TEXT constant declaration in dist/cli.js
  const marker = 'var SECURITY_TEXT =';
  const startIdx = bundle.indexOf(marker);
  assert.ok(startIdx !== -1, 'SECURITY_TEXT must be present in bundle');
  const endIdx = bundle.indexOf(';\n', startIdx);
  assert.ok(endIdx !== -1, 'End of SECURITY_TEXT must be found');
  bundle = bundle.slice(0, startIdx) + bundle.slice(endIdx + 2);

  // 2. Mask the prompt footer instruction ('Never run git push.')
  bundle = bundle.replaceAll('Never run git push', '');

  // 3. Mask JS Array.prototype.push invocations (.push(...) - SPEC-CONFLICT noted in report)
  bundle = bundle.replace(/\.push\(/g, '.append(');

  // Assert regex /\bpush\b/ has zero matches in the remainder
  const matches = bundle.match(/\bpush\b/g) || [];
  assert.equal(
    matches.length,
    0,
    `Expected zero matches for /\\bpush\\b/ in bundle remainder, found ${matches.length}: ${JSON.stringify(matches)}`,
  );
});
