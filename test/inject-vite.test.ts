import { test } from 'node:test';
import * as assert from 'node:assert';
import { injectVite } from '../src/inject/vite.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

test('injectVite writes .env.development (never the shared .env) and upserts .env.example', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-vite-'));
    try {
        await fs.writeFile(path.join(dir, 'index.html'), '<html><body>Hello</body></html>');
        await fs.writeFile(path.join(dir, '.env.example'), 'EXISTING=1\n');

        await injectVite(dir, { server: 's', key: 'k', environment: 'e' });

        const envContent = await fs.readFile(path.join(dir, '.env.development'), 'utf8');
        assert.match(envContent, /VITE_PINSAY_SERVER=s/);

        // Never the shared `.env` — pinsay-init.md Scope rule 2: a plain `.env` is loaded for
        // every configuration including production.
        await assert.rejects(fs.access(path.join(dir, '.env')));

        const envExContent = await fs.readFile(path.join(dir, '.env.example'), 'utf8');
        assert.match(envExContent, /^VITE_PINSAY_SERVER=$/m);
        assert.match(envExContent, /^VITE_PINSAY_PROJECT=$/m);
        assert.doesNotMatch(envExContent, /VITE_PINSAY_ENABLED/);
        assert.match(envExContent, /EXISTING=1/);

        // idempotency
        await injectVite(dir, { server: 's2', key: 'k2', environment: 'e2' });
        const envContent2 = await fs.readFile(path.join(dir, '.env.development'), 'utf8');
        assert.match(envContent2, /VITE_PINSAY_SERVER=s2/);
        assert.strictEqual(envContent2.match(/VITE_PINSAY_SERVER/g)?.length, 1);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('injectVite continues upserting an existing .env.local rather than also creating .env.development', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-vite-local-'));
    try {
        await fs.writeFile(path.join(dir, 'index.html'), '<html><body>Hello</body></html>');
        // Simulate a repo whose dev env already lives in .env.local (e.g. hand-set up, or written
        // by another tool) — re-running init should upsert it in place, not also create
        // .env.development alongside it.
        await fs.writeFile(path.join(dir, '.env.local'), 'SOME_OTHER_VAR=1\n');

        const modified = await injectVite(dir, { server: 's', key: 'k', environment: 'e' });

        assert.ok(modified.includes('.env.local'));
        assert.ok(!modified.includes('.env.development'));
        await assert.rejects(fs.access(path.join(dir, '.env.development')));
        await assert.rejects(fs.access(path.join(dir, '.env')));

        const envContent = await fs.readFile(path.join(dir, '.env.local'), 'utf8');
        assert.match(envContent, /VITE_PINSAY_SERVER=s/);
        assert.match(envContent, /VITE_PINSAY_PROJECT=k/);
        assert.match(envContent, /SOME_OTHER_VAR=1/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('injectVite writes no VITE_PINSAY_ENV unless the environment is pinned, and drops a stale one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-vite-env-'));
    try {
        await fs.writeFile(path.join(dir, 'index.html'), '<html><body>Hello</body></html>');
        // An older init wrote the env var; the widget no longer reads it (environment is resolved
        // from the page origin server-side), so a re-run must remove it rather than keep it current.
        await fs.writeFile(path.join(dir, '.env.development'), 'VITE_PINSAY_ENABLED=true\nVITE_PINSAY_ENV=staging\nOTHER=1\n');
        await fs.writeFile(path.join(dir, '.env.example'), 'VITE_PINSAY_ENABLED=false\nVITE_PINSAY_ENV=\n');

        await injectVite(dir, { server: 's', key: 'k', environment: 'local' });
        const env = await fs.readFile(path.join(dir, '.env.development'), 'utf8');
        assert.doesNotMatch(env, /VITE_PINSAY_ENV/);
        assert.doesNotMatch(env, /VITE_PINSAY_ENABLED/);
        assert.match(env, /OTHER=1/);
        assert.match(env, /VITE_PINSAY_PROJECT=k/);
        const ex = await fs.readFile(path.join(dir, '.env.example'), 'utf8');
        assert.doesNotMatch(ex, /VITE_PINSAY_ENV/);
        assert.doesNotMatch(ex, /VITE_PINSAY_ENABLED/);
        assert.match(ex, /VITE_PINSAY_PROJECT=/);

        // `--environment` given → pinned → the var is written so the snippet's attribute resolves.
        await injectVite(dir, { server: 's', key: 'k', environment: 'staging', environmentPinned: true });
        const pinned = await fs.readFile(path.join(dir, '.env.development'), 'utf8');
        assert.match(pinned, /^VITE_PINSAY_ENV=staging$/m);
        assert.strictEqual(pinned.match(/VITE_PINSAY_ENV/g)?.length, 1);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('injectVite cleans widget keys out of a legacy shared .env from a pre-fix install', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-vite-legacy-env-'));
    try {
        await fs.writeFile(path.join(dir, 'index.html'), '<html><body>Hello</body></html>');
        // What a pre-fix `init` left behind: the widget's keys in the shared `.env`, loaded in
        // every configuration including production — the exact bug this fixes.
        await fs.writeFile(
            path.join(dir, '.env'),
            'VITE_PINSAY_ENABLED=true\nVITE_PINSAY_SERVER=https://old.example\nVITE_PINSAY_PROJECT=old-key\nVITE_PINSAY_ENV=staging\nOTHER=1\n',
        );

        const modified = await injectVite(dir, { server: 'https://new.example', key: 'new-key', environment: 'e' });

        assert.ok(modified.includes('.env.development'));
        assert.ok(modified.includes('.env'), '.env should be reported as modified (cleaned)');

        // The new file gets the current values.
        const devEnv = await fs.readFile(path.join(dir, '.env.development'), 'utf8');
        assert.match(devEnv, /VITE_PINSAY_SERVER=https:\/\/new\.example/);
        assert.match(devEnv, /VITE_PINSAY_PROJECT=new-key/);

        // The legacy shared `.env` loses every widget key but keeps everything else.
        const legacyEnv = await fs.readFile(path.join(dir, '.env'), 'utf8');
        assert.doesNotMatch(legacyEnv, /VITE_PINSAY_/);
        assert.match(legacyEnv, /OTHER=1/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('injectVite does not touch .env when it has no widget keys, and is a no-op when there is no .env at all', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-vite-no-legacy-'));
    try {
        await fs.writeFile(path.join(dir, 'index.html'), '<html><body>Hello</body></html>');
        await fs.writeFile(path.join(dir, '.env'), 'SOME_UNRELATED_APP_VAR=1\n');

        const modified = await injectVite(dir, { server: 's', key: 'k', environment: 'e' });

        assert.ok(!modified.includes('.env'), '.env has nothing to clean, so it must not be reported as modified');
        const legacyEnv = await fs.readFile(path.join(dir, '.env'), 'utf8');
        assert.strictEqual(legacyEnv, 'SOME_UNRELATED_APP_VAR=1\n');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
