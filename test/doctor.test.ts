import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { compareSemver, runInitChecks } from '../src/checks.js';
import { exitCodeFor } from '../src/commands/doctor.js';
import { saveGlobalCredential } from '../src/credentials.js';

async function scratch(config?: Record<string, unknown>, apiKey?: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-doctor-'));
  if (config) {
    await fs.mkdir(join(dir, '.pinsay'), { recursive: true });
    await fs.writeFile(join(dir, '.pinsay/config.json'), JSON.stringify(config), 'utf8');
  }
  if (apiKey) {
    await fs.mkdir(join(dir, '.pinsay'), { recursive: true });
    await fs.writeFile(join(dir, '.pinsay/credentials.env'), `PINSAY_API_KEY=${apiKey}\n`, 'utf8');
  }
  return dir;
}

/**
 * A stub PinSay server. `routes` maps "METHOD /path" to [status, body]; anything unlisted 404s,
 * which is itself a case doctor must handle (a server that predates /api/meta).
 */
async function stubServer(routes: Record<string, [number, unknown]>): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const key = `${req.method} ${req.url?.split('?')[0]}`;
    const hit = routes[key];
    if (!hit) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isSuccess: false, message: 'not found' }));
      return;
    }
    const [status, body] = hit;
    const isScript = key.endsWith('/widget.js');
    res.writeHead(status, { 'content-type': isScript ? 'application/javascript' : 'application/json' });
    res.end(isScript ? String(body) : JSON.stringify({ isSuccess: status < 400, data: body }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('compareSemver orders releases, and sorts a pre-release below its release', () => {
  assert.ok(compareSemver('1.0.0', '1.0.1') < 0);
  assert.ok(compareSemver('1.2.0', '1.10.0') < 0, 'must compare numerically, not lexically');
  assert.equal(compareSemver('2.3.4', '2.3.4'), 0);
  assert.ok(compareSemver('1.0.0-beta', '1.0.0') < 0, '1.0.0-beta precedes 1.0.0');
  assert.ok(compareSemver('v1.0.0', '1.0.0') === 0, 'a leading v is not a version difference');
});

test('exit code 5 wins over everything, and is what a too-old CLI reports', () => {
  assert.equal(exitCodeFor([{ id: 'meta', status: 'error', message: '' }]), 5);
  assert.equal(
    exitCodeFor([
      { id: 'meta', status: 'error', message: '' },
      { id: 'key', status: 'error', message: '' },
    ]),
    5,
  );
});

test('exit code 3 marks a key problem specifically — it is fixed somewhere else entirely', () => {
  assert.equal(
    exitCodeFor([
      { id: 'key', status: 'error', message: '' },
      { id: 'widget-served', status: 'error', message: '' },
    ]),
    3,
  );
});

test('warnings alone are a pass', () => {
  assert.equal(exitCodeFor([{ id: 'widget', status: 'warn', message: '' }, { id: 'config', status: 'ok', message: '' }]), 0);
  assert.equal(exitCodeFor([{ id: 'stack', status: 'error', message: '' }]), 1);
});

test('a missing config stops the run — there is no server to ask anything of', async () => {
  const dir = await scratch();
  const checks = await runInitChecks(dir);

  assert.equal(checks.length, 1, 'must not attempt network checks with no server configured');
  assert.equal(checks[0].id, 'config');
  assert.equal(checks[0].status, 'error');
  assert.match(checks[0].hint ?? '', /init/);
});

test('a CLI older than minCliVersion stops immediately and skips the rest', async () => {
  const stub = await stubServer({
    'GET /api/branding': [200, { productName: 'PinSay' }],
    'GET /api/meta': [200, { version: '9.0.0', apiVersion: 2, minCliVersion: '5.0.0', serverTime: new Date().toISOString() }],
  });
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local' }, 'ptr_key');

  const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
  await stub.close();

  assert.equal(exitCodeFor(checks), 5);
  // The contract is explicit that later checks are skipped: their answers against a newer server
  // are not trustworthy, and printing them would send the user chasing the wrong thing.
  assert.equal(checks.at(-1)?.id, 'meta');
  assert.ok(!checks.some((c) => c.id === 'key'), 'must not have run the key check');
});

test('a server with no /api/meta warns rather than failing', async () => {
  const stub = await stubServer({ 'GET /api/branding': [200, { productName: 'PinSay' }] });
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local' });

  const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
  await stub.close();

  const meta = checks.find((c) => c.id === 'meta');
  assert.equal(meta?.status, 'warn');
  assert.match(meta?.message ?? '', /predates/);
});

test('an unreachable server fails the server check without hanging the run', async () => {
  // Port 1 is reserved and nothing listens there.
  const dir = await scratch({ server: 'http://127.0.0.1:1', project: 'demo', environment: 'local' });

  const checks = await runInitChecks(dir, {}, '1.0.0');

  assert.equal(checks.find((c) => c.id === 'server')?.status, 'error');
  assert.ok(checks.some((c) => c.id === 'key'), 'the run continues so the user sees every local problem at once');
});

test('a rejected API key is an error, and a valid one unlocks the project check', async () => {
  const now = new Date().toISOString();

  const rejecting = await stubServer({
    'GET /api/branding': [200, {}],
    'GET /api/meta': [200, { minCliVersion: '0.0.1', serverTime: now }],
    'POST /api/auth/login-with-key': [400, { message: 'invalid' }],
  });
  const badDir = await scratch({ server: rejecting.url, project: 'demo', environment: 'local' }, 'ptr_bad');
  const badChecks = await runInitChecks(badDir, { server: rejecting.url }, '1.0.0');
  await rejecting.close();

  assert.equal(badChecks.find((c) => c.id === 'key')?.status, 'error');
  assert.equal(exitCodeFor(badChecks), 3);

  const accepting = await stubServer({
    'GET /api/branding': [200, {}],
    'GET /api/meta': [200, { minCliVersion: '0.0.1', serverTime: now }],
    'POST /api/auth/login-with-key': [200, { status: 'ok', token: 'jwt' }],
    'GET /api/admin/projects': [200, [{ key: 'demo', isActiveLocal: true }]],
    'GET /widget.js': [200, 'console.log(1)'],
  });
  const goodDir = await scratch({ server: accepting.url, project: 'demo', environment: 'local' }, 'ptr_good');
  const goodChecks = await runInitChecks(goodDir, { server: accepting.url }, '1.0.0');
  await accepting.close();

  assert.equal(goodChecks.find((c) => c.id === 'key')?.status, 'ok');
  assert.match(goodChecks.find((c) => c.id === 'key')?.message ?? '', /\(repo credentials\.env\)/);
  assert.equal(goodChecks.find((c) => c.id === 'project')?.status, 'ok');
  assert.equal(goodChecks.find((c) => c.id === 'widget-served')?.status, 'ok');
});

/**
 * The `key` check's message names its SOURCE (env / repo / global) — added when the API key
 * resolver gained a third source (the global per-machine store `pinsay login` writes to). A repo
 * with no `.pinsay/credentials.env` at all should still pass, sourced from the global store, and
 * doctor's hint on a total miss should point at `login`.
 */
test('the key check names its source, including the global store, and hints `login` when nothing resolves', async () => {
  const now = new Date().toISOString();
  const stub = await stubServer({
    'GET /api/branding': [200, {}],
    'GET /api/meta': [200, { minCliVersion: '0.0.1', serverTime: now }],
    'POST /api/auth/login-with-key': [200, { status: 'ok', token: 'jwt' }],
    'GET /api/admin/projects': [200, [{ key: 'demo', isActiveLocal: true }]],
    'GET /widget.js': [200, 'console.log(1)'],
  });

  const prevConfigDir = process.env.PINSAY_CONFIG_DIR;
  const globalDir = await fs.mkdtemp(join(tmpdir(), 'pinsay-doctor-global-'));
  process.env.PINSAY_CONFIG_DIR = globalDir;
  try {
    // No credentials.env at all — only the global store has a key for this server.
    const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local' });
    await saveGlobalCredential(stub.url, { apiKey: 'ptr_global' });

    const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
    assert.equal(checks.find((c) => c.id === 'key')?.status, 'ok');
    assert.match(checks.find((c) => c.id === 'key')?.message ?? '', /\(global store\)/);
  } finally {
    if (prevConfigDir === undefined) delete process.env.PINSAY_CONFIG_DIR;
    else process.env.PINSAY_CONFIG_DIR = prevConfigDir;
    await fs.rm(globalDir, { recursive: true, force: true });
  }
  await stub.close();
});

test('no key anywhere (env, repo, or global) hints `login`', async () => {
  const prevConfigDir = process.env.PINSAY_CONFIG_DIR;
  const globalDir = await fs.mkdtemp(join(tmpdir(), 'pinsay-doctor-global-empty-'));
  process.env.PINSAY_CONFIG_DIR = globalDir;
  try {
    const stub = await stubServer({ 'GET /api/branding': [200, {}] });
    const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local' });

    const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
    await stub.close();

    const key = checks.find((c) => c.id === 'key');
    assert.equal(key?.status, 'error');
    assert.match(key?.hint ?? '', /pinsay-cli login/);
  } finally {
    if (prevConfigDir === undefined) delete process.env.PINSAY_CONFIG_DIR;
    else process.env.PINSAY_CONFIG_DIR = prevConfigDir;
    await fs.rm(globalDir, { recursive: true, force: true });
  }
});

test('a project active for nothing warns, not errors, independent of any configured environment', async () => {
  const stub = await stubServer({
    'GET /api/branding': [200, {}],
    'GET /api/meta': [200, { minCliVersion: '0.0.1', serverTime: new Date().toISOString() }],
    'POST /api/auth/login-with-key': [200, { status: 'ok', token: 'jwt' }],
    'GET /api/admin/projects': [200, [{ key: 'demo', isActiveProduction: false }]],
    'GET /widget.js': [200, 'console.log(1)'],
  });
  // No `environment` in config any more (the field is deprecated) — the check must not depend on
  // one being present, or on its value, to decide the message.
  const dir = await scratch({ server: stub.url, project: 'demo' }, 'ptr_good');

  const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
  await stub.close();

  const project = checks.find((c) => c.id === 'project');
  assert.equal(project?.status, 'warn');
  assert.match(project?.message ?? '', /not active for any environment/);
  assert.match(project?.hint ?? '', /dashboard/i);
});

test('a project active for several environments reports all of them, from the server row alone', async () => {
  const stub = await stubServer({
    'GET /api/branding': [200, {}],
    'GET /api/meta': [200, { minCliVersion: '0.0.1', serverTime: new Date().toISOString() }],
    'POST /api/auth/login-with-key': [200, { status: 'ok', token: 'jwt' }],
    'GET /api/admin/projects': [200, [{ key: 'demo', isActiveLocal: true, isActiveStaging: true, isActiveProduction: false }]],
    'GET /widget.js': [200, 'console.log(1)'],
  });
  const dir = await scratch({ server: stub.url, project: 'demo' }, 'ptr_good');

  const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
  await stub.close();

  const project = checks.find((c) => c.id === 'project');
  assert.equal(project?.status, 'ok');
  assert.match(project?.message ?? '', /active for: local, staging/);
});

test('a project missing from the workspace is an error', async () => {
  const stub = await stubServer({
    'GET /api/branding': [200, {}],
    'GET /api/meta': [200, { minCliVersion: '0.0.1', serverTime: new Date().toISOString() }],
    'POST /api/auth/login-with-key': [200, { status: 'ok', token: 'jwt' }],
    'GET /api/admin/projects': [200, [{ key: 'something-else', isActiveLocal: true }]],
    'GET /widget.js': [200, 'console.log(1)'],
  });
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local' }, 'ptr_good');

  const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
  await stub.close();

  assert.equal(checks.find((c) => c.id === 'project')?.status, 'error');
  assert.equal(exitCodeFor(checks), 1);
});

test('clock skew beyond five minutes warns', async () => {
  const skewed = new Date(Date.now() - 20 * 60_000).toISOString();
  const stub = await stubServer({
    'GET /api/branding': [200, {}],
    'GET /api/meta': [200, { minCliVersion: '0.0.1', serverTime: skewed }],
  });
  const dir = await scratch({ server: stub.url, project: 'demo', environment: 'local' });

  const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
  await stub.close();

  const clock = checks.find((c) => c.id === 'clock');
  assert.equal(clock?.status, 'warn');
  assert.match(clock?.message ?? '', /skew/);
});

test('the widget check accepts either the marker block or a Vite env var', async () => {
  const stub = await stubServer({ 'GET /api/branding': [200, {}] });

  const markerDir = await scratch({ server: stub.url, project: 'demo', environment: 'local' });
  await fs.writeFile(join(markerDir, 'index.html'), '<html><!-- pinsay-feedback:start --></html>', 'utf8');
  const markerChecks = await runInitChecks(markerDir, { server: stub.url }, '1.0.0');
  assert.equal(markerChecks.find((c) => c.id === 'widget')?.status, 'ok');

  const envDir = await scratch({ server: stub.url, project: 'demo', environment: 'local' });
  await fs.writeFile(join(envDir, '.env'), 'VITE_PINSAY_PROJECT=demo\n', 'utf8');
  const envChecks = await runInitChecks(envDir, { server: stub.url }, '1.0.0');
  assert.equal(envChecks.find((c) => c.id === 'widget')?.status, 'ok');

  // Absent is a WARNING, never an error: a Next or Angular install mounts the widget in a
  // component this scan never reads, so "not found" is genuinely inconclusive.
  const emptyDir = await scratch({ server: stub.url, project: 'demo', environment: 'local' });
  const emptyChecks = await runInitChecks(emptyDir, { server: stub.url }, '1.0.0');
  assert.equal(emptyChecks.find((c) => c.id === 'widget')?.status, 'warn');

  await stub.close();
});

test('--server and --project override the config file', async () => {
  const stub = await stubServer({ 'GET /api/branding': [200, {}] });
  const dir = await scratch({ server: 'http://127.0.0.1:1', project: 'stale', environment: 'local' });

  const checks = await runInitChecks(dir, { server: stub.url, project: 'fresh' }, '1.0.0');
  await stub.close();

  assert.match(checks.find((c) => c.id === 'config')?.message ?? '', /fresh/);
  assert.equal(checks.find((c) => c.id === 'server')?.status, 'ok');
});

// -----------------------------------------------------------------------------------------------
// Multi-project (monorepo) doctor checks
// -----------------------------------------------------------------------------------------------

test('multi-project: runs project/widget/stack checks per app, keyed with [project] in the message', async () => {
  const stub = await stubServer({
    'GET /api/branding': [200, {}],
    'GET /api/meta': [200, { minCliVersion: '0.0.1', serverTime: new Date().toISOString() }],
    'POST /api/auth/login-with-key': [200, { status: 'ok', token: 'jwt' }],
    'GET /api/admin/projects': [
      200,
      [
        { key: 'a', isActiveLocal: true },
        { key: 'b', isActiveLocal: false },
      ],
    ],
    'GET /widget.js': [200, 'console.log(1)'],
  });

  const dir = await scratch(
    {
      server: stub.url,
      delivery: 'embed',
      projects: {
        a: { path: 'apps/a', environment: 'local' },
        b: { path: 'apps/b', environment: 'local' },
      },
    },
    'ptr_good',
  );
  await fs.mkdir(join(dir, 'apps/a'), { recursive: true });
  await fs.mkdir(join(dir, 'apps/b'), { recursive: true });
  await fs.writeFile(join(dir, 'apps/a/index.html'), '<html><!-- pinsay-feedback:start --></html>', 'utf8');
  // apps/b has no widget at all — must warn for b specifically, not fail a.

  const checks = await runInitChecks(dir, { server: stub.url }, '1.0.0');
  await stub.close();

  const widgetChecks = checks.filter((c) => c.id === 'widget');
  assert.equal(widgetChecks.length, 2, 'one widget check per project');
  assert.ok(widgetChecks.some((c) => c.message.startsWith('[a] ') && c.status === 'ok'));
  assert.ok(widgetChecks.some((c) => c.message.startsWith('[b] ') && c.status === 'warn'));

  const projectChecks = checks.filter((c) => c.id === 'project');
  assert.equal(projectChecks.length, 2);
  assert.ok(projectChecks.some((c) => c.message.includes('[a]') && c.status === 'ok'));
  assert.ok(projectChecks.some((c) => c.message.includes('[b]') && c.status === 'warn' && c.message.includes('not active for any environment')));

  const stackChecks = checks.filter((c) => c.id === 'stack');
  assert.equal(stackChecks.length, 2);
  assert.ok(stackChecks.every((c) => c.status === 'warn' && c.fixable), 'neither project has a stack file yet');

  const config = checks.find((c) => c.id === 'config');
  assert.equal(config?.status, 'ok');
  assert.match(config?.message ?? '', /2 projects/);
});

test('multi-project: --project narrows every per-project check to that one app', async () => {
  const stub = await stubServer({
    'GET /api/branding': [200, {}],
    'GET /api/meta': [200, { minCliVersion: '0.0.1', serverTime: new Date().toISOString() }],
    'POST /api/auth/login-with-key': [200, { status: 'ok', token: 'jwt' }],
    'GET /api/admin/projects': [200, [{ key: 'a', isActiveLocal: true }]],
    'GET /widget.js': [200, 'console.log(1)'],
  });

  const dir = await scratch(
    {
      server: stub.url,
      projects: { a: { path: 'apps/a' }, b: { path: 'apps/b' } },
    },
    'ptr_good',
  );

  const checks = await runInitChecks(dir, { project: 'a' }, '1.0.0');
  await stub.close();

  assert.equal(checks.filter((c) => c.id === 'widget').length, 1);
  assert.equal(checks.filter((c) => c.id === 'stack').length, 1);
});
