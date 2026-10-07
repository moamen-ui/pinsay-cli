import { test } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { hidePinsayFiles, formatHideWarnings, pinsayDirGitignore } from '../src/lib/git-exclude.js';

async function tmp(): Promise<string> {
    return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-exclude-')));
}

function git(dir: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], {
        cwd: dir,
        encoding: 'utf8',
    });
}

async function repo(): Promise<string> {
    const dir = await tmp();
    git(dir, 'init', '-q');
    return dir;
}

const excludeOf = (dir: string) => path.join(dir, '.git', 'info', 'exclude');

async function write(dir: string, rel: string, body = 'x'): Promise<void> {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body, 'utf8');
}

test('not a repo: writes .pinsay/.gitignore, no .git', async () => {
    const dir = await tmp();
    try {
        const r = await hidePinsayFiles(dir);
        assert.strictEqual(r.status, 'not-a-repo');
        assert.strictEqual(await fs.readFile(path.join(dir, '.pinsay/.gitignore'), 'utf8'), pinsayDirGitignore());
        await assert.rejects(fs.access(path.join(dir, '.git')));
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('fresh repo: block written once, original lines kept, second call unchanged', async () => {
    const dir = await repo();
    try {
        const original = await fs.readFile(excludeOf(dir), 'utf8');
        const r = await hidePinsayFiles(dir);
        assert.strictEqual(r.status, 'written');
        const after = await fs.readFile(excludeOf(dir), 'utf8');
        assert.strictEqual(after.split('\n').filter((l) => l.startsWith('# pinsay-cli: begin')).length, 1);
        assert.ok(after.includes('\n/.pinsay/\n'));
        assert.ok(after.includes('\n/.claude/skills/pinsay-init/\n'));
        assert.ok(after.startsWith(original.trimEnd()));
        const r2 = await hidePinsayFiles(dir);
        assert.strictEqual(r2.status, 'unchanged');
        assert.strictEqual(await fs.readFile(excludeOf(dir), 'utf8'), after);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('extra paths: only safe repo-relative ones are used', async () => {
    const dir = await repo();
    try {
        await hidePinsayFiles(dir, ['docs/skills/pinsay-init/', '../outside/x/', 'C:/abs/']);
        const text = await fs.readFile(excludeOf(dir), 'utf8');
        assert.ok(text.includes('/docs/skills/pinsay-init/'));
        assert.ok(!text.includes('outside'));
        assert.ok(!text.includes('C:/abs'));
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('older block: pinsay-* extra lines kept, stale lines dropped, outside text untouched', async () => {
    const dir = await repo();
    try {
        await fs.writeFile(
            excludeOf(dir),
            [
                '# mine',
                '# pinsay-cli: begin (old)',
                '/.pinsay/',
                '/docs/skills/pinsay-feedback/',
                '/old-thing',
                '# pinsay-cli: end',
                '*.log',
                '',
            ].join('\n'),
            'utf8',
        );
        await hidePinsayFiles(dir);
        const text = await fs.readFile(excludeOf(dir), 'utf8');
        assert.ok(text.includes('/docs/skills/pinsay-feedback/'));
        assert.ok(!text.includes('/old-thing'));
        assert.ok(text.startsWith('# mine\n# pinsay-cli: begin'));
        assert.ok(text.endsWith('# pinsay-cli: end\n*.log\n'));
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('CRLF exclude file stays CRLF', async () => {
    const dir = await repo();
    try {
        await fs.writeFile(excludeOf(dir), '# mine\r\n', 'utf8');
        await hidePinsayFiles(dir);
        let text = await fs.readFile(excludeOf(dir), 'utf8');
        assert.ok(!/(^|[^\r])\n/.test(text), 'only CRLF line endings');
        assert.ok(text.startsWith('# mine\r\n'));
        await hidePinsayFiles(dir);
        text = await fs.readFile(excludeOf(dir), 'utf8');
        assert.ok(!/(^|[^\r])\n/.test(text), 'still only CRLF');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('linked worktree: the common .git/info/exclude is written', async () => {
    const dir = await repo();
    const wt = `${dir}-wt`;
    try {
        await write(dir, 'a.txt');
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'one');
        git(dir, 'worktree', 'add', '-q', wt, '-b', 'wt');
        const r = await hidePinsayFiles(wt);
        assert.strictEqual(r.status, 'written');
        const viaGit = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'info/exclude').trim());
        assert.strictEqual(await fs.realpath(r.file!), await fs.realpath(viaGit));
        assert.ok((await fs.readFile(excludeOf(dir), 'utf8')).includes('# pinsay-cli: begin'));
    } finally {
        await fs.rm(wt, { recursive: true, force: true });
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('subfolder: lines carry the folder prefix', async () => {
    const dir = await repo();
    try {
        await fs.mkdir(path.join(dir, 'apps/web'), { recursive: true });
        await hidePinsayFiles(path.join(dir, 'apps/web'));
        const text = await fs.readFile(excludeOf(dir), 'utf8');
        assert.ok(text.includes('\n/apps/web/.pinsay/\n'));
        assert.ok(text.includes('\n/apps/web/.claude/skills/pinsay-init/\n'));
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('tracked PinSay files are reported with the git rm command (team files are not)', async () => {
    const dir = await repo();
    try {
        await write(dir, '.pinsay/pinsay.sh');
        await write(dir, '.pinsay/config.json');
        await write(dir, '.claude/skills/pinsay-init/SKILL.md');
        git(dir, 'add', '-f', '.');
        git(dir, 'commit', '-q', '-m', 'oops');
        const r = await hidePinsayFiles(dir);
        assert.deepStrictEqual(r.tracked, ['.claude/skills/pinsay-init/SKILL.md', '.pinsay/pinsay.sh']);
        const lines = formatHideWarnings(r);
        assert.ok(
            lines[1].includes('git rm -r --cached -- .claude/skills/pinsay-init/SKILL.md .pinsay/pinsay.sh'),
            lines[1],
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('end to end: git status lists only a user\'s own skill', async () => {
    const dir = await repo();
    try {
        await hidePinsayFiles(dir);
        await write(dir, '.pinsay/credentials.env');
        await write(dir, '.pinsay/config.json');
        await write(dir, '.claude/skills/pinsay-init/SKILL.md');
        await write(dir, '.agents/skills/pinsay-init/SKILL.md');
        await write(dir, '.cursor/rules/pinsay-init.md');
        await write(dir, '.claude/skills/my-own-skill/SKILL.md');
        const out = git(dir, 'status', '--porcelain', '--untracked-files=all');
        const files = out
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => l.replace(/^\?\?\s*/, ''));
        console.log(out);
        assert.deepStrictEqual(files, ['.claude/skills/my-own-skill/SKILL.md']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
