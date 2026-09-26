import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import {
  detectDesignTokens,
  buildDesignBlock,
  renderGuidance,
  summarizeDesignTokens,
  collectFiles,
} from '../src/stack/design.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, 'fixtures/design');
const viteReactFixtureDir = join(__dirname, '../../e2e/fixture-app/vite-react');

test('design tokens: tailwind-v3 fixture', async () => {
  const cwd = join(fixturesDir, 'tailwind-v3');
  const result = await detectDesignTokens(cwd);

  assert.equal(result.version, 1);
  assert.ok(result.tokens.tailwind);
  assert.equal(result.tokens.tailwind.config, 'tailwind.config.ts');
  assert.deepEqual(result.tokens.tailwind.colors, ['muted', 'primary', 'secondary']);
  assert.deepEqual(result.tokens.tailwind.radius, ['lg', 'md', 'sm']);
  assert.deepEqual(result.tokens.tailwind.fontFamily, ['mono', 'sans']);
  assert.match(result.guidance, /^Prefer existing tokens/);
  assert.match(result.guidance, /Tailwind classes/);
});

test('design tokens: tailwind-v4 fixture', async () => {
  const cwd = join(fixturesDir, 'tailwind-v4');
  const result = await detectDesignTokens(cwd);

  assert.equal(result.version, 1);
  assert.ok(result.tokens.tailwind);
  assert.equal(result.tokens.tailwind.config, 'src/styles/globals.css');
  assert.deepEqual(result.tokens.tailwind.colors, ['--color-muted', '--color-primary', '--color-secondary']);
  assert.deepEqual(result.tokens.tailwind.radius, ['--radius-md', '--radius-sm']);
  assert.deepEqual(result.tokens.tailwind.fontFamily, ['--font-sans']);
  assert.match(result.guidance, /^Prefer existing tokens/);
});

test('design tokens: cssvars fixture', async () => {
  const cwd = join(fixturesDir, 'cssvars');
  const result = await detectDesignTokens(cwd);

  assert.equal(result.version, 1);
  assert.ok(result.tokens.cssVars);
  assert.deepEqual(result.tokens.cssVars.files, ['src/styles/globals.css']);
  assert.ok(result.tokens.cssVars.names.includes('--brand'));
  assert.ok(result.tokens.cssVars.names.includes('--brand-contrast'));
  assert.ok(result.tokens.cssVars.names.includes('--primary'));
  assert.ok(result.tokens.cssVars.names.includes('--radius-md'));
  assert.match(result.guidance, /^Prefer existing tokens/);
  assert.match(result.guidance, /CSS vars/);
});

test('design tokens: scss fixture', async () => {
  const cwd = join(fixturesDir, 'scss');
  const result = await detectDesignTokens(cwd);

  assert.equal(result.version, 1);
  assert.ok(result.tokens.scss);
  assert.deepEqual(result.tokens.scss.files, ['src/styles/_variables.scss']);
  assert.deepEqual(result.tokens.scss.names, ['$brand-blue', '$brand-dark', '$font-size-base', '$radius-sm']);
  assert.match(result.guidance, /^Prefer existing tokens/);
  assert.match(result.guidance, /SCSS variables/);
});

test('design tokens: mui fixture', async () => {
  const cwd = join(fixturesDir, 'mui');
  const result = await detectDesignTokens(cwd);

  assert.equal(result.version, 1);
  assert.deepEqual(result.libraries, [{ name: '@mui/material', version: '^5.15.0' }]);
  assert.ok(result.tokens.theme);
  assert.deepEqual(result.tokens.theme.colors, ['error', 'primary', 'secondary']);
  assert.match(result.guidance, /^Prefer existing tokens/);
});

test('design tokens: none fixture', async () => {
  const cwd = join(fixturesDir, 'none');
  const result = await detectDesignTokens(cwd);

  assert.equal(result.version, 1);
  assert.deepEqual(result.libraries, []);
  assert.deepEqual(result.tokens, {});
  assert.equal(
    result.guidance,
    "No design tokens detected; match the nearest sibling element's existing classes/styles.",
  );
});

test('design tokens: e2e/fixture-app/vite-react detection completes in < 2 s', async () => {
  const start = Date.now();
  const result = await detectDesignTokens(viteReactFixtureDir);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000, `Detection took ${elapsed}ms, must be < 2000ms`);
  assert.equal(result.version, 1);
  assert.deepEqual(result.libraries, []);
  assert.ok(result.tokens.tailwind);
  assert.deepEqual(result.tokens.tailwind.colors, ['muted', 'primary', 'secondary']);
  assert.ok(result.tokens.tailwind.radius?.includes('md'));
  assert.ok(result.tokens.cssVars);
  assert.ok(result.tokens.cssVars.names.includes('--brand'));
  assert.ok(result.tokens.cssVars.names.includes('--radius-md'));
  assert.match(result.guidance, /^Prefer existing tokens/);
});

test('design tokens: respects max 500 files scan limit', async () => {
  const tmp = await fs.mkdtemp(join(os.tmpdir(), 'ptr-scan-'));
  try {
    const srcDir = join(tmp, 'src');
    await fs.mkdir(srcDir, { recursive: true });

    // Create 600 small files
    for (let i = 0; i < 600; i++) {
      await fs.writeFile(join(srcDir, `file-${i}.txt`), `content ${i}`);
    }

    const files = await collectFiles(tmp, { maxFiles: 500 });
    assert.equal(files.length, 500, 'Must cap collection at 500 files');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('design tokens: ignores node_modules, dist, build, .next', async () => {
  const tmp = await fs.mkdtemp(join(os.tmpdir(), 'ptr-ignore-'));
  try {
    await fs.mkdir(join(tmp, 'node_modules/fake-lib'), { recursive: true });
    await fs.mkdir(join(tmp, 'dist'), { recursive: true });
    await fs.mkdir(join(tmp, 'build'), { recursive: true });
    await fs.mkdir(join(tmp, '.next'), { recursive: true });
    await fs.mkdir(join(tmp, 'src'), { recursive: true });

    await fs.writeFile(join(tmp, 'node_modules/fake-lib/theme.ts'), 'export const theme = { colors: { bad: 1 } };');
    await fs.writeFile(join(tmp, 'dist/styles.css'), ':root { --bad: red; }');
    await fs.writeFile(join(tmp, 'src/styles.css'), ':root { --good: blue; }');

    const files = await collectFiles(tmp);
    assert.ok(!files.some((f) => f.includes('node_modules')));
    assert.ok(!files.some((f) => f.includes('dist/')));
    assert.ok(!files.some((f) => f.includes('build/')));
    assert.ok(!files.some((f) => f.includes('.next/')));
    assert.ok(files.includes('src/styles.css'));

    const result = await detectDesignTokens(tmp);
    assert.ok(result.tokens.cssVars);
    assert.deepEqual(result.tokens.cssVars.names, ['--good']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------------------------
// Monorepo support: `detectDesignTokens(cwd, { root })` — the app dir has no package.json of its
// own, and the shared config/dependencies live at the workspace root instead.
// -----------------------------------------------------------------------------------------------

test('design tokens: monorepo app with no package.json reads deps from the root and its own tailwind config', async () => {
  const monorepoRoot = join(fixturesDir, 'monorepo');
  const appDir = join(monorepoRoot, 'apps/x');

  const result = await detectDesignTokens(appDir, { root: monorepoRoot });

  assert.ok(
    result.libraries.some((l) => l.name === 'tailwindcss'),
    'tailwindcss is only declared in the ROOT package.json — must still surface as a library',
  );
  assert.ok(
    result.libraries.some((l) => l.name === '@radix-ui/react-progress'),
    'radix, also only declared at the root, must surface too',
  );
  assert.ok(result.tokens.tailwind, "the app's own tailwind.config.js must still be detected directly");
  assert.notEqual(
    result.guidance,
    "No design tokens detected; match the nearest sibling element's existing classes/styles.",
  );
});

test('summarizeDesignTokens produces expected human output', () => {
  const summary1 = summarizeDesignTokens(
    {
      tailwind: { config: 'tailwind.config.ts', colors: ['primary', 'secondary', 'muted'] },
      cssVars: { files: ['src/styles/globals.css'], names: ['--brand', '--radius-md'] },
    },
    [],
  );
  assert.equal(summary1, 'tailwind (3 colors), css vars (2)');

  const summaryEmpty = summarizeDesignTokens({}, []);
  assert.equal(summaryEmpty, 'none');
});
