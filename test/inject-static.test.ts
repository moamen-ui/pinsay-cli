import { test } from 'node:test';
import * as assert from 'node:assert';
import { injectStatic } from '../src/inject/static.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

test('injectStatic idempotency', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-static-'));
    try {
        const html = path.join(dir, 'index.html');
        await fs.writeFile(html, '<html><body>Hello</body></html>');
        
        await injectStatic(dir, undefined, { server: 's', key: 'k', environment: 'e' });
        let content = await fs.readFile(html, 'utf8');
        assert.match(content, /pinsay-feedback:start/);
        
        await injectStatic(dir, undefined, { server: 's2', key: 'k2', environment: 'e2' });
        let content2 = await fs.readFile(html, 'utf8');
        assert.match(content2, /s2/);
        assert.strictEqual(content2.match(/pinsay-feedback:start/g)?.length, 1);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

// Environment resolution belongs to the server.
//
// The injected markup deliberately carries NO `environment` attribute: the server decides per
// request, from the page's origin matched against the URLs registered for the project. An
// attribute, if present, OVERRIDES that — so emitting one by default silently disables the
// mechanism, which is exactly what an earlier client-side origin map in here did.
test('injectStatic: several environments still write no environment attribute', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-multienv-'));
    try {
        const html = path.join(dir, 'index.html');
        await fs.writeFile(html, '<html><head></head><body>Hi</body></html>');
        await injectStatic(dir, undefined, {
            server: 'https://api.example.test',
            key: 'proj',
            environment: 'local',
            environments: ['local', 'staging', 'production'],
        });
        const content = await fs.readFile(html, 'utf8');
        assert.doesNotMatch(content, /environment=/, 'the server resolves it; the page must not assert one');
        assert.doesNotMatch(content, /ORIGINS/, 'no hand-maintained origin map — the dashboard owns that');
        assert.match(content, /<pinsay-feedback project="proj"/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('injectStatic: an unpinned install writes NO environment attribute — the server resolves it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-noenv-'));
    try {
        const html = path.join(dir, 'index.html');
        await fs.writeFile(html, '<html><body>Hi</body></html>');
        await injectStatic(dir, undefined, {
            server: 'https://api.example.test',
            key: 'proj',
            environment: 'local',
            environments: ['local'],
        });
        const content = await fs.readFile(html, 'utf8');
        // The whole point: one built file, and the environment decided per request from its origin.
        assert.doesNotMatch(content, /environment=/, 'an unpinned install must not bake an environment in');
        assert.match(content, /<pinsay-feedback project="proj"/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('injectStatic: a single environment keeps the simpler declarative block', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-singleenv-'));
    try {
        const html = path.join(dir, 'index.html');
        await fs.writeFile(html, '<html><body>Hi</body></html>');
        await injectStatic(dir, undefined, {
            server: 'https://api.example.test',
            key: 'proj',
            environment: 'staging',
            environments: ['staging'],
            environmentPinned: true,
        });
        const content = await fs.readFile(html, 'utf8');
        assert.match(content, /environment="staging"/, 'one environment needs no runtime resolution');
        assert.doesNotMatch(content, /DOMContentLoaded/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
