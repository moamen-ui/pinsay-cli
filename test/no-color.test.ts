import { test } from 'node:test';
import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTempDir } from './rm-temp.js';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');

/** A closed port: any accidental network call fails fast instead of reaching a real server. */
const CLOSED_SERVER = 'http://127.0.0.1:9';

function run(args: string[], cwd: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, PINSAY_SERVER: CLOSED_SERVER, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** A set-up fixture: .pinsay/config.json (a removal) and an .env.local with a VITE_PINSAY_ line (a dim reason). */
async function withFixture(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-nocolor-test-'));
  try {
    await fs.mkdir(path.join(dir, '.pinsay'), { recursive: true });
    await fs.writeFile(path.join(dir, '.pinsay', 'config.json'), JSON.stringify({ project: 'my-app' }));
    await fs.writeFile(path.join(dir, '.env.local'), 'VITE_PINSAY_PROJECT=my-app\n');
    await fn(dir);
  } finally {
    rmTempDir(dir);
  }
}

/** The colour-deciding env, reset so the runner's own CI/NO_COLOR variables cannot leak in. */
const PLAIN = { NO_COLOR: '', CI: '', FORCE_COLOR: '' };

test('NO_COLOR=1 leaves no ESC byte in open --print, remove --dry-run, init --help', async () => {
  await withFixture(async (dir) => {
    for (const args of [['open', '--print'], ['remove', '--dry-run'], ['init', '--help']]) {
      const { code, stdout, stderr } = await run(args, dir, { ...PLAIN, NO_COLOR: '1' });
      assert.equal(code, 0, `${args.join(' ')} exited ${code}: ${stderr}`);
      assert.ok(!stdout.includes('\x1b'), `${args.join(' ')}: ESC in stdout`);
      assert.ok(!stderr.includes('\x1b'), `${args.join(' ')}: ESC in stderr`);
    }
  });
});

test('--no-color leaves no ESC byte in open --print, remove --dry-run, init --help', async () => {
  await withFixture(async (dir) => {
    for (const args of [['open', '--print', '--no-color'], ['remove', '--dry-run', '--no-color'], ['init', '--help', '--no-color']]) {
      const { code, stdout, stderr } = await run(args, dir, PLAIN);
      assert.equal(code, 0, `${args.join(' ')} exited ${code}: ${stderr}`);
      assert.ok(!stdout.includes('\x1b'), `${args.join(' ')}: ESC in stdout`);
      assert.ok(!stderr.includes('\x1b'), `${args.join(' ')}: ESC in stderr`);
    }
  });
});

test('CI=true leaves no ESC byte in open --print, remove --dry-run, init --help', async () => {
  await withFixture(async (dir) => {
    for (const args of [['open', '--print'], ['remove', '--dry-run'], ['init', '--help']]) {
      const { code, stdout, stderr } = await run(args, dir, { ...PLAIN, CI: 'true' });
      assert.equal(code, 0, `${args.join(' ')} exited ${code}: ${stderr}`);
      assert.ok(!stdout.includes('\x1b'), `${args.join(' ')}: ESC in stdout`);
      assert.ok(!stderr.includes('\x1b'), `${args.join(' ')}: ESC in stderr`);
    }
  });
});

test('FORCE_COLOR=1 with piped output colours the remove --dry-run reasons', async () => {
  await withFixture(async (dir) => {
    const { code, stdout, stderr } = await run(['remove', '--dry-run'], dir, { ...PLAIN, FORCE_COLOR: '1' });
    assert.equal(code, 0, `exited ${code}: ${stderr}`);
    assert.match(stdout, /Will remove:/);
    assert.match(stdout, /\.env\.local/);
    assert.match(stdout, /VITE_PINSAY_\* lines/);
    assert.ok(stdout.includes('\x1b'), 'FORCE_COLOR=1 output has no ESC byte');
  });
});
