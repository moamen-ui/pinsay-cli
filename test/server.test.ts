import { test } from 'node:test';
import * as assert from 'node:assert';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServer, serverSettingError } from '../src/server.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../dist/cli.js');

async function withEnvServer<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PINSAY_SERVER;
  if (value === undefined) delete process.env.PINSAY_SERVER;
  else process.env.PINSAY_SERVER = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PINSAY_SERVER;
    else process.env.PINSAY_SERVER = prev;
  }
}

async function repoWithConfig(config: object): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-server-test-'));
  await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
  await fs.writeFile(path.join(dir, '.pinsay', 'config.json'), JSON.stringify(config), 'utf8');
  return dir;
}

test('resolveServer: app.pinsay.dev by default, no trailing slash', () =>
  withEnvServer(undefined, async () => {
    assert.strictEqual(resolveServer(), 'https://app.pinsay.dev');
  }));

test('resolveServer: PINSAY_SERVER overrides (tests/e2e), canonicalised and trimmed', () =>
  withEnvServer('https://api.pinsay.dev/', async () => {
    assert.strictEqual(resolveServer(), 'https://app.pinsay.dev');
  }));

test('serverSettingError: --server is refused', () =>
  withEnvServer(undefined, async () => {
    const msg = await serverSettingError(os.tmpdir(), { server: 'https://x.example' });
    assert.match(msg ?? '', /--server was removed/);
  }));

test('serverSettingError: a config naming our server (app or legacy api) is accepted', () =>
  withEnvServer(undefined, async () => {
    for (const server of ['https://app.pinsay.dev', 'https://api.pinsay.dev', 'https://app.pinsay.dev/']) {
      const dir = await repoWithConfig({ server, project: 'p' });
      try {
        assert.strictEqual(await serverSettingError(dir, {}), null, server);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  }));

test('serverSettingError: a config naming another server is refused, with the fix', () =>
  withEnvServer(undefined, async () => {
    const dir = await repoWithConfig({ server: 'https://feedback.example.com', project: 'p' });
    try {
      const msg = await serverSettingError(dir, {});
      assert.match(msg ?? '', /feedback\.example\.com/);
      assert.match(msg ?? '', /Remove the "server" line/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }));

test('serverSettingError: no config at all is fine', () =>
  withEnvServer(undefined, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-server-test-'));
    try {
      assert.strictEqual(await serverSettingError(dir, {}), null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }));

test('CLI: `whoami --server x` exits 2 before any network call', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-server-test-'));
  try {
    await assert.rejects(
      execAsync(`node ${cliPath} whoami --server https://x.example`, { cwd: dir }),
      (err: any) => err.code === 2 && /--server was removed/.test(err.stderr),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CLI: a config naming another server stops `list` with exit 2', async () => {
  const dir = await repoWithConfig({ server: 'https://feedback.example.com', project: 'p' });
  try {
    await assert.rejects(
      execAsync(`node ${cliPath} list`, { cwd: dir }),
      (err: any) => err.code === 2 && /Remove the "server" line/.test(err.stderr),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CLI help texts no longer offer --server', async () => {
  for (const cmd of ['init', 'login', 'logout', 'whoami', 'doctor', 'update', 'mcp']) {
    const { stdout } = await execAsync(`node ${cliPath} ${cmd} --help`);
    assert.doesNotMatch(stdout, /--server/, cmd);
  }
});
