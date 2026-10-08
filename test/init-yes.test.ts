import { test, before, after } from 'node:test';
import * as assert from 'node:assert';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import { gitSymlinkStub } from './git-stub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '../dist/cli.js');

const execAsync = promisify(exec);

let server: http.Server;
let serverUrl: string;

/** Every request the stub saw, in order (tests clear it with `requests.length = 0` before the run they check). */
const requests: Array<{ method: string; path: string; body: any }> = [];

before(async () => {
    server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        const entry = { method: req.method ?? 'GET', path: req.url ?? '', body: undefined as any };
        requests.push(entry);
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            try {
                entry.body = raw ? JSON.parse(raw) : undefined;
            } catch {
                entry.body = raw;
            }
        });

        if (req.url === '/api/branding') {
            res.end(JSON.stringify({
                productName: 'PinSay Test',
                urls: { app: 'http://test' },
                extension: { storeUrl: 'https://chromewebstore.google.com/detail/test', zipUrl: '' },
            }));
        } else if (req.url === '/api/auth/login-with-key') {
            // Models the real endpoint: an API key is exchanged for a JWT, it is NOT a bearer token.
            // The earlier stub accepted the key as `Authorization: Bearer`, which let a CLI bug
            // (calling /api/auth/me with the raw key) pass here and fail against every real server.
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                const apiKey = (() => {
                    try {
                        return JSON.parse(body || '{}').apiKey;
                    } catch {
                        return undefined;
                    }
                })();

                if (apiKey === 'ptr_member') {
                    res.end(
                        JSON.stringify({
                            data: { status: 'ok', token: 'jwt-for-member', user: { displayName: 'Member User', roleName: 'Member' } },
                            isSuccess: true,
                        }),
                    );
                } else if (apiKey === 'ptr_good') {
                    res.end(
                        JSON.stringify({
                            data: { status: 'ok', token: 'jwt-for-test', user: { displayName: 'Test User', roleName: 'Developer' } },
                            isSuccess: true,
                        }),
                    );
                } else {
                    res.writeHead(401);
                    res.end(JSON.stringify({ message: 'Invalid API key' }));
                }
            });
            return;
        } else if (req.url === '/api/auth/me') {
            if (req.headers.authorization === 'Bearer jwt-for-test') {
                res.end(JSON.stringify({ data: { displayName: 'Test User', roleName: 'Developer', isAdmin: true }, isSuccess: true }));
            } else if (req.headers.authorization === 'Bearer jwt-for-member') {
                res.end(JSON.stringify({ data: { displayName: 'Member User', roleName: 'Member', isAdmin: false }, isSuccess: true }));
            } else {
                res.writeHead(401);
                res.end(JSON.stringify({ message: 'Unauthorized' }));
            }
        } else if (req.url === '/pinsay.version.json') {
            res.end(JSON.stringify({ hash: 'abc123', files: { 'widget.js': { integrity: 'sha384-test' } } }));
        } else if (req.url === '/api/admin/projects') {
            if (req.method === 'POST') {
                res.end(JSON.stringify({ key: 'my-app', name: 'My App' }));
            } else {
                res.end(JSON.stringify([]));
            }
        } else if (
            req.url === '/skill.md' ||
            req.url === '/pinsay-init.md' ||
            req.url === '/pinsay.sh' ||
            req.url === '/skills/apply.md' ||
            req.url === '/skills/translate.md' ||
            req.url === '/skills/advanced.md'
        ) {
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
    await new Promise<void>(resolve => server.listen(0, () => {
        const addr = server.address() as import('net').AddressInfo;
        serverUrl = `http://localhost:${addr.port}`;
        resolve();
    }));
});

after(() => {
    server.close();
});

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-init-yes-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    // The isolated global-store sibling directory (see envFor/globalDirFor) — cleaned up here so
    // no test leaves one behind.
    await fs.rm(`${dir}-global`, { recursive: true, force: true });
  }
}

/**
 * Every spawned CLI process gets its own isolated global-credential-store directory, scoped to the
 * test's temp dir. Without this, `init --yes --key ...` — which now defaults to SAVING the key to
 * this machine's real global store (`~/.config/pinsay/credentials.json`) — would write into the
 * actual developer/CI machine's home directory on every test run.
 */
function globalDirFor(dir: string): string {
  // A SIBLING of the repo temp dir, never inside it — inside it, git status in these tests would
  // pick up the global store file itself as an untracked path.
  return `${dir}-global`;
}

function envFor(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, PINSAY_CONFIG_DIR: globalDirFor(dir), PINSAY_SERVER: serverUrl };
}

test('init --yes without --key exits 2', () => withTempDir(async (dir) => {
  try {
    await execAsync(`node ${cliPath} init --yes --create "My App"`, { cwd: dir, env: envFor(dir) });
    assert.fail('Should have exited');
  } catch (err: any) {
    assert.strictEqual(err.code, 2);
    assert.match(err.stdout + err.stderr, /No API key/);
  }
}));

// `exec` gives the child a pipe for stdin, never a TTY — the condition a user hits from CI, a pipe, or an
// editor-embedded shell. SPEC "Interactive": no TTY means no prompts, so with no key anywhere init stops
// at sign-in with the "No API key" line (exit 2) instead of waiting on a prompt that can never be answered.
test('init without a terminal and without a key exits 2 with the No API key line and writes nothing', () => withTempDir(async (dir) => {
  try {
    await execAsync(`node ${cliPath} init --project my-app`, { cwd: dir, env: envFor(dir) });
    assert.fail('a non-interactive init with no key must not report success');
  } catch (err: any) {
    assert.strictEqual(err.code, 2, 'must exit 2 (usage error), not 0');
    assert.match(err.stdout + err.stderr, /No API key/);
  }
  await assert.rejects(fs.stat(path.join(dir, '.pinsay')), 'a refused init must leave no .pinsay/');
}));

test('init --yes with bad key exits 3', () => withTempDir(async (dir) => {
  try {
    await execAsync(`node ${cliPath} init --yes --key ptr_bogus --create "My App"`, { cwd: dir, env: envFor(dir) });
    assert.fail('Should have exited');
  } catch (err: any) {
    assert.strictEqual(err.code, 3);
  }
}));

test('init --json prints JSON and nothing else', () => withTempDir(async (dir) => {
  const { stdout } = await execAsync(`node ${cliPath} init --json --key ptr_good --create "My App"`, { cwd: dir, env: envFor(dir) });
  const lines = stdout.trim().split('\n');
  assert.strictEqual(lines.length, 1, 'Should output exactly one line');
  const json = JSON.parse(lines[0]);
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.project.name, "My App");
  // A first install (no prior .pinsay/config.json) is reported as such — the counterpart to a
  // "join", which reports mode: 'join' below.
  assert.strictEqual(json.mode, 'install');
}));

test('a default --yes run records delivery: extension (the widget is not put in the code unless asked)', () => withTempDir(async (dir) => {
  const { stdout } = await execAsync(`node ${cliPath} init --yes --key ptr_good --create "My App"`, { cwd: dir, env: envFor(dir) });
  assert.match(stdout, /Here's the plan/);
  assert.match(stdout, /Next: install the PinSay Test Chrome extension/);
  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual(config.delivery, 'extension');
}));

test('init --yes finishes when .claude/skills is a plain file (Windows Git symlink stub): warns, keeps the file', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude/skills'), 'notes about skills\nsecond line\n', 'utf8');
  const { stdout, stderr } = await execAsync(`node ${cliPath} init --yes --key ptr_good --create "My App" --tool claude-code`, { cwd: dir, env: envFor(dir) });
  assert.match(stdout, /Here's the plan/);
  assert.match(stderr, /⚠ Skills for claude-code: \.claude\/skills is a file, not a folder/);
  assert.match(stderr, /git config core\.symlinks true/);
  assert.doesNotMatch(stderr, /Fatal error/);
  await fs.access(path.join(dir, '.pinsay/config.json'));
  assert.strictEqual(await fs.readFile(path.join(dir, '.claude/skills'), 'utf8'), 'notes about skills\nsecond line\n');
  await assert.rejects(fs.access(path.join(dir, '.pinsay/pinsay.sh')), 'pinsay.sh is no longer installed');
}));

test('init --yes on a repo whose .claude/skills is a Git symlink stub (Windows checkout) installs and exits 0', () => withTempDir(async (dir) => {
  gitSymlinkStub(dir, '.claude/skills', '../docs/skills');

  // No throw: init succeeds end to end on the CEO's exact Windows shape.
  const { stdout, stderr } = await execAsync(
    `node ${cliPath} init --yes --key ptr_good --create "My App" --tool claude-code`,
    { cwd: dir, env: envFor(dir) },
  );
  assert.match(stdout, /Here's the plan/);
  assert.doesNotMatch(stderr, /Fatal error|⚠ Skills/);

  await fs.access(path.join(dir, 'docs/skills/pinsay-init/SKILL.md'));
  assert.strictEqual(await fs.readFile(path.join(dir, '.claude/skills'), 'utf8'), '../docs/skills');
}));

test('init --json reports skillWarnings when a skill path is blocked', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude/skills'), 'notes about skills\nsecond line\n', 'utf8');
  const { stdout } = await execAsync(`node ${cliPath} init --json --key ptr_good --create "My App" --tool claude-code`, { cwd: dir, env: envFor(dir) });
  const json = JSON.parse(stdout.trim());
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.skillWarnings.length, 2);
  assert.strictEqual(json.skillWarnings[0].tool, 'claude-code');
}));

test('init --yes installs through a link stub to .agents/skills', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.agents/skills'), { recursive: true });
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude/skills'), '../.agents/skills', 'utf8');
  const { stderr } = await execAsync(`node ${cliPath} init --yes --key ptr_good --create "My App" --tool claude-code`, { cwd: dir, env: envFor(dir) });
  assert.doesNotMatch(stderr, /⚠ Skills/);
  await fs.access(path.join(dir, '.agents/skills/pinsay-init/SKILL.md'));
  assert.strictEqual(await fs.readFile(path.join(dir, '.claude/skills'), 'utf8'), '../.agents/skills');
}));

/**
 * A "join": .pinsay/config.json already names a server and a project (written by whoever ran
 * `init` here first, then committed). A second developer cloning the repo should only be asked
 * for their API key — server, project, environment, AI tool and delivery are all read back from
 * the committed config, and nothing is injected (the embed snippet is already in the app's
 * committed source).
 */
test('init --yes joins an already-configured repo, asking only for the key', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({
      server: serverUrl,
      project: 'existing',
      environment: 'local',
      aiTool: 'claude-code',
      delivery: 'embed',
    }),
    'utf8',
  );
  const indexPath = path.join(dir, 'index.html');
  const original = '<html><head></head><body></body></html>';
  await fs.writeFile(indexPath, original, 'utf8');

  // No --project, no --create: a join must succeed with --key alone. --local-credentials keeps
  // this test about the join flow itself (not about where the key lands) by opting into the
  // pre-global-store behaviour — see the credentials-focused tests further down for the default
  // (global store) and --local-credentials on their own.
  const { stdout } = await execAsync(
    `node ${cliPath} init --yes --key ptr_good --local-credentials`,
    { cwd: dir, env: envFor(dir) },
  );
  assert.match(stdout, /Next: tell your AI agent/);

  const html = await fs.readFile(indexPath, 'utf8');
  assert.strictEqual(html, original, 'a join must never inject into the app');
  assert.doesNotMatch(html, /<pinsay-feedback/);

  const creds = await fs.readFile(path.join(dir, '.pinsay/credentials.env'), 'utf8');
  assert.match(creds, /PINSAY_API_KEY=ptr_good/);

  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual(config.project, 'existing', 'the joined project must not change');

  // Skills are gitignored now, so a join is the thing that installs them.
  await fs.access(path.join(dir, '.claude/skills/pinsay-feedback/SKILL.md'));
  await assert.rejects(fs.access(path.join(dir, '.pinsay/pinsay.sh')), 'pinsay.sh is no longer installed');
}));

test('init --json in join mode reports mode: join and does not ask for --project', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({
      server: serverUrl,
      project: 'existing',
      environment: 'local',
      aiTool: 'claude-code',
      delivery: 'embed',
    }),
    'utf8',
  );

  const { stdout } = await execAsync(`node ${cliPath} init --json --key ptr_good`, { cwd: dir, env: envFor(dir) });
  const json = JSON.parse(stdout.trim().split('\n')[0]);
  assert.strictEqual(json.mode, 'join');
  assert.strictEqual(json.project.key, 'existing');
  assert.strictEqual(json.injected, false);
}));

/**
 * A join whose config carries `htmlPath` (a previous run really did inject) still gets the
 * "already embedded, nothing to inject" summary.
 */
test('a join with a recorded htmlPath says the widget is already embedded', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({
      server: serverUrl,
      project: 'existing',
      aiTool: 'claude-code',
      delivery: 'embed',
      htmlPath: 'index.html',
    }),
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');

  const { stdout } = await execAsync(
    `node ${cliPath} init --yes --key ptr_good --local-credentials`,
    { cwd: dir, env: envFor(dir) },
  );
  assert.match(stdout, /Already in your code \(index\.html\)/);
  assert.match(stdout, /Next: tell your AI agent/);
}));

/**
 * A join whose FIRST install was skill-routed (an angular/next/etc. stack with no single entry
 * point) never recorded `htmlPath` — nothing was ever mounted. Before this fix, `init` told every
 * join "the widget is already embedded ... the button should appear", which is false here: the
 * pinsay-init skill still has to run. Regression test for that bug.
 */
test('a join whose first install was skill-routed ends with the join Next line (a join never mounts the widget)', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({
      server: serverUrl,
      project: 'existing',
      aiTool: 'claude-code',
      delivery: 'embed',
    }),
    'utf8',
  );
  // No index.html, no vite config — a next-like package.json so detectStack routes to the skill,
  // exactly as the first (non-join) install here would have.
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { next: '14.0.0' } }),
    'utf8',
  );

  const { stdout } = await execAsync(
    `node ${cliPath} init --yes --key ptr_good --local-credentials`,
    { cwd: dir, env: envFor(dir) },
  );
  assert.match(stdout, /Next: tell your AI agent/);
}));

test('--delivery bogus exits 2', () => withTempDir(async (dir) => {
  try {
    await execAsync(`node ${cliPath} init --yes --key ptr_good --create "My App" --delivery bogus`, { cwd: dir, env: envFor(dir) });
    assert.fail('Should have exited');
  } catch (err: any) {
    assert.strictEqual(err.code, 2);
    assert.match(err.stdout + err.stderr, /Invalid --delivery/);
  }
}));

test('init --yes --delivery extension skips injection and records delivery', () => withTempDir(async (dir) => {
  const indexPath = path.join(dir, 'index.html');
  const original = '<html><head></head><body></body></html>';
  await fs.writeFile(indexPath, original, 'utf8');

  const { stdout } = await execAsync(
    `node ${cliPath} init --yes --key ptr_good --create "My App" --delivery extension`,
    { cwd: dir, env: envFor(dir) },
  );

  const html = await fs.readFile(indexPath, 'utf8');
  assert.strictEqual(html, original, 'extension delivery must not inject anything into the app');
  assert.doesNotMatch(html, /<pinsay-feedback/);

  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual(config.delivery, 'extension');

  assert.match(stdout, /chromewebstore\.google\.com\/detail\/test/, 'summary must print the Web Store URL');
}));

test('init --json --delivery extension reports delivery and the extension URLs', () => withTempDir(async (dir) => {
  const { stdout } = await execAsync(
    `node ${cliPath} init --json --key ptr_good --create "My App" --delivery extension`,
    { cwd: dir, env: envFor(dir) },
  );
  const json = JSON.parse(stdout.trim().split('\n')[0]);
  assert.strictEqual(json.delivery, 'extension');
  assert.strictEqual(json.extension.storeUrl, 'https://chromewebstore.google.com/detail/test');
  assert.strictEqual(json.extension.zipUrl, '');
  assert.strictEqual(json.injected, false);
}));

test('unknown command exits 2', () => withTempDir(async (dir) => {
  try {
    await execAsync(`node ${cliPath} unknowncmd`, { cwd: dir, env: envFor(dir) });
    assert.fail('Should have exited');
  } catch (err: any) {
    assert.strictEqual(err.code, 2);
    assert.match(err.stdout + err.stderr, /Unknown command/);
  }
}));

test('--help works', () => withTempDir(async (dir) => {
  const { stdout } = await execAsync(`node ${cliPath} --help`, { cwd: dir, env: envFor(dir) });
  assert.match(stdout, /Usage: npx pinsay-cli/);
}));

// -----------------------------------------------------------------------------------------------
// Multi-project (monorepo) support: `init --path`
// -----------------------------------------------------------------------------------------------

test('init --yes --path adds a second app to a multi-project config (real Nx-app shape: src/index.html)', () => withTempDir(async (dir) => {
  // The real shape every app in an Nx workspace (e.g. tuwaiq-mono-spa) has: index.html lives
  // under src/, not at the app's own root, and there is no package.json inside the app dir either
  // — apps/a additionally has an Nx project.json (application), apps/b does not (still a valid
  // no-project.json app, per discoverNxApps).
  await fs.mkdir(path.join(dir, 'apps/a/src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'apps/b/src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'apps/a/project.json'),
    JSON.stringify({ name: 'a', projectType: 'application', sourceRoot: 'apps/a/src' }),
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'apps/a/src/index.html'), '<html><head></head><body></body></html>', 'utf8');
  await fs.writeFile(path.join(dir, 'apps/b/src/index.html'), '<html><head></head><body></body></html>', 'utf8');

  await execAsync(
    `node ${cliPath} init --yes --key ptr_good --project p1 --path apps/a --embed`,
    { cwd: dir, env: envFor(dir) },
  );
  await execAsync(
    `node ${cliPath} init --yes --key ptr_good --project p2 --path apps/b --embed`,
    { cwd: dir, env: envFor(dir) },
  );

  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual(config.project, undefined, 'a multi-project config carries no top-level project');
  assert.ok(config.projects, 'config.projects must exist');
  assert.deepStrictEqual(Object.keys(config.projects).sort(), ['p1', 'p2']);
  assert.strictEqual(config.projects.p1.path, 'apps/a');
  assert.strictEqual(config.projects.p2.path, 'apps/b');
  assert.strictEqual(config.projects.p1.htmlPath, 'apps/a/src/index.html', 'the src/index.html candidate must be found and recorded');
  assert.strictEqual(config.projects.p2.htmlPath, 'apps/b/src/index.html');

  const htmlA = await fs.readFile(path.join(dir, 'apps/a/src/index.html'), 'utf8');
  const htmlB = await fs.readFile(path.join(dir, 'apps/b/src/index.html'), 'utf8');
  assert.match(htmlA, /<pinsay-feedback project="p1"/);
  assert.match(htmlB, /<pinsay-feedback project="p2"/);

  await fs.access(path.join(dir, '.pinsay/projects/p1.stack.json'));
  await fs.access(path.join(dir, '.pinsay/projects/p2.stack.json'));

  // This dir is not a git repo: init never writes a root .gitignore, only `.pinsay/.gitignore`.
  await assert.rejects(fs.access(path.join(dir, '.gitignore')));
  await fs.access(path.join(dir, '.pinsay/.gitignore'));
}));

test('init --yes --path migrates an existing single-project config into `projects`', () => withTempDir(async (dir) => {
  // Mirrors the real tuwaiq-mono-spa config: single-project, delivery: extension, no htmlPath
  // (nothing was ever injected for an extension-delivery install).
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({
      server: serverUrl,
      project: 'tuwaiq-profile',
      environment: 'local',
      aiTool: 'claude-code',
      delivery: 'extension',
    }),
    'utf8',
  );
  await fs.mkdir(path.join(dir, 'apps/landing'), { recursive: true });
  await fs.writeFile(path.join(dir, 'apps/landing/index.html'), '<html><head></head><body></body></html>', 'utf8');

  await execAsync(
    `node ${cliPath} init --yes --key ptr_good --project tuwaiq-landing --path apps/landing --embed`,
    { cwd: dir, env: envFor(dir) },
  );

  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual(config.project, undefined);
  assert.deepStrictEqual(Object.keys(config.projects).sort(), ['tuwaiq-landing', 'tuwaiq-profile']);
  // No htmlPath was ever recorded (extension delivery), so the derived path falls back to '.'.
  assert.strictEqual(config.projects['tuwaiq-profile'].path, '.');
  assert.strictEqual(config.projects['tuwaiq-profile'].delivery, 'extension');
  assert.strictEqual(config.projects['tuwaiq-landing'].path, 'apps/landing');
}));

// The migration warning ("please verify this path is correct") exists for the case above, where
// the migrated project is untouched by this run and falls back to a guessed ".". It must NOT fire
// when this same run's own --path/--project targets the project being migrated — that path is
// real, not a guess, because it came straight from the flag the user just passed.
test('init --yes --path migrating the SAME project this run configures does not warn about a guessed path', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({
      server: serverUrl,
      project: 'tuwaiq-profile',
      environment: 'local',
      aiTool: 'claude-code',
      delivery: 'embed',
    }),
    'utf8',
  );
  await fs.mkdir(path.join(dir, 'apps/profile'), { recursive: true });
  await fs.writeFile(path.join(dir, 'apps/profile/index.html'), '<html><head></head><body></body></html>', 'utf8');

  const { stdout } = await execAsync(
    `node ${cliPath} init --yes --key ptr_good --project tuwaiq-profile --path apps/profile --embed`,
    { cwd: dir, env: envFor(dir) },
  );

  assert.doesNotMatch(stdout, /please verify this path is correct/);
  assert.match(stdout, /migrated "tuwaiq-profile" → projects map \(apps\/profile\)/);

  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual(config.project, undefined);
  assert.strictEqual(config.projects['tuwaiq-profile'].path, 'apps/profile', 'the real --path must win over the guessed "."');
}));

// -----------------------------------------------------------------------------------------------
// Global credential store — `init` saves a freshly-authenticated key globally by default
// -----------------------------------------------------------------------------------------------

test('init --global saves the key to the global store and writes no repo credentials.env', () => withTempDir(async (dir) => {
  await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');

  const { stdout } = await execAsync(
    `node ${cliPath} init --yes --global --key ptr_good --create "My App"`,
    { cwd: dir, env: envFor(dir) },
  );
  assert.match(stdout, /key saved on this machine/);

  await assert.rejects(
    fs.access(path.join(dir, '.pinsay/credentials.env')),
    'no repo-local credentials file when the key was saved globally',
  );

  const storePath = path.join(globalDirFor(dir), 'credentials.json');
  const store = JSON.parse(await fs.readFile(storePath, 'utf8'));
  const origin = new URL(serverUrl).origin;
  assert.strictEqual(store[origin].apiKey, 'ptr_good');
  assert.strictEqual(store[origin].displayName, 'Test User');
  assert.ok(store[origin].savedAt);

  // Windows has no POSIX file modes
  if (process.platform !== 'win32') {
    const stat = await fs.stat(storePath);
    assert.strictEqual(stat.mode & 0o777, 0o600, 'the global store file must be 0600');
  }
}));

test('--local-credentials (alias of --scope repo) writes the repo file and not the global store', () => withTempDir(async (dir) => {
  await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');

  await execAsync(
    `node ${cliPath} init --yes --key ptr_good --create "My App" --local-credentials`,
    { cwd: dir, env: envFor(dir) },
  );

  const creds = await fs.readFile(path.join(dir, '.pinsay/credentials.env'), 'utf8');
  assert.match(creds, /PINSAY_API_KEY=ptr_good/);

  await assert.rejects(
    fs.access(path.join(globalDirFor(dir), 'credentials.json')),
    '--local-credentials must not write anything to the global store',
  );
}));

test('a join needs no --key at all when a key is already saved in the global store for this server', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({
      server: serverUrl,
      project: 'existing',
      environment: 'local',
      aiTool: 'claude-code',
      delivery: 'embed',
    }),
    'utf8',
  );
  const indexPath = path.join(dir, 'index.html');
  const original = '<html><head></head><body></body></html>';
  await fs.writeFile(indexPath, original, 'utf8');

  const globalDir = globalDirFor(dir);
  await fs.mkdir(globalDir, { recursive: true });
  await fs.writeFile(
    path.join(globalDir, 'credentials.json'),
    JSON.stringify({
      [new URL(serverUrl).origin]: {
        apiKey: 'ptr_good',
        displayName: 'Test User',
        savedAt: new Date().toISOString(),
      },
    }),
    'utf8',
  );

  // No --key anywhere on the command line — the global store alone must resolve it.
  const { stdout } = await execAsync(`node ${cliPath} init --yes`, {
    cwd: dir,
    env: envFor(dir),
  });
  assert.match(stdout, /Next: tell your AI agent/);

  const html = await fs.readFile(indexPath, 'utf8');
  assert.strictEqual(html, original, 'a join must never inject into the app');

  await assert.rejects(
    fs.access(path.join(dir, '.pinsay/credentials.env')),
    'a key that resolved from the global store must not also be written to the repo',
  );
}));

// -----------------------------------------------------------------------------------------------
// Multi-project setup: per-app question wording, and no PINSAY_PROJECT in credentials.env
// -----------------------------------------------------------------------------------------------

test('appLabel/projectQuestion: naming the app disambiguates the project question, one-app phrasing is unchanged', async () => {
  const { appLabel, projectQuestion } = await import('../src/commands/init.js');

  assert.strictEqual(appLabel('apps/tuwaiq-clubs'), 'apps/tuwaiq-clubs');
  assert.strictEqual(projectQuestion(), 'Which project is this app?');
  assert.strictEqual(
    projectQuestion(appLabel('apps/tuwaiq-clubs')),
    'Which PinSay project is apps/tuwaiq-clubs?',
  );
});

// -----------------------------------------------------------------------------------------------
// Legacy per-repo files: init (every mode) removes them, never touching credentials.env itself
// -----------------------------------------------------------------------------------------------

test('init --yes removes legacy .pinsay/credentials.env.example and .pinsay/.token_cache', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(path.join(dir, '.pinsay/credentials.env.example'), 'PINSAY_API_KEY=\n', 'utf8');
  await fs.writeFile(path.join(dir, '.pinsay/.token_cache'), '{"token":"stale"}', 'utf8');

  const { stdout } = await execAsync(
    `node ${cliPath} init --yes --key ptr_good --create "My App"`,
    { cwd: dir, env: envFor(dir) },
  );

  assert.doesNotMatch(stdout, /removed legacy/, 'the cleanup is silent');

  await assert.rejects(fs.access(path.join(dir, '.pinsay/credentials.env.example')));
  await assert.rejects(fs.access(path.join(dir, '.pinsay/.token_cache')));
}));

test('a join also removes legacy .pinsay files, without touching credentials.env', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({
      server: serverUrl,
      project: 'existing',
      environment: 'local',
      aiTool: 'claude-code',
      delivery: 'embed',
    }),
    'utf8',
  );
  await fs.writeFile(path.join(dir, '.pinsay/credentials.env.example'), 'PINSAY_API_KEY=\n', 'utf8');
  await fs.writeFile(path.join(dir, '.pinsay/.token_cache'), '{"token":"stale"}', 'utf8');
  await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');

  const { stdout } = await execAsync(
    `node ${cliPath} init --yes --key ptr_good --local-credentials`,
    { cwd: dir, env: envFor(dir) },
  );

  assert.match(stdout, /Next: tell your AI agent/);
  assert.doesNotMatch(stdout, /removed legacy/, 'the cleanup is silent');

  await assert.rejects(fs.access(path.join(dir, '.pinsay/credentials.env.example')));
  await assert.rejects(fs.access(path.join(dir, '.pinsay/.token_cache')));

  const creds = await fs.readFile(path.join(dir, '.pinsay/credentials.env'), 'utf8');
  assert.match(creds, /PINSAY_API_KEY=ptr_good/, 'credentials.env itself must never be touched by the cleanup');
}));

test('init --yes --path twice with --local-credentials: credentials.env has neither PINSAY_SERVER nor PINSAY_PROJECT (multi-project)', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, 'apps/a'), { recursive: true });
  await fs.mkdir(path.join(dir, 'apps/b'), { recursive: true });
  await fs.writeFile(path.join(dir, 'apps/a/index.html'), '<html><head></head><body></body></html>', 'utf8');
  await fs.writeFile(path.join(dir, 'apps/b/index.html'), '<html><head></head><body></body></html>', 'utf8');

  await execAsync(
    `node ${cliPath} init --yes --key ptr_good --project p1 --path apps/a --embed --local-credentials`,
    { cwd: dir, env: envFor(dir) },
  );
  await execAsync(
    `node ${cliPath} init --yes --key ptr_good --project p2 --path apps/b --embed --local-credentials`,
    { cwd: dir, env: envFor(dir) },
  );

  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.ok(config.projects && Object.keys(config.projects).length > 1, 'must be multi-project by the second --path');

  const creds = await fs.readFile(path.join(dir, '.pinsay/credentials.env'), 'utf8');
  assert.match(creds, /^PINSAY_API_KEY=ptr_good$/m);
  assert.doesNotMatch(creds, /PINSAY_SERVER=/);
  assert.doesNotMatch(creds, /^PINSAY_PROJECT=/m, 'a multi-project repo must never pin credentials.env to one project — pinsay.sh takes -p there');
}));

test('init --scope repo writes the repo credentials file instead of the global store', () => withTempDir(async (dir) => {
  await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');
  const { stdout } = await execAsync(
    `node ${cliPath} init --yes --key ptr_good --project existing --scope repo`,
    { cwd: dir, env: envFor(dir) },
  );
  assert.match(stdout, /credentials\.env/);
  const creds = await fs.readFile(path.join(dir, '.pinsay/credentials.env'), 'utf8');
  assert.match(creds, /PINSAY_API_KEY=ptr_good/);
}));

test('init --scope with an unknown value exits 2', () => withTempDir(async (dir) => {
  await assert.rejects(
    execAsync(`node ${cliPath} init --yes --key ptr_good --project existing --scope machine`, { cwd: dir, env: envFor(dir) }),
    (err: any) => err.code === 2 && /Invalid --scope/.test(err.stderr),
  );
}));

test('init --yes writes no server into .pinsay/config.json', () => withTempDir(async (dir) => {
  await execAsync(`node ${cliPath} init --yes --key ptr_good --create "My App"`, { cwd: dir, env: envFor(dir) });
  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual('server' in config, false);
  assert.ok(config.project, 'project is still written');
}));

test('a config with a project and no server is a join', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({ project: 'my-app', aiTool: 'claude-code', delivery: 'embed' }),
    'utf8',
  );
  const { stdout } = await execAsync(`node ${cliPath} init --json --key ptr_good`, { cwd: dir, env: envFor(dir) });
  assert.strictEqual(JSON.parse(stdout).mode, 'join');
}));

// -----------------------------------------------------------------------------------------------
// The 0.9.0 init journey (SPEC B0): plan, one confirm, share question, key in the repo
// -----------------------------------------------------------------------------------------------

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(dir: string, args: string, env: NodeJS.ProcessEnv = envFor(dir)): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execAsync(`node ${cliPath} ${args}`, { cwd: dir, env });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const viteFixture = async (dir: string) => {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { vite: '^5.0.0', react: '^18.0.0' } }), 'utf8');
  await fs.writeFile(path.join(dir, 'vite.config.ts'), 'export default {};\n', 'utf8');
  await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');
};

const posts = (path_: RegExp) => requests.filter((r) => r.method === 'POST' && path_.test(r.path));
const exists = (p: string) => fs.access(p).then(() => true, () => false);

test('a fresh --yes init saves the key in the repo, shares the stack once and ends with one Next line', () => withTempDir(async (dir) => {
  requests.length = 0;
  const r = await runCli(dir, 'init --key ptr_good --project my-app --yes');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);

  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual(config.delivery, 'extension');
  assert.strictEqual(config.shareStack, true);

  const keyFile = path.join(dir, '.pinsay/credentials.env');
  assert.match(await fs.readFile(keyFile, 'utf8'), /PINSAY_API_KEY=ptr_good/);
  if (process.platform !== 'win32') assert.strictEqual((await fs.stat(keyFile)).mode & 0o777, 0o600);
  assert.strictEqual(await exists(path.join(globalDirFor(dir), 'credentials.json')), false, 'nothing in the machine store');

  const stack = posts(/^\/api\/projects\/my-app\/stack$/);
  assert.strictEqual(stack.length, 1);
  const allowedStack = new Set(['frontend', 'backend', 'aiTool', 'aiTools']);
  for (const k of Object.keys(stack[0].body)) assert.ok(allowedStack.has(k), `unexpected stack key ${k}`);

  const events = posts(/^\/api\/events$/);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].body.type, 'installed');
  const allowedMeta = new Set(['stack', 'aiTool', 'injected', 'mode', 'cliVersion']);
  for (const k of Object.keys(events[0].body.meta)) assert.ok(allowedMeta.has(k), `unexpected event meta key ${k}`);

  assert.match(r.stdout, /Here's the plan/);
  assert.strictEqual(r.stdout.split('\n').filter((l) => l.startsWith('Next:')).length, 1);
  assert.strictEqual(await exists(path.join(dir, '.pinsay/pinsay.sh')), false, 'pinsay.sh is never written');
}));

test('--no-share-stack: no stack POST, one bare setup-done event, stack.json still written, and nothing later sends more', () => withTempDir(async (dir) => {
  requests.length = 0;
  const r = await runCli(dir, 'init --key ptr_good --project my-app --yes --no-share-stack');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);

  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual(config.shareStack, false);
  assert.strictEqual(posts(/\/stack$/).length, 0);
  const events = posts(/^\/api\/events$/);
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0].body, { type: 'installed', projectKey: 'my-app' });
  await fs.access(path.join(dir, '.pinsay/stack.json'));

  // doctor --fix and apply --mark go through the saved answer: still no stack POST and no new event.
  const before = requests.length;
  await runCli(dir, 'doctor --fix');
  await runCli(dir, 'apply --mark 1 --reply "Changed the button color in Header.tsx" --models m=implementer --no-commit');
  const later = requests.slice(before);
  assert.strictEqual(later.filter((q) => q.method === 'POST' && /\/stack$/.test(q.path)).length, 0);
  assert.strictEqual(later.filter((q) => q.method === 'POST' && q.path === '/api/events').length, 0);
}));

test('init --global saves the key on the machine and writes no repo key file', () => withTempDir(async (dir) => {
  const r = await runCli(dir, 'init --global --key ptr_good --project my-app --yes');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  const store = JSON.parse(await fs.readFile(path.join(globalDirFor(dir), 'credentials.json'), 'utf8'));
  assert.strictEqual(store[new URL(serverUrl).origin].apiKey, 'ptr_good');
  assert.strictEqual(await exists(path.join(dir, '.pinsay/credentials.env')), false);
}));

test('a key already in the machine store is used as is: no repo key file, keySaved existing', () => withTempDir(async (dir) => {
  await fs.mkdir(globalDirFor(dir), { recursive: true });
  await fs.writeFile(
    path.join(globalDirFor(dir), 'credentials.json'),
    JSON.stringify({ [new URL(serverUrl).origin]: { apiKey: 'ptr_good', displayName: 'Test User', savedAt: new Date().toISOString() } }),
    'utf8',
  );
  const r = await runCli(dir, 'init --project my-app --yes --json');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(r.stdout.trim()).keySaved, 'existing');
  assert.strictEqual(await exists(path.join(dir, '.pinsay/credentials.env')), false);
}));

test('init --project with no key anywhere exits 2 with the No API key line and creates no .pinsay/', () => withTempDir(async (dir) => {
  const r = await runCli(dir, 'init --project my-app --yes');
  assert.strictEqual(r.code, 2);
  assert.match(r.stdout + r.stderr, /No API key/);
  assert.strictEqual(await exists(path.join(dir, '.pinsay')), false);
}));

for (const flags of ['--delivery embed', '--html index.html', '--pin']) {
  test(`init ${flags} on a Vite app puts the widget in the code once and records delivery: embed`, () => withTempDir(async (dir) => {
    await viteFixture(dir);
    const r = await runCli(dir, `init --key ptr_good --project my-app --yes ${flags}`);
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
    assert.strictEqual(html.split('pinsay-feedback:start').length - 1, 1, 'the widget block is in index.html exactly once');
    const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
    assert.strictEqual(config.delivery, 'embed');
    assert.match(r.stdout, /Next: start your app and click the/);
  }));
}

test('a repo whose index.html already has the widget is left untouched and recorded as embed', () => withTempDir(async (dir) => {
  const html = '<html><head></head><body><pinsay-feedback project="my-app"></pinsay-feedback></body></html>';
  await fs.writeFile(path.join(dir, 'index.html'), html, 'utf8');
  const r = await runCli(dir, 'init --key ptr_good --project my-app --yes');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.strictEqual(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), html);
  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual(config.delivery, 'embed');
  assert.match(r.stdout, /start your app and click the/);
}));

for (const withKey of [false, true]) {
  test(`init --dry-run ${withKey ? 'with' : 'without'} a saved key writes and sends nothing`, () => withTempDir(async (dir) => {
    if (withKey) {
      await fs.mkdir(globalDirFor(dir), { recursive: true });
      await fs.writeFile(
        path.join(globalDirFor(dir), 'credentials.json'),
        JSON.stringify({ [new URL(serverUrl).origin]: { apiKey: 'ptr_good', savedAt: new Date().toISOString() } }),
        'utf8',
      );
    }
    const globalBefore = await fs.readdir(globalDirFor(dir)).catch(() => []);
    requests.length = 0;
    const r = await runCli(dir, 'init --dry-run --project my-app');
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.deepStrictEqual(await fs.readdir(dir), [], 'no file created in the repo');
    assert.deepStrictEqual(await fs.readdir(globalDirFor(dir)).catch(() => []), globalBefore, 'global dir untouched');
    assert.strictEqual(requests.filter((q) => q.method !== 'GET').length, 0, 'no POST/PATCH/PUT');
    assert.strictEqual(r.stdout.trim().split('\n').pop(), 'Dry run: nothing was written or sent.');
  }));
}

test('init --dry-run --json prints { ok, dryRun, plan }', () => withTempDir(async (dir) => {
  const r = await runCli(dir, 'init --dry-run --json --project my-app');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.dryRun, true);
  assert.strictEqual(out.plan.project.key, 'my-app');
  assert.deepStrictEqual(await fs.readdir(dir), []);
}));

test('init --json adds shareStack, keySaved and nextStep to the old fields', () => withTempDir(async (dir) => {
  const r = await runCli(dir, 'init --json --key ptr_good --project my-app');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.strictEqual(r.stdout.trim().split('\n').length, 1);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.shareStack, true);
  assert.strictEqual(out.keySaved, 'repo');
  assert.match(out.nextStep, /^Next: /);
  for (const k of ['ok', 'mode', 'product', 'server', 'project', 'delivery', 'extension', 'appUrl', 'appUrlSource', 'aiTool', 'stack', 'injected', 'routedToSkill', 'files', 'skillWarnings', 'hiddenFromGit', 'trackedPinsayFiles', 'checks', 'cliVersion']) {
    assert.ok(k in out, `missing ${k}`);
  }
}));

test('non-interactive init installs skills for every AI tool the repo shows', () => withTempDir(async (dir) => {
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude/settings.json'), '{}', 'utf8');
  await fs.mkdir(path.join(dir, '.cursor'), { recursive: true });
  await fs.writeFile(path.join(dir, '.cursor/rules.mdc'), 'x', 'utf8');
  const r = await runCli(dir, 'init --key ptr_good --project my-app --yes');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  await fs.access(path.join(dir, '.claude/skills/pinsay-feedback/SKILL.md'));
  const cursorDir = await fs.readdir(path.join(dir, '.cursor'), { recursive: true } as any);
  assert.ok((cursorDir as string[]).some((f) => f.includes('pinsay')), 'cursor skills were installed');
}));

test('a member account cannot create a project: exit 3 and no POST to /api/admin/projects', () => withTempDir(async (dir) => {
  requests.length = 0;
  const r = await runCli(dir, 'init --key ptr_member --project missing --yes');
  assert.strictEqual(r.code, 3, r.stdout + r.stderr);
  assert.strictEqual(posts(/^\/api\/admin\/projects$/).length, 0);
}));

// ---- Multi-project init (--path, multi join) gets the plan and one confirm ----

const nxFixture = async (dir: string) => {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { react: '^18.0.0' } }), 'utf8');
  await fs.writeFile(path.join(dir, 'nx.json'), '{}', 'utf8');
  await fs.mkdir(path.join(dir, 'apps/web'), { recursive: true });
  await fs.writeFile(path.join(dir, 'apps/web/index.html'), '<html><head></head><body></body></html>', 'utf8');
};

test('init --path --project --yes: plan, one stack POST, projects.web and shareStack true', () => withTempDir(async (dir) => {
  await nxFixture(dir);
  requests.length = 0;
  const r = await runCli(dir, 'init --path apps/web --project web --key ptr_good --yes');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Here's the plan/);
  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual(config.projects.web.path, 'apps/web');
  assert.strictEqual(config.shareStack, true);
  assert.strictEqual(posts(/^\/api\/projects\/web\/stack$/).length, 1);
  await fs.access(path.join(dir, '.pinsay/projects/web.stack.json'));
  assert.strictEqual(r.stdout.split('\n').filter((l) => l.startsWith('Next:')).length, 1);
}));

test('init --path --no-share-stack: zero stack POSTs and one bare installed event', () => withTempDir(async (dir) => {
  await nxFixture(dir);
  requests.length = 0;
  const r = await runCli(dir, 'init --path apps/web --project web --key ptr_good --yes --no-share-stack');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.strictEqual(posts(/\/stack$/).length, 0);
  const events = posts(/^\/api\/events$/);
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0].body, { type: 'installed', projectKey: 'web' });
  const config = JSON.parse(await fs.readFile(path.join(dir, '.pinsay/config.json'), 'utf8'));
  assert.strictEqual(config.shareStack, false);
}));

test('multi join --yes: missing stack files written, json mode join with shareStack', () => withTempDir(async (dir) => {
  await nxFixture(dir);
  await fs.mkdir(path.join(dir, 'apps/api'), { recursive: true });
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({ aiTool: 'claude-code', delivery: 'extension', projects: { web: { path: 'apps/web' }, api: { path: 'apps/api' } } }),
    'utf8',
  );
  requests.length = 0;
  const r = await runCli(dir, 'init --key ptr_good --yes --json');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.strictEqual(out.mode, 'join');
  assert.strictEqual(typeof out.shareStack, 'boolean');
  assert.ok(out.nextStep);
  await fs.access(path.join(dir, '.pinsay/projects/web.stack.json'));
  await fs.access(path.join(dir, '.pinsay/projects/api.stack.json'));
}));

test('init --path --dry-run: prints the plan, writes nothing, sends nothing', () => withTempDir(async (dir) => {
  await nxFixture(dir);
  requests.length = 0;
  const r = await runCli(dir, 'init --path apps/web --project web --dry-run');
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Here's the plan/);
  assert.match(r.stdout, /Dry run: nothing was written or sent\./);
  assert.strictEqual(await exists(path.join(dir, '.pinsay')), false);
  assert.strictEqual(requests.filter((q) => q.method !== 'GET').length, 0);
}));
