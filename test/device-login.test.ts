// The browser ("device code") sign-in flow for `pinsay login`, mirroring `gh auth login`.
//
// `--no-browser` is what makes this testable without a real terminal: the flow itself never reads
// stdin (it only prints a link/code and polls over HTTP), so `--no-browser` lets it run identically
// to how a real interactive terminal would, without needing a pty (see login.ts's gating comment).
import { test } from 'node:test';
import * as assert from 'node:assert';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '../dist/cli.js');

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-device-login-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Same isolation as credentials.test.ts: PINSAY_CONFIG_DIR redirects the global store away from
 *  a real machine's ~/.config for the whole duration of the child process. */
async function withGlobalDir(fn: (globalDir: string) => Promise<void>) {
  const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-device-login-global-'));
  try {
    await fn(globalDir);
  } finally {
    await fs.rm(globalDir, { recursive: true, force: true });
  }
}

function envFor(globalDir: string): NodeJS.ProcessEnv {
  return { ...process.env, PINSAY_CONFIG_DIR: globalDir };
}

type PollBehavior = 'approve-after-one' | 'deny-immediately' | 'expire-immediately';

/** Spins up a stub server implementing /api/branding + the device/start + device/poll pair. Each
 * test gets its own instance and its own behavior, so no per-test state has to be threaded through
 * a shared server. */
async function withStubServer(
  behavior: PollBehavior,
  fn: (serverUrl: string) => Promise<void>,
): Promise<void> {
  let pollCount = 0;

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/api/branding') {
      res.end(JSON.stringify({ productName: 'PinSay Test', urls: { app: 'http://cli-login.test' } }));
      return;
    }

    if (req.url === '/api/auth/device/start' && req.method === 'POST') {
      res.end(
        JSON.stringify({
          data: {
            deviceCode: 'stub-device-code',
            userCode: 'ABCD-EFGH',
            verificationUrl: 'http://cli-login.test/cli-login?code=ABCD-EFGH',
            expiresInSeconds: 60,
            intervalSeconds: 1,
          },
          isSuccess: true,
        }),
      );
      return;
    }

    if (req.url === '/api/auth/device/poll' && req.method === 'POST') {
      pollCount++;
      let payload: Record<string, unknown>;
      if (behavior === 'deny-immediately') {
        payload = { status: 'denied' };
      } else if (behavior === 'expire-immediately') {
        payload = { status: 'expired' };
      } else if (pollCount === 1) {
        payload = { status: 'pending' };
      } else {
        payload = {
          status: 'approved',
          apiKey: 'ptr_from_device_flow',
          displayName: 'Device User',
          email: 'device@example.test',
        };
      }
      res.end(JSON.stringify({ data: payload, isSuccess: true }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ message: 'Not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as import('net').AddressInfo;
  const serverUrl = `http://localhost:${addr.port}`;

  try {
    await fn(serverUrl);
  } finally {
    server.close();
  }
}

test('login --no-browser: prints the link and code, then saves the key globally once approved', () =>
  withStubServer('approve-after-one', (serverUrl) =>
    withTempDir((repo) =>
      withGlobalDir(async (globalDir) => {
        const { stdout } = await execAsync(`node ${cliPath} login --no-browser --server ${serverUrl}`, {
          cwd: repo,
          env: envFor(globalDir),
        });

        assert.match(stdout, /Open this link and enter the code to sign in/);
        assert.match(stdout, /http:\/\/cli-login\.test\/cli-login\?code=ABCD-EFGH/);
        assert.match(stdout, /Code: ABCD-EFGH/);
        assert.match(stdout, /Waiting for approval/);
        assert.match(stdout, /Signed in to .* as Device User \(device@example\.test\)/);
        assert.match(stdout, /saved for all repos on this machine/);

        const store = JSON.parse(await fs.readFile(path.join(globalDir, 'credentials.json'), 'utf8'));
        assert.strictEqual(store[new URL(serverUrl).origin].apiKey, 'ptr_from_device_flow');
        assert.strictEqual(store[new URL(serverUrl).origin].email, 'device@example.test');
      }),
    ),
  ));

test('login --no-browser: a denied code exits 3 with a clear message', () =>
  withStubServer('deny-immediately', (serverUrl) =>
    withTempDir((repo) =>
      withGlobalDir(async (globalDir) => {
        await assert.rejects(
          execAsync(`node ${cliPath} login --no-browser --server ${serverUrl}`, { cwd: repo, env: envFor(globalDir) }),
          (err: any) => {
            assert.strictEqual(err.code, 3);
            assert.match(err.stderr, /denied/i);
            return true;
          },
        );
      }),
    ),
  ));

test('login --no-browser: an expired code exits 3 with a clear message', () =>
  withStubServer('expire-immediately', (serverUrl) =>
    withTempDir((repo) =>
      withGlobalDir(async (globalDir) => {
        await assert.rejects(
          execAsync(`node ${cliPath} login --no-browser --server ${serverUrl}`, { cwd: repo, env: envFor(globalDir) }),
          (err: any) => {
            assert.strictEqual(err.code, 3);
            assert.match(err.stderr, /expired/i);
            return true;
          },
        );
      }),
    ),
  ));

test('login: no --key and no TTY (and no --no-browser) exits 2 with the fallback hint', () =>
  // Behavior is irrelevant here — the command must exit on the TTY/--no-browser/--key check
  // before ever calling device/start or device/poll. Only /api/branding (fetched up front for the
  // product name) needs to answer.
  withStubServer('deny-immediately', (serverUrl) =>
    withTempDir((repo) =>
      withGlobalDir(async (globalDir) => {
        await assert.rejects(
          execAsync(`node ${cliPath} login --server ${serverUrl}`, { cwd: repo, env: envFor(globalDir) }),
          (err: any) => {
            assert.strictEqual(err.code, 2);
            assert.match(err.stderr, /npx pinsay-cli login --key <key>/);
            assert.match(err.stderr, /PINSAY_API_KEY/);
            return true;
          },
        );
      }),
    ),
  ));
