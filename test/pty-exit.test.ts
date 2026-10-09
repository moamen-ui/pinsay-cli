import { test, before, after } from 'node:test';
import * as assert from 'node:assert';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(here, '../dist/cli.js');
const helper = path.join(here, 'pty-run.py');
const START = '<!-- pinsay-feedback:start -->';

const execFileAsync = promisify(execFile);
const hasPython = spawnSync('python3', ['--version']).status === 0;
const skip = process.platform === 'win32' ? 'no pty on win32' : !hasPython ? 'python3 not on PATH' : false;

let server: http.Server;
let serverUrl = '';

before(async () => {
    server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            if (req.url === '/api/branding') {
                res.end(JSON.stringify({ productName: 'PinSay Test', urls: { app: 'http://test' }, extension: { storeUrl: '', zipUrl: '' } }));
            } else if (req.url === '/api/auth/login-with-key') {
                const apiKey = (() => { try { return JSON.parse(raw || '{}').apiKey; } catch { return undefined; } })();
                if (apiKey === 'ptr_good') {
                    res.end(JSON.stringify({ data: { status: 'ok', token: 'jwt-for-test', user: { displayName: 'Test User', roleName: 'Developer' } }, isSuccess: true }));
                } else {
                    res.writeHead(401);
                    res.end(JSON.stringify({ message: 'Invalid API key' }));
                }
            } else if (req.url === '/api/auth/me') {
                if (req.headers.authorization === 'Bearer jwt-for-test') {
                    res.end(JSON.stringify({ data: { displayName: 'Test User', roleName: 'Developer', isAdmin: true }, isSuccess: true }));
                } else {
                    res.writeHead(401);
                    res.end(JSON.stringify({ message: 'Unauthorized' }));
                }
            } else if (req.url === '/pinsay.version.json') {
                res.end(JSON.stringify({ hash: 'abc123', files: { 'widget.js': { integrity: 'sha384-test' } } }));
            } else if (req.url === '/api/admin/projects') {
                res.end(JSON.stringify(req.method === 'POST' ? { key: 'my-app', name: 'My App' } : []));
            } else if (req.url?.endsWith('.md') || req.url === '/pinsay.sh') {
                res.setHeader('Content-Type', 'text/plain');
                res.end('skill content');
            } else if (req.url?.startsWith('/api/projects/') && req.url.endsWith('/stack')) {
                res.end(JSON.stringify({}));
            } else if (req.url === '/api/events') {
                res.end(JSON.stringify({}));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ message: 'Not found' }));
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, () => {
        serverUrl = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`;
        resolve();
    }));
});

after(() => {
    server.close();
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const made: string[] = [];

function tmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinsay-pty-'));
    made.push(dir, `${dir}-global`);
    return dir;
}

function write(dir: string, rel: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
}

function viteFixture(): string {
    const dir = tmp();
    write(dir, 'package.json', JSON.stringify({ name: 'x', devDependencies: { vite: '^5.0.0' } }));
    write(dir, 'vite.config.ts', 'export default {};\n');
    write(dir, 'index.html', '<html><head></head><body></body></html>\n');
    write(dir, '.pinsay/config.json', JSON.stringify({ project: 'my-app', delivery: 'extension', aiTool: 'claude-code' }));
    return dir;
}

/** A clean child env: the outer CI / agent-tool signals must not change which prompts appear. */
function ptyEnv(server: string, dir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        TERM: 'xterm',
        CI: '',
        PINSAY_SERVER: server,
        PINSAY_CONFIG_DIR: `${dir}-global`,
    };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'OPENCODE', 'WINDSURF', 'ANTIGRAVITY_AGENT', 'GEMINI_CLI', 'FORCE_COLOR', 'NO_COLOR']) delete env[k];
    return env;
}

/** Runs `node dist/cli.js <args>` in a pseudo-terminal, answering each [trigger, keys] step. */
async function pty(dir: string, server: string, steps: Array<[string, string]>, args: string[]): Promise<{ code: number | 'TIMEOUT'; output: string }> {
    const { stdout: out } = await execFileAsync('python3', ['-I', helper, dir, JSON.stringify(steps), process.execPath, cliPath, ...args], {
        encoding: 'utf8',
        env: ptyEnv(server, dir),
        timeout: 60000,
    });
    return JSON.parse(out.trim().split('\n').pop()!);
}

const DEAD = 'http://127.0.0.1:9';

test('embed: Enter at "Go ahead?" embeds and exits 0', { skip }, async () => {
    const dir = viteFixture();
    const r = await pty(dir, DEAD, [['Go ahead?', '\r']], ['embed']);
    assert.notStrictEqual(r.code, 'TIMEOUT', 'the process must exit on its own');
    assert.strictEqual(r.code, 0, r.output);
    assert.ok(fs.readFileSync(path.join(dir, 'index.html'), 'utf8').includes(START));
});

test('embed: n at "Go ahead?" changes nothing and exits 0', { skip }, async () => {
    const dir = viteFixture();
    const r = await pty(dir, DEAD, [['Go ahead?', 'n']], ['embed']);
    assert.notStrictEqual(r.code, 'TIMEOUT', 'the process must exit on its own');
    assert.strictEqual(r.code, 0, r.output);
    assert.ok(!fs.readFileSync(path.join(dir, 'index.html'), 'utf8').includes(START));
});

function setUpFixture(): string {
    const dir = viteFixture();
    write(dir, 'index.html', `<html><head></head><body>\n${START}\n<script></script>\n<!-- pinsay-feedback:end -->\n</body></html>\n`);
    write(dir, '.pinsay/config.json', JSON.stringify({ project: 'my-app', delivery: 'embed', htmlPath: 'index.html', aiTool: 'claude-code' }));
    return dir;
}

test('remove: y at "Remove these?" removes and exits 0', { skip }, async () => {
    const dir = setUpFixture();
    const r = await pty(dir, DEAD, [['Remove these?', 'y']], ['remove']);
    assert.notStrictEqual(r.code, 'TIMEOUT', 'the process must exit on its own');
    assert.strictEqual(r.code, 0, r.output);
    assert.ok(!fs.existsSync(path.join(dir, '.pinsay')));
});

test('remove: Enter at "Remove these?" removes nothing and exits 0', { skip }, async () => {
    const dir = setUpFixture();
    const r = await pty(dir, DEAD, [['Remove these?', '\r']], ['remove']);
    assert.notStrictEqual(r.code, 'TIMEOUT', 'the process must exit on its own');
    assert.strictEqual(r.code, 0, r.output);
    assert.ok(fs.existsSync(path.join(dir, '.pinsay')));
});

test('init: tools and share questions then "Go ahead?" answered with Enter exits 0', { skip }, async () => {
    const dir = tmp();
    const r = await pty(dir, serverUrl, [['Which AI tools', '\r'], ['Share your project', '\r'], ['Go ahead?', '\r']], ['init', '--key', 'ptr_good', '--project', 'my-app']);
    assert.notStrictEqual(r.code, 'TIMEOUT', 'the process must exit on its own');
    assert.strictEqual(r.code, 0, r.output);
});

test('login --key (no value): hidden key is typed, accepted, never echoed, and the process exits 0', { skip }, async () => {
    const dir = tmp();
    spawnSync('git', ['init', '-q'], { cwd: dir }); // login saves the key in the repo and refuses to run outside one
    const r = await pty(dir, serverUrl, [['input hidden', 'ptr_good\r']], ['login', '--key']);
    assert.notStrictEqual(r.code, 'TIMEOUT', 'the process must exit on its own');
    assert.strictEqual(r.code, 0, r.output);
    assert.ok(!r.output.includes('ptr_good'), 'the typed key must not appear in the output');
});

test('embed --dry-run in a multi-project repo: Enter at the app question exits 0', { skip }, async () => {
    const dir = viteFixture();
    write(dir, 'a/index.html', '<html><head></head><body></body></html>\n');
    write(dir, 'b/index.html', '<html><head></head><body></body></html>\n');
    write(dir, '.pinsay/config.json', JSON.stringify({ projects: { 'app-a': { path: 'a' }, 'app-b': { path: 'b' } }, aiTool: 'claude-code' }));
    const r = await pty(dir, DEAD, [['Which app should get the widget?', '\r']], ['embed', '--dry-run']);
    assert.notStrictEqual(r.code, 'TIMEOUT', 'the process must exit on its own');
    assert.strictEqual(r.code, 0, r.output);
});
