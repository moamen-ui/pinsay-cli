import * as esbuild from 'esbuild';
import { env } from 'node:process';
import { readFileSync } from 'node:fs';

// Stamped at build time so `doctor` can compare itself against the server's minCliVersion without
// reading package.json at runtime — the published bundle is a single file with no package.json
// beside it in every install layout.
const pkgVersion = JSON.parse(readFileSync('./package.json', 'utf8')).version;

const defaultServer = env.PINSAY_DEFAULT_SERVER || 'https://app.pinsay.dev';

// The Vite plugin is a SEPARATE bundle: it runs inside the host app's build, not as our CLI, and
// it may import the optional Babel peers — which must never be pulled into dist/cli.js, whose
// dependency-free single-file shape is a contract.
await esbuild.build({
  entryPoints: ['src/vite/index.ts'],
  bundle: true,
  outfile: 'dist/vite.js',
  platform: 'node',
  format: 'esm',
  external: ['@babel/parser', '@babel/traverse', '@babel/generator', '@vue/compiler-sfc'],
});

await esbuild.build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  outfile: 'dist/cli.js',
  platform: 'node',
  format: 'esm',
  // Same optional peers the plugin bundle excludes, and for the same reason — except this bundle
  // reaches them only through `pointer map`, which imports the stamping visitor. Left bundled,
  // esbuild inlined the whole Babel toolchain: dist/cli.js went from ~200KB to 1.9MB, every
  // install paid for a parser it will usually never run, and Babel's own `Scope.push` method
  // broke the invariant that proves this CLI can never `git push`.
  external: ['@babel/parser', '@babel/traverse', '@babel/generator', '@vue/compiler-sfc'],
  banner: {
    js: '#!/usr/bin/env node'
  },
  define: {
    'DEFAULT_SERVER': JSON.stringify(defaultServer),
    'CLI_VERSION': JSON.stringify(pkgVersion)
  }
});

