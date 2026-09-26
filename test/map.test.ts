import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildManifest, isSameManifest } from '../src/commands/map.js';
import { needsManifestRebuild } from '../src/apply/run.js';
import { resolveSource } from '../src/vite/resolve.js';

test('buildManifest with an unchanged tree does not overwrite an existing manifest.prev.json', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pinsay-map-test-')));
  try {
    execFileSync('git', ['init'], { cwd: dir });

    await fs.mkdir(join(dir, 'src'), { recursive: true });
    await fs.writeFile(
      join(dir, 'src/Card.tsx'),
      'export function Card() { return <div className="card">Card</div>; }\n',
      'utf8',
    );

    const first = await buildManifest(dir, { quiet: true });
    assert.equal(first.ok, true);
    assert.equal(first.count, 1);

    const manifestPath = join(dir, '.pinsay/manifest.json');
    const prevPath = join(dir, '.pinsay/manifest.prev.json');

    const manifestInitial = await fs.readFile(manifestPath, 'utf8');
    const parsedInitial = JSON.parse(manifestInitial);
    const hashes = Object.keys(parsedInitial.entries);
    assert.equal(hashes.length, 1);
    assert.equal(parsedInitial.entries[hashes[0]].component, 'Card');

    // Seed manifest.prev.json with distinct history (representing a past component)
    const prevSentinel = JSON.stringify(
      {
        version: 1,
        entries: {
          deadbeef: { path: 'src/OldComponent.tsx', component: 'OldComponent' },
        },
      },
      null,
      2,
    ) + '\n';
    await fs.writeFile(prevPath, prevSentinel, 'utf8');

    // Run buildManifest again with unchanged source tree
    const second = await buildManifest(dir, { quiet: true });
    assert.equal(second.ok, true);

    // manifest.prev.json must be preserved verbatim, not overwritten with manifest.json
    const prevAfterUnchanged = await fs.readFile(prevPath, 'utf8');
    assert.equal(
      prevAfterUnchanged,
      prevSentinel,
      'buildManifest on an unchanged tree must not overwrite manifest.prev.json',
    );

    // Stale resolution still works for the old component in manifest.prev.json
    const resolvedStale = resolveSource(dir, 'deadbeef');
    assert.equal(resolvedStale.kind, 'stale');
    if (resolvedStale.kind === 'stale') {
      assert.equal(resolvedStale.hint, 'search for "OldComponent"');
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('buildManifest with a changed tree rotates', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pinsay-map-rotate-')));
  try {
    execFileSync('git', ['init'], { cwd: dir });

    await fs.mkdir(join(dir, 'src'), { recursive: true });
    await fs.writeFile(
      join(dir, 'src/Card.tsx'),
      'export function Card() { return <div className="card">Card</div>; }\n',
      'utf8',
    );

    const first = await buildManifest(dir, { quiet: true });
    assert.equal(first.ok, true);

    const manifestPath = join(dir, '.pinsay/manifest.json');
    const prevPath = join(dir, '.pinsay/manifest.prev.json');

    const manifestBefore = await fs.readFile(manifestPath, 'utf8');
    const parsedBefore = JSON.parse(manifestBefore);
    const cardHash = Object.keys(parsedBefore.entries)[0];
    assert.equal(parsedBefore.entries[cardHash].component, 'Card');

    // Rename component in source tree (models renaming Card to ProductCard)
    await fs.unlink(join(dir, 'src/Card.tsx'));
    await fs.writeFile(
      join(dir, 'src/ProductCard.tsx'),
      'export function ProductCard() { return <div className="product-card">ProductCard</div>; }\n',
      'utf8',
    );

    const second = await buildManifest(dir, { quiet: true });
    assert.equal(second.ok, true);

    // manifest.prev.json must now contain the old manifest (with Card)
    const prevAfterRotate = await fs.readFile(prevPath, 'utf8');
    assert.equal(prevAfterRotate, manifestBefore, 'manifest.prev.json must receive the previous manifest');
    const parsedPrev = JSON.parse(prevAfterRotate);
    assert.ok(parsedPrev.entries[cardHash], 'old hash must be in manifest.prev.json');
    assert.equal(parsedPrev.entries[cardHash].component, 'Card');

    // manifest.json must contain the new component (ProductCard)
    const manifestAfter = await fs.readFile(manifestPath, 'utf8');
    const parsedAfter = JSON.parse(manifestAfter);
    const productCardHash = Object.keys(parsedAfter.entries)[0];
    assert.notEqual(productCardHash, cardHash);
    assert.equal(parsedAfter.entries[productCardHash].component, 'ProductCard');

    // Card hash now resolves to 'stale' with hint to search for "Card"
    const staleResult = resolveSource(dir, cardHash);
    assert.deepEqual(staleResult, {
      kind: 'stale',
      hash: cardHash,
      hint: 'search for "Card"',
    });

    // ProductCard hash resolves to 'manifest'
    const manifestResult = resolveSource(dir, productCardHash);
    assert.deepEqual(manifestResult, {
      kind: 'manifest',
      path: 'src/ProductCard.tsx',
      component: 'ProductCard',
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('needsManifestRebuild: apply auto-rebuild condition', () => {
  // 'stale' -> false
  assert.equal(needsManifestRebuild(['stale']), false);
  assert.equal(needsManifestRebuild(['stale', 'stale']), false);

  // all 'manifest' -> false
  assert.equal(needsManifestRebuild([]), false);
  assert.equal(needsManifestRebuild(['manifest']), false);
  assert.equal(needsManifestRebuild(['manifest', 'manifest']), false);

  // 'manifest' and 'stale' together -> false
  assert.equal(needsManifestRebuild(['manifest', 'stale']), false);
  assert.equal(needsManifestRebuild(['stale', 'manifest']), false);

  // 'unknown' -> true
  assert.equal(needsManifestRebuild(['unknown']), true);
  assert.equal(needsManifestRebuild(['manifest', 'unknown']), true);
  assert.equal(needsManifestRebuild(['stale', 'unknown']), true);
  assert.equal(needsManifestRebuild(['manifest', 'stale', 'unknown']), true);
});

test('isSameManifest detects identical and differing manifest contents', () => {
  const m1 = JSON.stringify({ version: 1, entries: { abc: { path: 'a.tsx', component: 'A' } } }, null, 2) + '\n';
  const m1DiffWhitespace = '{"version":1,"entries":{"abc":{"path":"a.tsx","component":"A"}}}';
  const m2 = JSON.stringify({ version: 1, entries: { abc: { path: 'b.tsx', component: 'A' } } }, null, 2) + '\n';
  const m3 = JSON.stringify({ version: 1, entries: { xyz: { path: 'a.tsx', component: 'A' } } }, null, 2) + '\n';

  assert.equal(isSameManifest(m1, m1), true);
  assert.equal(isSameManifest(m1, m1DiffWhitespace), true);
  assert.equal(isSameManifest(m1, m2), false);
  assert.equal(isSameManifest(m1, m3), false);
  assert.equal(isSameManifest('invalid json', m1), false);
});
