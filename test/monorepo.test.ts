import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { isNxWorkspace, discoverNxApps } from '../src/monorepo.js';

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-nx-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('isNxWorkspace is true only when nx.json exists at the root', () =>
  withTempDir(async (dir) => {
    assert.strictEqual(await isNxWorkspace(dir), false);
    await fs.writeFile(path.join(dir, 'nx.json'), '{}', 'utf8');
    assert.strictEqual(await isNxWorkspace(dir), true);
  }));

test('discoverNxApps: application project.json included, library excluded, no-project.json app included with a note', () =>
  withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'nx.json'), '{}', 'utf8');

    // apps/a — application, discovered by project.json.
    await fs.mkdir(path.join(dir, 'apps/a/src'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'apps/a/project.json'),
      JSON.stringify({ name: 'a', projectType: 'application', sourceRoot: 'apps/a/src' }),
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'apps/a/src/index.html'), '<html></html>', 'utf8');

    // apps/lib — a library, must be excluded even though it sits under apps/.
    await fs.mkdir(path.join(dir, 'apps/lib'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'apps/lib/project.json'),
      JSON.stringify({ name: 'lib', projectType: 'library' }),
      'utf8',
    );

    // apps/b — no project.json at all, but has its own index.html: included, flagged.
    await fs.mkdir(path.join(dir, 'apps/b/src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'apps/b/src/index.html'), '<html></html>', 'utf8');

    // apps/empty — neither a project.json nor an index.html: excluded entirely.
    await fs.mkdir(path.join(dir, 'apps/empty'), { recursive: true });

    const apps = await discoverNxApps(dir);
    const byDir = Object.fromEntries(apps.map((a) => [a.dir, a]));

    assert.ok(byDir['apps/a'], 'application project.json app must be discovered');
    assert.strictEqual(byDir['apps/a'].name, 'a');
    assert.strictEqual(byDir['apps/a'].hasProjectJson, true);
    assert.strictEqual(byDir['apps/a'].note, undefined);

    assert.strictEqual(byDir['apps/lib'], undefined, 'a library project.json must be excluded');

    assert.ok(byDir['apps/b'], 'an app dir with an index.html but no project.json must be discovered');
    assert.strictEqual(byDir['apps/b'].hasProjectJson, false);
    assert.strictEqual(byDir['apps/b'].note, 'no project.json');

    assert.strictEqual(byDir['apps/empty'], undefined, 'a dir with neither project.json nor index.html must be excluded');

    assert.strictEqual(apps.length, 2);
  }));

test('discoverNxApps returns [] when there is no apps/ directory at all', () =>
  withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'nx.json'), '{}', 'utf8');
    assert.deepStrictEqual(await discoverNxApps(dir), []);
  }));
