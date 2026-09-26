import { test, before, after } from 'node:test';
import * as assert from 'node:assert';
import { exec, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '../dist/cli.js');
const execAsync = promisify(exec);

let server: http.Server;
let serverUrl: string;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/branding') {
      res.end(JSON.stringify({ productName: 'PinSay Test', urls: { app: 'http://test' } }));
    } else if (req.url === '/api/auth/login-with-key') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.end(
          JSON.stringify({
            data: { status: 'ok', token: 'jwt-for-test', user: { displayName: 'Test User', roleName: 'Developer' } },
            isSuccess: true,
          }),
        );
      });
      return;
    } else if (req.url === '/api/admin/projects') {
      res.end(JSON.stringify(req.method === 'POST' ? { key: 'my-app', name: 'My App' } : []));
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
  await new Promise<void>((resolve) =>
    server.listen(0, () => {
      const addr = server.address() as import('net').AddressInfo;
      serverUrl = `http://localhost:${addr.port}`;
      resolve();
    }),
  );
});

after(() => {
  server.close();
});

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-gitignore-cov-'));
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
 * Every spawned CLI process gets its own isolated global-credential-store directory. `init --yes
 * --key ...` now defaults to saving the key to this machine's real global store
 * (`~/.config/pointer/credentials.json`) — without this override every test below would write into
 * the actual developer/CI machine's home directory.
 */
function globalDirFor(dir: string): string {
  // A SIBLING of the repo temp dir, never inside it — inside it, git status in these tests would
  // pick up the global store file itself as an untracked path.
  return `${dir}-global`;
}

function envFor(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, PINSAY_CONFIG_DIR: globalDirFor(dir) };
}

function gitStatusPorcelain(dir: string): string[] {
  // `--untracked-files=all`: plain `git status --porcelain` collapses an entirely-untracked
  // directory (e.g. `.pinsay/`) into one line regardless of what's ignored inside it — this
  // asks git to list every individual file instead, which is what actually proves the ignore
  // rules are scoped correctly (config.json/stack.json committable, credentials.env not).
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\?\?\s*/, '').replace(/^[AMD]\s+/, ''))
    .sort();
}

/**
 * The gitignore contract, exercised end-to-end rather than by reading `upsertGitignore`'s output
 * text: after a real `init --yes` for every AI tool layout the CLI can write (including a custom
 * `--skills-dir`), `git status --porcelain` must show ONLY the files a repo is actually meant to
 * commit — the injected HTML, `.gitignore` itself, and `.pinsay/config.json` / `stack.json`.
 * Nothing from `.claude/`, `.cursor/`, `.windsurf/`, `.agents/`, or a custom skills dir may appear,
 * whichever tool (or override) produced it.
 */
for (const tool of ['claude-code', 'cursor', 'windsurf', 'other', 'antigravity']) {
  test(`init --yes --tool ${tool}: git status shows only the committed files`, () =>
    withTempDir(async (dir) => {
      execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env: envFor(dir) });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, env: envFor(dir) });
      await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');

      await execAsync(
        `node ${cliPath} init --yes --key ptr_good --create "My App" --server ${serverUrl} --tool ${tool}`,
        { cwd: dir, env: envFor(dir) },
      );

      const files = gitStatusPorcelain(dir);
      assert.deepStrictEqual(files, ['.gitignore', '.pinsay/config.json', '.pinsay/stack.json', 'index.html']);
    }));
}

test('init --yes --skills-dir custom/skills: git status shows only the committed files', () =>
  withTempDir(async (dir) => {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env: envFor(dir) });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, env: envFor(dir) });
    await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');

    await execAsync(
      `node ${cliPath} init --yes --key ptr_good --create "My App" --server ${serverUrl} --skills-dir custom/skills`,
      { cwd: dir, env: envFor(dir) },
    );

    // The override directory must exist (proof the flag actually took effect) but be entirely
    // ignored by git.
    await fs.access(path.join(dir, 'custom/skills/pinsay-init/SKILL.md'));
    await fs.access(path.join(dir, 'custom/skills/pinsay-feedback/SKILL.md'));

    const files = gitStatusPorcelain(dir);
    assert.deepStrictEqual(files, ['.gitignore', '.pinsay/config.json', '.pinsay/stack.json', 'index.html']);
  }));

test('init --yes --path apps/a (multi-project): git status shows only the committed files, including .pinsay/projects/*.stack.json', () =>
  withTempDir(async (dir) => {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env: envFor(dir) });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, env: envFor(dir) });
    await fs.mkdir(path.join(dir, 'apps/a'), { recursive: true });
    await fs.writeFile(path.join(dir, 'apps/a/index.html'), '<html><head></head><body></body></html>', 'utf8');

    await execAsync(
      `node ${cliPath} init --yes --key ptr_good --project p1 --path apps/a --server ${serverUrl}`,
      { cwd: dir, env: envFor(dir) },
    );

    const files = gitStatusPorcelain(dir);
    assert.deepStrictEqual(files, ['.gitignore', '.pinsay/config.json', '.pinsay/projects/p1.stack.json', 'apps/a/index.html']);
  }));
