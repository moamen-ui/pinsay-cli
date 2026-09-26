import { test } from 'node:test';
import * as assert from 'node:assert';
import {
    readConfig,
    writeConfig,
    writeConfigFull,
    writeCredentials,
    upsertGitignore,
    isMultiProject,
    listProjects,
    resolveProject,
    findRepoRoot,
    type PinSayConfig,
} from '../src/config.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

test('config read/write and gitignore upsert idempotency', async () => {
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

        await upsertGitignore(dir);
        let gitignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
        // Only config.json and stack.json are re-included; everything else in .pinsay/ (including
        // credentials.env) stays covered by the `.pinsay/*` wildcard with no negation of its own.
        assert.match(gitignore, /\.pinsay\/\*/);
        assert.match(gitignore, /!\.pinsay\/config\.json/);
        assert.match(gitignore, /!\.pinsay\/stack\.json/);
        assert.doesNotMatch(gitignore, /!\.pinsay\/credentials\.env/);
        assert.doesNotMatch(gitignore, /!\.pinsay\/pinsay\.sh/);
        // Skill directories are gitignored too — every clone installs its own copy.
        assert.match(gitignore, /\.claude\/skills\/pinsay-init\//);
        assert.match(gitignore, /\.claude\/skills\/pinsay-feedback\//);
        assert.match(gitignore, /\.agents\/pinsay-init\//);
        assert.match(gitignore, /\.agents\/pinsay-feedback\//);

        // idempotency
        await upsertGitignore(dir);
        let gitignore2 = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
        assert.strictEqual(gitignore, gitignore2);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

/**
 * The `.gitignore` block must leave exactly the TEAM config trackable: `stack.json` and
 * `config.json`. Everything else — `credentials.env` (a secret) and, as of this version,
 * `pinsay.sh` and the skill directories (derived, per-machine; every clone re-installs its own
 * copy via `init`/`update`) — must stay ignored.
 *
 * It used to write `.pinsay/` — the directory. Git does not descend into an excluded directory,
 * so it never considered the files inside and the `!` lines were inert: stack.json and
 * config.json were silently ignored, which is precisely the opposite of what the block's own
 * comment says it does. Asserting on the file's TEXT would not have caught it; only asking git
 * what it ignores does.
 */
test('gitignore keeps config.json/stack.json trackable and ignores everything else', async () => {
    const { execFileSync } = await import('node:child_process');

    const starts: Array<[string, string | null]> = [
        ['fresh', null],
        // Written by a version that excluded the directory.
        ['legacy directory form', 'node_modules\n.pinsay/\n'],
        // Written by the earliest version, which ignored only the credentials file.
        ['legacy narrow rule', 'node_modules\n\n# PinSay\n.pinsay/credentials.env\n'],
        // Written by the version immediately before this one: pinsay.sh and
        // credentials.env.example were still re-included, and the skill directories were not
        // mentioned at all.
        [
            'current block (pre-this-version)',
            [
                'node_modules',
                '',
                '# PinSay',
                '.pinsay/*',
                '!.pinsay/credentials.env.example',
                '!.pinsay/stack.json',
                '!.pinsay/pinsay.sh',
                '!.pinsay/config.json',
                '',
            ].join('\n'),
        ],
    ];

    for (const [label, initial] of starts) {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-ignore-'));
        try {
            execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
            if (initial) await fs.writeFile(path.join(dir, '.gitignore'), initial, 'utf8');

            await upsertGitignore(dir, 'PinSay');
            await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
            for (const f of ['stack.json', 'config.json', 'pinsay.sh', 'credentials.env', 'credentials.env.example']) {
                await fs.writeFile(path.join(dir, '.pinsay', f), 'x', 'utf8');
            }
            for (const rel of [
                '.claude/skills/pinsay-init/SKILL.md',
                '.claude/skills/pinsay-feedback/SKILL.md',
                '.agents/skills/pinsay-init/SKILL.md',
                '.agents/skills/pinsay-feedback/SKILL.md',
                // Legacy (pre-2026-09-16) layout: a repo that has not re-run init/update yet.
                '.agents/pinsay-init/SKILL.md',
                '.agents/pinsay-feedback/SKILL.md',
                '.cursor/rules/pinsay-init.md',
                '.cursor/rules/pinsay-feedback.md',
                '.windsurf/rules/pinsay-init.md',
                '.windsurf/rules/pinsay-feedback.md',
            ]) {
                await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
                await fs.writeFile(path.join(dir, rel), 'x', 'utf8');
            }

            const ignored = (rel: string): boolean => {
                try {
                    execFileSync('git', ['check-ignore', rel], { cwd: dir, stdio: 'ignore' });
                    return true;
                } catch {
                    return false;
                }
            };

            for (const f of ['.pinsay/stack.json', '.pinsay/config.json']) {
                assert.strictEqual(ignored(f), false, `${label}: ${f} must be committable`);
            }
            // Everything else in .pinsay/ is derived or a secret, and must stay ignored.
            for (const f of ['.pinsay/credentials.env', '.pinsay/credentials.env.example', '.pinsay/pinsay.sh']) {
                assert.strictEqual(ignored(f), true, `${label}: ${f} must be ignored`);
            }
            // Every skill layout the CLI can write — current and legacy — stays ignored.
            for (const rel of [
                '.claude/skills/pinsay-init/SKILL.md',
                '.claude/skills/pinsay-feedback/SKILL.md',
                '.agents/skills/pinsay-init/SKILL.md',
                '.agents/skills/pinsay-feedback/SKILL.md',
                '.agents/pinsay-init/SKILL.md',
                '.agents/pinsay-feedback/SKILL.md',
                '.cursor/rules/pinsay-init.md',
                '.cursor/rules/pinsay-feedback.md',
                '.windsurf/rules/pinsay-init.md',
                '.windsurf/rules/pinsay-feedback.md',
            ]) {
                assert.strictEqual(ignored(rel), true, `${label}: ${rel} must be ignored`);
            }
            // `.pinsay/projects/` (per-app stack files in a multi-project repo) is re-included,
            // just like stack.json/config.json.
            await fs.mkdir(path.join(dir, '.pinsay/projects'), { recursive: true });
            await fs.writeFile(path.join(dir, '.pinsay/projects/some-app.stack.json'), 'x', 'utf8');
            assert.strictEqual(
                ignored('.pinsay/projects/some-app.stack.json'),
                false,
                `${label}: .pinsay/projects/*.stack.json must be committable`,
            );
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
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
