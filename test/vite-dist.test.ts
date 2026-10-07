import { test } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmTempDir } from './rm-temp.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..');
const distVite = join(cliRoot, 'dist', 'vite.js');

/**
 * The Vite plugin, exercised through the BUILT bundle, in a plain `node` process.
 *
 * Both halves of that sentence are load-bearing.
 *
 * Built, because every other test here runs from TypeScript source, and source and bundle resolve
 * CJS/ESM interop differently. The plugin loads @babel/traverse and @babel/generator through that
 * interop. In the bundle they resolved to objects rather than functions, so every file threw; the
 * plugin caught it (it must never break a host build), warned once per file, and wrote an EMPTY
 * manifest. The source-stamp feature did nothing in every shipped copy of the CLI while this suite
 * stayed green.
 *
 * In a plain node process, because `npm test` runs through tsx — and tsx re-transforms the
 * imported bundle, restoring the very interop this is meant to check. Loading dist/ from inside a
 * tsx-hosted test passes whether the bug is present or not: verified by reintroducing it and
 * watching the test still pass. So the assertion runs in a child `node`, and this test only reads
 * its verdict.
 */
test('the built vite plugin actually stamps (not just the TypeScript source)', async (t) => {
  if (!existsSync(distVite)) {
    t.skip('dist/vite.js not built — run `npm run build` first');
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'pinsay-vite-dist-'));
  const probe = join(scratch, 'probe.mjs');

  // Plain ESM, run by node itself: no loader, no transform, exactly what a user's Vite gets.
  writeFileSync(
    probe,
    [
      `import plugin from ${JSON.stringify(pathToFileURL(distVite).href)};`,
      `const p = plugin({ enabled: true, buildSha: false });`,
      `p.configResolved?.({ root: ${JSON.stringify(cliRoot)} });`,
      `const warnings = [];`,
      `const src = 'export function Card({ id }) { return <div id={id} className="card" />; }';`,
      `const out = await p.transform.call(`,
      `  { warn: (m) => warnings.push(String(m)) },`,
      `  src,`,
      `  ${JSON.stringify(join(cliRoot, 'src', 'Card.tsx'))},`,
      `);`,
      `console.log(JSON.stringify({`,
      `  stamped: Boolean(out && out.code && out.code.includes('data-component-source=')),`,
      `  warnings,`,
      `}));`,
    ].join('\n'),
    'utf8',
  );

  try {
    const stdout = execFileSync(process.execPath, [probe], {
      cwd: cliRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const verdict = JSON.parse(stdout.trim().split('\n').pop() as string);

    // The failure this exists to catch is silent: a warning and a null return, never a throw.
    assert.deepStrictEqual(
      verdict.warnings,
      [],
      `the built plugin warned instead of stamping: ${verdict.warnings.join('; ')}`,
    );
    assert.ok(verdict.stamped, 'the built plugin did not stamp data-component-source');
  } finally {
    rmTempDir(scratch);
  }
});
