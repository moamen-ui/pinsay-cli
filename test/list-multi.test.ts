import { test, before, after } from 'node:test';
import * as assert from 'node:assert';
import { exec } from 'node:child_process';
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

const COMMENTS_BY_PROJECT: Record<string, unknown[]> = {
  a: [{ id: 1, status: 1, environment: 1, authorName: 'Alice', body: 'Fix the header', route: '/' }],
  b: [],
};

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url || '';

    if (url === '/api/auth/login-with-key') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.end(JSON.stringify({ data: { status: 'ok', token: 'jwt-for-test' }, isSuccess: true }));
      });
      return;
    }

    const match = url.match(/^\/api\/projects\/([^/]+)\/comments/);
    if (match) {
      const key = decodeURIComponent(match[1]);
      res.end(JSON.stringify({ data: { items: COMMENTS_BY_PROJECT[key] ?? [] }, isSuccess: true }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ message: 'Not found' }));
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-list-multi-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeMultiProjectRepo(dir: string) {
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.pinsay/config.json'),
    JSON.stringify({
      server: serverUrl,
      aiTool: 'claude-code',
      delivery: 'embed',
      projects: {
        a: { path: 'apps/a', environment: 'local' },
        b: { path: 'apps/b', environment: 'local' },
      },
    }),
    'utf8',
  );
  await fs.writeFile(path.join(dir, '.pinsay/credentials.env'), 'PINSAY_API_KEY=ptr_good\n', 'utf8');
}

test('list --json with no resolvable project covers every configured project, grouped', () =>
  withTempDir(async (dir) => {
    await writeMultiProjectRepo(dir);

    const { stdout } = await execAsync(`node ${cliPath} list --json`, { cwd: dir });
    const grouped = JSON.parse(stdout);

    assert.strictEqual(grouped.length, 2);
    const byProject = Object.fromEntries(grouped.map((g: any) => [g.project, g.comments]));
    assert.strictEqual(byProject.a.length, 1);
    assert.strictEqual(byProject.a[0].authorName, 'Alice');
    assert.strictEqual(byProject.b.length, 0);
  }));

test('list --json --project narrows to that one project (single-mode shape)', () =>
  withTempDir(async (dir) => {
    await writeMultiProjectRepo(dir);

    const { stdout } = await execAsync(`node ${cliPath} list --json --project a`, { cwd: dir });
    const items = JSON.parse(stdout);
    assert.strictEqual(Array.isArray(items), true, 'a resolved single project keeps the flat array shape');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].authorName, 'Alice');
  }));

test('list --json run from inside an app directory resolves that app without --project', () =>
  withTempDir(async (dir) => {
    await writeMultiProjectRepo(dir);
    await fs.mkdir(path.join(dir, 'apps/b'), { recursive: true });

    const { stdout } = await execAsync(`node ${cliPath} list --json`, { cwd: path.join(dir, 'apps/b') });
    const items = JSON.parse(stdout);
    assert.strictEqual(Array.isArray(items), true);
    assert.strictEqual(items.length, 0);
  }));

test('list human output groups by "## <key> (<path>)" headers', () =>
  withTempDir(async (dir) => {
    await writeMultiProjectRepo(dir);

    const { stdout } = await execAsync(`node ${cliPath} list`, { cwd: dir });
    assert.match(stdout, /## a \(apps\/a\)/);
    assert.match(stdout, /## b \(apps\/b\)/);
    assert.match(stdout, /#1 \[Open\] \[Local\] Alice: Fix the header/);
  }));
