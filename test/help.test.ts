import { test } from 'node:test';
import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');

const COMMANDS = [
  'init', 'embed', 'login', 'logout', 'remove', 'status', 'open', 'list',
  'get', 'apply', 'reply', 'doctor', 'update', 'map', 'mcp', 'whoami',
];

function run(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('every command --help: at most 25 lines, at most 80 columns, 2-3 examples', async () => {
  for (const command of COMMANDS) {
    const { code, stdout, stderr } = await run([command, '--help']);
    assert.equal(code, 0, `${command} --help exited ${code}: ${stderr}`);
    const lines = stdout.replace(/\n$/, '').split('\n');
    assert.ok(lines.length <= 25, `${command}: ${lines.length} lines (max 25):\n${stdout}`);
    for (const line of lines) {
      assert.ok(line.length <= 80, `${command}: line is ${line.length} columns: ${line}`);
    }
    const header = lines.indexOf('Examples:');
    assert.notEqual(header, -1, `${command}: no Examples section`);
    // Each example starts on its own line at the two-space indent; a wrapped description hangs
    // deeper, so counting these lines counts the examples themselves (2-3 per command).
    const examples = lines.slice(header + 1).filter((l) => /^ {2}npx pinsay-cli /.test(l));
    assert.ok(
      examples.length >= 2 && examples.length <= 3,
      `${command}: ${examples.length} examples (want 2-3):\n${stdout}`,
    );
  }
});

test('top-level --help is grouped and short', async () => {
  const { code, stdout } = await run(['--help']);
  assert.equal(code, 0);
  const lines = stdout.replace(/\n$/, '').split('\n');
  assert.ok(lines.length <= 25, `top-level help has ${lines.length} lines`);
  for (const group of ['Set up', 'Daily', 'Tools']) {
    assert.ok(lines.includes(group), `top-level help misses the "${group}" group`);
  }
  assert.match(stdout, /Exit codes: 0 ok/);
});

test('init --help --all lists every flag, old ones marked (old)', async () => {
  const { code, stdout } = await run(['init', '--help', '--all']);
  assert.equal(code, 0);
  assert.match(stdout, /--delivery/);
  assert.match(stdout, /\(old\)/);
  for (const flag of ['--no-inject', '--scope', '--local-credentials', '--no-share-stack']) {
    assert.ok(stdout.includes(flag), `init --all misses ${flag}`);
  }
  const { stdout: loginAll } = await run(['login', '--help', '--all']);
  assert.match(loginAll, /--scope <global\|repo>/);
  assert.match(loginAll, /--local-credentials.*\(old\)/);
});
