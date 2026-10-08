import { after, before, test } from 'node:test';
import * as assert from 'node:assert';
import { createProgress } from '../src/init/progress.js';

let prevNoColor: string | undefined;
before(() => {
  prevNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
});
after(() => {
  if (prevNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = prevNoColor;
});

test('lines mode writes one plain line per step', () => {
  const out: string[] = [];
  const progress = createProgress(3, 'lines', (s) => out.push(s));
  progress.step('Saving your key');
  progress.step('Installing skills');
  assert.deepEqual(out, ['[1/3] Saving your key…\n', '[2/3] Installing skills…\n']);
});

test('silent mode writes nothing', () => {
  const out: string[] = [];
  const progress = createProgress(2, 'silent', (s) => out.push(s));
  progress.step('A');
  progress.done();
  assert.deepEqual(out, []);
});

test('tty mode rewrites one line and done clears it', () => {
  const out: string[] = [];
  const progress = createProgress(2, 'tty', (s) => out.push(s));
  progress.step('A');
  progress.done();
  assert.deepEqual(out, ['\r\x1b[2K[1/2] A…', '\r\x1b[2K']);
});
