import { test } from 'node:test';
import * as assert from 'node:assert';
import {
    readConfig,
    writeConfig,
    writeConfigFull,
    writeCredentials,
    isMultiProject,
    listProjects,
    resolveProject,
    findRepoRoot,
    type PinSayConfig,
} from '../src/config.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

test('config read/write', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-config-'));
    try {
        let conf = await readConfig(dir);
        assert.deepStrictEqual(conf, {});
        
        await writeConfig(dir, { server: 'https://test' });
        conf = await readConfig(dir);
        assert.strictEqual(conf.server, 'https://test');

        // `delivery` round-trips like any other field, and a config an older CLI wrote (before this
        // field existed) simply omits it — readers treat that absence as `embed`, not as an error.
        assert.strictEqual(conf.delivery, undefined, 'an older config has no delivery field at all');
        await writeConfig(dir, { delivery: 'extension' });
        conf = await readConfig(dir);
        assert.strictEqual(conf.delivery, 'extension');
        await writeConfig(dir, { delivery: 'embed' });
        conf = await readConfig(dir);
        assert.strictEqual(conf.delivery, 'embed');

        await writeCredentials(dir, 'test-key');
        const creds = await fs.readFile(path.join(dir, '.pinsay/credentials.env'), 'utf8');
        assert.match(creds, /PINSAY_API_KEY=test-key/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

// -----------------------------------------------------------------------------------------------
// Multi-project config helpers
// -----------------------------------------------------------------------------------------------

test('isMultiProject / listProjects: single-project config', () => {
    const single: PinSayConfig = { server: 'https://s', project: 'my-app', environment: 'local' };
    assert.strictEqual(isMultiProject(single), false);
    assert.deepStrictEqual(listProjects(single), [
        { key: 'my-app', path: '.', environment: 'local', environments: undefined, htmlPath: undefined, delivery: undefined },
    ]);

    // No project at all: no entries, not a single implicit one.
    assert.deepStrictEqual(listProjects({ server: 'https://s' }), []);
});

test('isMultiProject / listProjects: multi-project config', () => {
    const multi: PinSayConfig = {
        server: 'https://s',
        delivery: 'extension',
        projects: {
            a: { path: 'apps/a', environment: 'local' },
            b: { path: 'apps/b', environment: 'staging', delivery: 'embed' },
        },
    };
    assert.strictEqual(isMultiProject(multi), true);
    assert.deepStrictEqual(listProjects(multi), [
        { key: 'a', path: 'apps/a', environment: 'local' },
        { key: 'b', path: 'apps/b', environment: 'staging', delivery: 'embed' },
    ]);

    // An empty `projects` map is NOT multi-project — there is nothing to resolve against.
    assert.strictEqual(isMultiProject({ projects: {} }), false);
});

test('resolveProject: --project flag wins outright', () => {
    const config: PinSayConfig = { projects: { a: { path: 'apps/a' }, b: { path: 'apps/b' } } };
    const result = resolveProject(config, '/repo/apps/b', '/repo', 'a');
    assert.ok(result.ok);
    assert.strictEqual((result as any).project.key, 'a');

    const notFound = resolveProject(config, '/repo', '/repo', 'nope');
    assert.strictEqual(notFound.ok, false);
    assert.strictEqual((notFound as any).reason, 'not-found');
});

test('resolveProject: cwd inside a project directory resolves it, most-specific match wins', () => {
    const config: PinSayConfig = {
        projects: {
            root: { path: '.' },
            a: { path: 'apps/a' },
            nested: { path: 'apps/a/nested' },
        },
    };
    const inA = resolveProject(config, '/repo/apps/a/src', '/repo');
    assert.ok(inA.ok);
    assert.strictEqual((inA as any).project.key, 'a');

    const inNested = resolveProject(config, '/repo/apps/a/nested/src', '/repo');
    assert.ok(inNested.ok);
    assert.strictEqual((inNested as any).project.key, 'nested', 'the deepest matching path wins');

    const atRoot = resolveProject(config, '/repo', '/repo');
    assert.ok(atRoot.ok);
    assert.strictEqual((atRoot as any).project.key, 'root');
});

test('resolveProject: the only configured project resolves without a flag or cwd match', () => {
    const config: PinSayConfig = { project: 'solo', environment: 'local' };
    const result = resolveProject(config, '/somewhere/else', '/repo');
    assert.ok(result.ok);
    assert.strictEqual((result as any).project.key, 'solo');
});

test('resolveProject: several projects, no flag, cwd outside every one -> ambiguous', () => {
    const config: PinSayConfig = { projects: { a: { path: 'apps/a' }, b: { path: 'apps/b' } } };
    const result = resolveProject(config, '/repo/apps/c', '/repo');
    assert.strictEqual(result.ok, false);
    assert.strictEqual((result as any).reason, 'ambiguous');
    assert.deepStrictEqual((result as any).keys.sort(), ['a', 'b']);
});

test('resolveProject: no project configured at all', () => {
    const result = resolveProject({}, '/repo', '/repo');
    assert.strictEqual(result.ok, false);
    assert.strictEqual((result as any).reason, 'none');
});

test('findRepoRoot: walks up from a nested cwd to the directory holding .pinsay/config.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-root-'));
    try {
        await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
        await fs.writeFile(path.join(dir, '.pinsay/config.json'), '{}', 'utf8');
        const nested = path.join(dir, 'apps', 'a', 'src');
        await fs.mkdir(nested, { recursive: true });

        const root = await findRepoRoot(nested);
        assert.strictEqual(await fs.realpath(root), await fs.realpath(dir));
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('findRepoRoot: falls back to cwd unchanged when no .pinsay/config.json exists anywhere above it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-noroot-'));
    try {
        const root = await findRepoRoot(dir);
        assert.strictEqual(root, dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('writeConfigFull writes exactly the given object, with no merge against the existing file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-fullwrite-'));
    try {
        await writeConfig(dir, { server: 'https://s', project: 'old', environment: 'local', htmlPath: 'index.html' });
        await writeConfigFull(dir, { server: 'https://s', aiTool: 'claude-code', projects: { old: { path: '.' } } });
        const conf = await readConfig(dir);
        assert.strictEqual(conf.project, undefined, 'writeConfigFull must not carry the old top-level project forward');
        assert.strictEqual(conf.environment, undefined);
        assert.strictEqual(conf.htmlPath, undefined);
        assert.deepStrictEqual(conf.projects, { old: { path: '.' } });
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('legacy api.pinsay.dev server is read as the canonical app.pinsay.dev origin', async () => {
    const { canonicalServer } = await import('../src/config.js');
    assert.strictEqual(canonicalServer('https://api.pinsay.dev'), 'https://app.pinsay.dev');
    assert.strictEqual(canonicalServer('https://api.pinsay.dev/'), 'https://app.pinsay.dev');
    assert.strictEqual(canonicalServer('https://app.pinsay.dev'), 'https://app.pinsay.dev');
    assert.strictEqual(canonicalServer('http://localhost:8090'), 'http://localhost:8090');
    assert.strictEqual(canonicalServer(undefined), undefined);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-legacy-'));
    try {
        await writeConfig(dir, { server: 'https://api.pinsay.dev' });
        const conf = await readConfig(dir);
        assert.strictEqual(conf.server, 'https://app.pinsay.dev');
        const onDisk = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
        assert.strictEqual(onDisk.server, 'https://api.pinsay.dev', 'the file on disk is not rewritten');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
