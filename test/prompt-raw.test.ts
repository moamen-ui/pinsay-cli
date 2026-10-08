// Regression tests for the raw-mode prompt paths (review pass 1, findings 1–4): keys typed during
// a raw-mode step — confirm, hidden input — must neither echo to stdout nor survive in a readline
// line buffer as the next answer.
//
// process.stdin is faked the same way test/prompt.test.ts fakes it (isTTY on, raw mode a no-op)
// and the tests emit the very events a real terminal produces: bytes at a readline question,
// decoded keypresses at a raw-mode one. A pty would be flaky in CI and would hide the assertion
// that matters — what exactly lands on stdout.
//
// The leak assertions capture stdout only in synchronous windows around the key presses: inside a
// synchronous span nothing else in the process can write, so the captured bytes are exactly what
// the prompt layer produced (an async capture would also catch the test runner's own writes).
import { test, before, after } from 'node:test';
import * as assert from 'node:assert';
import { ask, confirm, closePrompts } from '../src/prompt.js';

let realIsTTY: unknown;
let realSetRawMode: unknown;
let realForceColor: string | undefined;

before(() => {
  realIsTTY = (process.stdin as any).isTTY;
  realSetRawMode = (process.stdin as any).setRawMode;
  realForceColor = process.env.FORCE_COLOR;
  (process.stdin as any).isTTY = true;
  (process.stdin as any).setRawMode = () => process.stdin;
  // The answered-line collapse exists only with colour on; the runner's stdout is a pipe, so force
  // the colour switch instead of relying on the environment.
  process.env.FORCE_COLOR = '1';
});

after(() => {
  (process.stdin as any).isTTY = realIsTTY;
  (process.stdin as any).setRawMode = realSetRawMode;
  if (realForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = realForceColor;
  closePrompts();
});

const settle = () => new Promise((r) => setTimeout(r, 20));

// Bytes typed at a readline question reach it as stream data, exactly like a real terminal.
const type = (text: string) => process.stdin.emit('data', text);
// A single decoded keypress, the shape node's own keypress decoder produces.
const press = (s: string, name: string) => process.stdin.emit('keypress', s, { name, sequence: s });

// Everything written to stdout while `run` executes, synchronously.
function captureSync(run: () => void): string {
  const chunks: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    (process.stdout as any).write = real;
  }
  return chunks.join('');
}

/** Written text with the escape sequences stripped, so only what a user would see remains. */
const visible = (out: string) => out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

test('confirm: the pressed key is not echoed and does not become the next answer', async () => {
  const first = ask('First question', { default: 'D' });
  await settle();
  type('\r');
  assert.strictEqual(await first, 'D');

  const yes = confirm('Proceed?');
  await settle();
  const echo = captureSync(() => press('y', 'y'));
  assert.strictEqual(await yes, true);
  assert.ok(!visible(echo).includes('y'), `the y pressed at the confirm leaked to stdout: ${JSON.stringify(visible(echo))}`);

  const second = ask('Name', { default: 'Alice' });
  await settle();
  type('\r');
  assert.strictEqual(await second, 'Alice', 'the confirm key must not sit in the line buffer as the next answer');
});

test('ask secret: typed characters are collected, never echoed, never buffered', async () => {
  const secret = ask('Password', { secret: true });
  await settle();
  const echo = captureSync(() => {
    press('s', 's');
    press('e', 'e');
    press('c', 'c');
  });
  press('\r', 'return');
  assert.strictEqual(await secret, 'sec');
  assert.ok(!visible(echo).includes('sec'), `the secret leaked to stdout: ${JSON.stringify(visible(echo))}`);

  // The characters must not reach the shared readline's line buffer either.
  const next = ask('Name', { default: 'Alice' });
  await settle();
  type('\r');
  assert.strictEqual(await next, 'Alice', 'secret characters must not sit in the line buffer as the next answer');
});
