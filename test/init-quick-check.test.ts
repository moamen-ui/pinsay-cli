import { after, before, test } from 'node:test';
import * as assert from 'node:assert';
import type { CheckResult } from '../src/checks.js';
import { quickCheckLines } from '../src/init/quick-check.js';

let prevNoColor: string | undefined;
before(() => {
  prevNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
});
after(() => {
  if (prevNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = prevNoColor;
});

function ok(id: string): CheckResult {
  return { id, status: 'ok', message: `${id} looks good` };
}

test('all checks passing collapses to one line', () => {
  assert.deepEqual(quickCheckLines([ok('a'), ok('b')]), ['✔ Everything checks out.']);
});

test('a warning is one line plus its dim fix, and ok checks never appear', () => {
  const checks: CheckResult[] = [
    ok('server'),
    { id: 'skills', status: 'warn', message: 'skills are out of date', hint: 'Run "npx pinsay-cli update".' },
  ];
  assert.deepEqual(quickCheckLines(checks), ['⚠ skills are out of date', '  Fix: Run "npx pinsay-cli update".']);
});
