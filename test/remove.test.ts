import { test } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hidePinsayFiles, removeExcludeBlock } from '../src/lib/git-exclude.js';
import { injectVite } from '../src/inject/vite.js';
import { SKILL_FILES } from '../src/skills.js';
import { saveGlobalCredential, globalCredentialsPath } from '../src/credentials.js';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
const SERVER = 'http://127.0.0.1:9';

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pinsay-remove-'));
}

function rm(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function git(dir: string, ...args: string[]): void {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], {
        cwd: dir,
        stdio: 'ignore',
    });
}

function write(dir: string, rel: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
}

function run(dir: string, configDir: string, args: string[]) {
    const r = spawnSync(process.execPath, [cliPath, 'remove', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PINSAY_SERVER: SERVER, PINSAY_CONFIG_DIR: configDir, NO_COLOR: '1' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

async function fixture(dir: string, configDir: string): Promise<{ exclude: string; html: string; env: string }> {
    git(dir, 'init', '-q');
    const exclude = '# mine\n*.log\n';
    fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), exclude, 'utf8');
    const html = '<html><head></head><body></body></html>\n';
    write(dir, 'index.html', html);
    const env = 'USER_LINE=1\n';
    write(dir, '.env.development', env);
    process.env.PINSAY_CONFIG_DIR = configDir;
    await saveGlobalCredential(SERVER, { apiKey: 'ptr_test' });
    await hidePinsayFiles(dir);
    for (const rel of [...SKILL_FILES['claude-code'], ...SKILL_FILES['cursor']]) write(dir, rel, '# skill\n');
    write(
        dir,
        '.pinsay/config.json',
        JSON.stringify({ project: 'my-app', aiTool: 'claude-code', delivery: 'embed', htmlPath: 'index.html' }, null, 2) + '\n',
    );
    await injectVite(dir, { server: SERVER, key: 'my-app', environment: 'local', pin: null, environmentPinned: false });
    return { exclude, html, env };
}

function snapshot(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string, rel: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (rel === '' && e.name === '.git') continue;
            const r = rel === '' ? e.name : `${rel}/${e.name}`;
            const p = path.join(d, e.name);
            if (e.isDirectory()) {
                out.push(`d ${r}`);
                walk(p, r);
            } else if (e.isFile()) {
                out.push(`f ${r} ${fs.readFileSync(p, 'utf8')}`);
            } else {
                out.push(`l ${r}`);
            }
        }
    };
    walk(dir, '');
    return out;
}

test('remove --yes removes everything PinSay added; user files byte-identical; global store unchanged', async () => {
    const dir = tmp();
    const configDir = tmp();
    try {
        const { exclude, html, env } = await fixture(dir, configDir);
        const r = run(dir, configDir, ['--yes']);
        assert.strictEqual(r.code, 0, r.err);
        assert.ok(!fs.existsSync(path.join(dir, '.pinsay')));
        for (const rel of [...SKILL_FILES['claude-code'], ...SKILL_FILES['cursor']]) {
            assert.ok(!fs.existsSync(path.join(dir, rel)), rel);
        }
        assert.ok(!fs.existsSync(path.join(dir, '.claude')), '.claude gone if empty');
        assert.ok(!fs.existsSync(path.join(dir, '.cursor')), '.cursor gone if empty');
        assert.strictEqual(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), exclude);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), html);
        assert.strictEqual(fs.readFileSync(path.join(dir, '.env.development'), 'utf8'), env);
        const store = JSON.parse(fs.readFileSync(globalCredentialsPath(), 'utf8'));
        assert.strictEqual(store['http://127.0.0.1:9'].apiKey, 'ptr_test');
        assert.match(r.out, /Removed \d+ item\(s\)\./);
    } finally {
        rm(dir);
        rm(configDir);
    }
});

test('remove --dry-run prints the list and changes nothing', async () => {
    const dir = tmp();
    const configDir = tmp();
    try {
        await fixture(dir, configDir);
        const before = snapshot(dir);
        const r = run(dir, configDir, ['--dry-run']);
        assert.strictEqual(r.code, 0, r.err);
        assert.deepStrictEqual(snapshot(dir), before);
        assert.ok(r.out.includes('Will remove:'));
        assert.ok(r.out.includes('.pinsay/'));
        assert.ok(r.out.includes('.claude/skills/pinsay-init/'));
        assert.ok(r.out.includes('.cursor/rules/pinsay-init.md'));
        assert.ok(r.out.includes('index.html (PinSay block)'));
        assert.ok(r.out.includes('.env.development (VITE_PINSAY_* lines)'));
        assert.ok(r.out.includes('Dry run: nothing was removed.'));
    } finally {
        rm(dir);
        rm(configDir);
    }
});

test('remove --global --yes removes the global entry too', async () => {
    const dir = tmp();
    const configDir = tmp();
    try {
        await fixture(dir, configDir);
        const r = run(dir, configDir, ['--global', '--yes']);
        assert.strictEqual(r.code, 0, r.err);
        const store = JSON.parse(fs.readFileSync(globalCredentialsPath(), 'utf8'));
        assert.ok(!('http://127.0.0.1:9' in store));
    } finally {
        rm(dir);
        rm(configDir);
    }
});

test('empty folder: the Nothing to remove line, exit 0', () => {
    const dir = tmp();
    try {
        const r = run(dir, tmp(), []);
        assert.strictEqual(r.code, 0);
        assert.ok(r.out.includes("PinSay isn't set up in this folder. Nothing to remove."));
    } finally {
        rm(dir);
    }
});

test('non-interactive without --yes exits 2', async () => {
    const dir = tmp();
    const configDir = tmp();
    try {
        await fixture(dir, configDir);
        const r = run(dir, configDir, []);
        assert.strictEqual(r.code, 2);
        assert.ok(r.err.includes('Pass --yes to remove without a terminal.'));
    } finally {
        rm(dir);
        rm(configDir);
    }
});

test('removeExcludeBlock is the exact inverse of hidePinsayFiles', async () => {
    const dir = tmp();
    try {
        git(dir, 'init', '-q');
        const file = path.join(dir, '.git', 'info', 'exclude');
        const original = '# mine\n*.log\n';
        fs.writeFileSync(file, original, 'utf8');
        await hidePinsayFiles(dir);
        assert.notStrictEqual(fs.readFileSync(file, 'utf8'), original);
        assert.strictEqual(await removeExcludeBlock(dir), true);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
        assert.strictEqual(await removeExcludeBlock(dir), false);
    } finally {
        rm(dir);
    }
});

test('removeExcludeBlock: dry run reports without writing; not a repo returns false', async () => {
    const dir = tmp();
    const plain = tmp();
    try {
        git(dir, 'init', '-q');
        const file = path.join(dir, '.git', 'info', 'exclude');
        await hidePinsayFiles(dir);
        const withBlock = fs.readFileSync(file, 'utf8');
        assert.strictEqual(await removeExcludeBlock(dir, { dryRun: true }), true);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), withBlock);
        assert.strictEqual(await removeExcludeBlock(plain), false);
    } finally {
        rm(dir);
        rm(plain);
    }
});
