// The style module decides colour and glyphs from the environment. These tests pin that decision
// by setting env vars (and restoring them after every test) rather than by spawning processes —
// the runner's stdout is a pipe, so a colour "on" result here always comes from an explicit env
// var, never from the runner's own terminal state.
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import {
  answeredLine,
  band,
  colorEnabled,
  dim,
  questionLine,
  setColorOverride,
  sym,
} from '../src/ui/style.js';
import { isInteractive } from '../src/ui/interactive.js';

const VARS = ['NO_COLOR', 'FORCE_COLOR', 'CI', 'TERM', 'TERM_PROGRAM', 'WT_SESSION', 'ConEmuTask', 'TERMINUS_SUBLIME'];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  setColorOverride(undefined);
});

test('NO_COLOR turns colour off: helpers return their input unchanged', () => {
  process.env.NO_COLOR = '1';
  assert.strictEqual(colorEnabled(), false);
  assert.strictEqual(dim('x'), 'x');
  assert.strictEqual(questionLine('Q'), '? Q');
  assert.ok(!answeredLine('Q', 'A').includes('\x1b'), 'a no-colour run must not emit an ESC byte');
});

test('FORCE_COLOR forces colour on, including in the question band', () => {
  process.env.FORCE_COLOR = '1';
  assert.strictEqual(colorEnabled(), true);
  assert.ok(band('Q').includes('\x1b[1;97;44m'), 'the band is bold bright-white on blue');
});

test('CI=true turns colour off', () => {
  process.env.CI = 'true';
  assert.strictEqual(colorEnabled(), false);
});

test('TERM=dumb turns colour off', () => {
  process.env.TERM = 'dumb';
  assert.strictEqual(colorEnabled(), false);
});

test('setColorOverride(false) beats FORCE_COLOR=1 (--no-color wins)', () => {
  process.env.FORCE_COLOR = '1';
  setColorOverride(false);
  assert.strictEqual(colorEnabled(), false);
});

test('answeredLine reads as a plain log entry with colour off', () => {
  process.env.NO_COLOR = '1';
  // Pin a Unicode-capable console: on a Windows runner without one, sym.check is the ASCII 'OK' (tested below).
  process.env.WT_SESSION = '1';
  assert.strictEqual(answeredLine('Share framework names', 'Yes'), '✔ Share framework names · Yes');
});

test('isInteractive refuses flags that answer everything', () => {
  assert.strictEqual(isInteractive({ yes: true }), false);
  assert.strictEqual(isInteractive({ json: true }), false);
});

test('a Windows console without Unicode support falls back to ASCII glyphs', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.strictEqual(sym.check, 'OK');
    assert.strictEqual(sym.pointer, '>');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});
