import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkAndNotifyUpdates } from '../src/lib/notify-update.js';
import type { PinSayConfig } from '../src/config.js';

test('checkAndNotifyUpdates: notifies when CLI is behind latestCliVersion', async () => {
  const errOutput: string[] = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: any) => {
    errOutput.push(String(chunk));
    return true;
  }) as any;

  try {
    const res = await checkAndNotifyUpdates({
      meta: {
        latestCliVersion: '99.0.0',
      },
      silent: false,
    });

    assert.equal(res.cliUpdateAvailable, true);
    assert.equal(res.skillsUpdateAvailable, false);
    assert.match(errOutput.join(''), /Update available for pinsay-cli/);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

test('checkAndNotifyUpdates: notifies when local skills are out of date', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-notify-test-'));
  const errOutput: string[] = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: any) => {
    errOutput.push(String(chunk));
    return true;
  }) as any;

  try {
    // Write a mock config with claude tool
    const config: PinSayConfig = {
      server: 'https://example.com',
      project: 'test-proj',
      aiTool: 'claude-code',
    };

    // Create a stale skill file in .claude/skills/pinsay-feedback/SKILL.md
    const skillDir = join(dir, '.claude/skills/pinsay-feedback');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: pinsay\n---\n<!-- pinsay-skill-version: old-version-123 -->\n# Skill\n',
      'utf8',
    );

    const res = await checkAndNotifyUpdates({
      meta: {
        skillVersion: 'server-version-456',
        latestCliVersion: '0.0.0-dev', // matches BUILD_CLI_VERSION in dev/test
      },
      config,
      cwd: dir,
      silent: false,
    });

    assert.equal(res.cliUpdateAvailable, false);
    assert.equal(res.skillsUpdateAvailable, true);
    assert.match(errOutput.join(''), /Local AI skills are out of date with the server/);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

test('checkAndNotifyUpdates: stays silent when silent: true', async () => {
  const errOutput: string[] = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: any) => {
    errOutput.push(String(chunk));
    return true;
  }) as any;

  try {
    const res = await checkAndNotifyUpdates({
      meta: {
        latestCliVersion: '99.0.0',
      },
      silent: true,
    });

    assert.equal(res.cliUpdateAvailable, false);
    assert.equal(res.skillsUpdateAvailable, false);
    assert.equal(errOutput.length, 0);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});
