import { test } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectVite } from '../src/inject/vite.js';
import { planEmbed, findExistingWidget } from '../src/embed/embed.js';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
const START = '<!-- pinsay-feedback:start -->';

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pinsay-embed-'));
}

function write(dir: string, rel: string, content: string): void {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}

function viteFixture(): string {
    const dir = tmp();
    write(dir, 'package.json', JSON.stringify({ name: 'x', devDependencies: { vite: '^5.0.0' } }));
    write(dir, 'vite.config.ts', 'export default {};\n');
    write(dir, 'index.html', '<html><head></head><body></body></html>\n');
    write(dir, '.pinsay/config.json', JSON.stringify({ project: 'my-app', delivery: 'extension', aiTool: 'claude-code' }));
    return dir;
}

function embed(dir: string, args: string[]) {
    const r = spawnSync(process.execPath, [cliPath, 'embed', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PINSAY_SERVER: 'http://127.0.0.1:9', PINSAY_CONFIG_DIR: tmp(), NO_COLOR: '1' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
        }
    };
    walk(dir);
    return out;
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

test('embed injects into a Vite app, once, and records the config', () => {
    const dir = viteFixture();
    const first = embed(dir, ['--yes']);
    assert.strictEqual(first.code, 0, first.err);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.strictEqual(count(html, START), 1);
    assert.match(fs.readFileSync(path.join(dir, '.env.development'), 'utf8'), /^VITE_PINSAY_PROJECT=my-app$/m);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.pinsay/config.json'), 'utf8'));
    assert.strictEqual(cfg.delivery, 'embed');
    assert.strictEqual(cfg.htmlPath, 'index.html');

    assert.strictEqual(embed(dir, ['--yes']).code, 0);
    assert.strictEqual(count(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), START), 1);
});

test('embed --dry-run prints the plan and changes nothing', () => {
    const dir = viteFixture();
    const before = snapshot(dir);
    const r = embed(dir, ['--dry-run']);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(r.out.includes('index.html'));
    assert.ok(r.out.includes('.env.development'));
    assert.ok(r.out.includes('Dry run: nothing was written or sent.'));
    assert.deepStrictEqual(snapshot(dir), before);
});

test('embed without a project exits 2; with --project it needs no key and records the project', () => {
    const empty = tmp();
    const r = embed(empty, []);
    assert.strictEqual(r.code, 2);
    assert.ok(r.err.includes('Run: npx pinsay-cli init --embed'));

    const dir = tmp();
    write(dir, 'index.html', '<html><head></head><body></body></html>\n');
    const ok = embed(dir, ['--project', 'k', '--yes']);
    assert.strictEqual(ok.code, 0, ok.err);
    assert.strictEqual(count(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), START), 1);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.pinsay/config.json'), 'utf8'));
    assert.strictEqual(cfg.project, 'k');
    assert.strictEqual(cfg.delivery, 'embed');
    assert.strictEqual(cfg.htmlPath, 'index.html');
});

test('embed --project in a multi-project repo writes no top-level project into the config', () => {
    const dir = tmp();
    write(dir, 'index.html', '<html><head></head><body></body></html>\n');
    write(dir, '.pinsay/config.json', JSON.stringify({
        aiTool: 'claude-code',
        delivery: 'extension',
        projects: { web: { path: 'apps/web' }, api: { path: 'apps/api' } },
    }));
    const r = embed(dir, ['--project', 'web', '--yes']);
    assert.strictEqual(r.code, 0, r.err);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.pinsay/config.json'), 'utf8'));
    assert.strictEqual(cfg.project, undefined);
    assert.deepStrictEqual(Object.keys(cfg.projects).sort(), ['api', 'web']);
    assert.strictEqual(cfg.delivery, 'embed');
    assert.strictEqual(cfg.htmlPath, 'index.html');
});

test('embed on Next.js changes only the config and points at /pinsay-init', () => {
    const dir = tmp();
    write(dir, 'package.json', JSON.stringify({ name: 'x', dependencies: { next: '14.0.0' } }));
    write(dir, 'app/page.tsx', 'export default function Page() { return null; }\n');
    write(dir, '.pinsay/config.json', JSON.stringify({ project: 'my-app', aiTool: 'claude-code' }));
    const before = snapshot(dir);
    const r = embed(dir, ['--yes']);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(r.out.includes('run /pinsay-init'));
    const after = snapshot(dir);
    for (const f of Object.keys(before)) {
        if (f !== path.join('.pinsay', 'config.json')) assert.strictEqual(after[f], before[f], f);
    }
    assert.deepStrictEqual(Object.keys(after).sort(), Object.keys(before).sort());
});

test('embed never touches a hand-placed snippet', () => {
    const dir = viteFixture();
    const hand = '<html><head></head><body><pinsay-feedback project="x"></pinsay-feedback></body></html>\n';
    write(dir, 'index.html', hand);
    const r = embed(dir, ['--yes']);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), hand);
    assert.ok(r.out.includes('already in your code'));
});

test('planEmbed forInit: a marked block counts as already embedded', async () => {
    const dir = tmp();
    write(dir, 'index.html', `<body>\n${START}\n<pinsay-feedback project="x"></pinsay-feedback>\n<!-- pinsay-feedback:end -->\n</body>\n`);
    const plan = await planEmbed(dir, { forInit: true });
    assert.strictEqual(plan.kind, 'already');
    assert.strictEqual(plan.htmlPath, 'index.html');
    assert.deepStrictEqual(plan.files, []);
});

test('a Vite-injected block (marker only) is found and counts as already for init', async () => {
    const dir = viteFixture();
    await injectVite(dir, { server: 'http://127.0.0.1:9', key: 'my-app', environment: 'local', pin: null, environmentPinned: false }, path.join(dir, 'index.html'));
    const found = await findExistingWidget(dir);
    assert.strictEqual(found?.marked, true);
    const plan = await planEmbed(dir, { forInit: true });
    assert.strictEqual(plan.kind, 'already');
});

test('planEmbed: a repo-relative recordedHtml in a multi-project app is found without a doubled prefix', async () => {
    const dir = tmp();
    write(dir, 'apps/web/custom.html', `<body>\n${START}\n</body>\n`);
    const plan = await planEmbed(dir, { appDir: 'apps/web', recordedHtml: 'apps/web/custom.html', forInit: true });
    assert.strictEqual(plan.kind, 'already');
    assert.strictEqual(plan.htmlPath, 'apps/web/custom.html');
});
