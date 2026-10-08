import { test } from 'node:test';
import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { describeError, NetworkError } from '../src/errors.js';
import { ApiError } from '../src/api.js';
import { rmTempDir } from './rm-temp.js';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');

test('describeError maps each failure to a code and one sentence', () => {
    const net = describeError(new NetworkError('app.pinsay.dev'));
    assert.strictEqual(net.code, 4);
    assert.strictEqual(net.message, "Can't reach app.pinsay.dev. Check your internet connection and try again.");

    const s5 = describeError(new ApiError(503, 'x'), 'https://app.pinsay.dev');
    assert.strictEqual(s5.code, 4);
    assert.ok(s5.message.startsWith('app.pinsay.dev is having'));

    assert.strictEqual(describeError(new ApiError(401, 'x')).code, 3);
    assert.strictEqual(describeError(new ApiError(403, 'x')).code, 3);
    assert.strictEqual(describeError(new ApiError(423, 'x')).code, 2);

    const other = describeError(new Error('boom'));
    assert.strictEqual(other.code, 1);
    assert.ok(other.message.includes('PINSAY_DEBUG=1'));
});

function run(args: string[], cwd: string, env: Record<string, string>) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: { ...process.env, ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

async function withProject(fn: (dir: string, configDir: string) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-errors-test-'));
    try {
        await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
        await fs.writeFile(path.join(dir, '.pinsay', 'config.json'), JSON.stringify({ project: 'p' }));
        await fn(dir, `${dir}-global`);
    } finally {
        rmTempDir(dir);
        rmTempDir(`${dir}-global`);
    }
}

async function withStub(handler: http.RequestListener, fn: (url: string) => Promise<void>) {
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
        await fn(`http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`);
    } finally {
        server.close();
    }
}

test('no network: list exits 4 with a plain sentence', async () => {
    await withProject(async (dir, configDir) => {
        const env = { PINSAY_SERVER: 'http://127.0.0.1:9', PINSAY_API_KEY: 'ptr_x', PINSAY_CONFIG_DIR: configDir };
        const r = await run(['list'], dir, env);
        assert.strictEqual(r.code, 4);
        assert.ok(r.stderr.includes("Can't reach 127.0.0.1:9"), r.stderr);
        assert.ok(!/\sat /.test(r.stderr), r.stderr);
        assert.ok(!r.stderr.includes('Fatal error'), r.stderr);

        const j = await run(['list', '--json'], dir, env);
        assert.strictEqual(j.code, 4);
        const parsed = JSON.parse(j.stdout);
        assert.strictEqual(parsed.ok, false);
        assert.strictEqual(parsed.error.code, 4);
    });
});

test('server 5xx: list exits 4', async () => {
    await withProject(async (dir, configDir) => {
        await withStub((_req, res) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{}'); }, async (url) => {
            const r = await run(['list'], dir, { PINSAY_SERVER: url, PINSAY_API_KEY: 'ptr_x', PINSAY_CONFIG_DIR: configDir });
            assert.strictEqual(r.code, 4);
            assert.ok(r.stderr.includes('having trouble right now (HTTP 500)'), r.stderr);
        });
    });
});

test('rejected saved key: list exits 3', async () => {
    await withProject(async (dir, configDir) => {
        await withStub((_req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{}'); }, async (url) => {
            const r = await run(['list'], dir, { PINSAY_SERVER: url, PINSAY_API_KEY: 'ptr_x', PINSAY_CONFIG_DIR: configDir });
            assert.strictEqual(r.code, 3);
            assert.ok(r.stderr.includes('Your saved key no longer works'), r.stderr);
        });
    });
});
