import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { commitUrlFor, isStaged, commitAll, headSha, getRemoteUrl, getUserEmail } from '../src/apply/git.js';

test('commitUrlFor generates correct commit URLs for GitHub, GitLab, Bitbucket, and null for others', () => {
  const sha = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';

  // GitHub (SSH and HTTPS variants)
  assert.equal(
    commitUrlFor(sha, 'git@github.com:pinsay/pinsay.git'),
    `https://github.com/pinsay/pinsay/commit/${sha}`,
  );
  assert.equal(
    commitUrlFor(sha, 'https://github.com/pinsay/pinsay.git'),
    `https://github.com/pinsay/pinsay/commit/${sha}`,
  );
  assert.equal(
    commitUrlFor(sha, 'https://github.com/pinsay/pinsay'),
    `https://github.com/pinsay/pinsay/commit/${sha}`,
  );
  assert.equal(
    commitUrlFor(sha, 'ssh://git@github.com/pinsay/pinsay.git'),
    `https://github.com/pinsay/pinsay/commit/${sha}`,
  );

  // GitLab (SSH and HTTPS variants)
  assert.equal(
    commitUrlFor(sha, 'git@gitlab.com:pinsay/pinsay.git'),
    `https://gitlab.com/pinsay/pinsay/-/commit/${sha}`,
  );
  assert.equal(
    commitUrlFor(sha, 'https://gitlab.com/pinsay/pinsay.git'),
    `https://gitlab.com/pinsay/pinsay/-/commit/${sha}`,
  );

  // Bitbucket (SSH and HTTPS variants)
  assert.equal(
    commitUrlFor(sha, 'git@bitbucket.org:pinsay/pinsay.git'),
    `https://bitbucket.org/pinsay/pinsay/commits/${sha}`,
  );
  assert.equal(
    commitUrlFor(sha, 'https://bitbucket.org/pinsay/pinsay.git'),
    `https://bitbucket.org/pinsay/pinsay/commits/${sha}`,
  );

  // Unknown host
  assert.equal(commitUrlFor(sha, 'git@customhost.example.com:pinsay/pinsay.git'), null);
  assert.equal(commitUrlFor(sha, 'https://customhost.example.com/pinsay/pinsay.git'), null);

  // Local file path
  assert.equal(commitUrlFor(sha, '/var/folders/tmp/bare.git'), null);

  // Null, empty, or whitespace
  assert.equal(commitUrlFor(sha, null), null);
  assert.equal(commitUrlFor(sha, ''), null);
  assert.equal(commitUrlFor(sha, '   '), null);
});

test('git helpers interact correctly with repository staged state and commits', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinsay-git-test-'));
  try {
    spawnSync('git', ['init'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });

    assert.equal(getUserEmail(dir), 'test@example.com');
    assert.equal(isStaged(dir), false);

    // Create and stage a file
    await fs.writeFile(join(dir, 'test.txt'), 'hello\n');
    assert.equal(isStaged(dir), false); // not yet staged

    spawnSync('git', ['add', 'test.txt'], { cwd: dir });
    assert.equal(isStaged(dir), true); // now staged

    // Commit staged file
    const res = commitAll('Initial commit', dir);
    assert.equal(res.success, true);
    assert.equal(isStaged(dir), false); // index empty again

    const sha = headSha(dir);
    assert.match(sha, /^[0-9a-f]{40}$/);

    // Remote inspection
    assert.equal(getRemoteUrl(dir), null);
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/org/repo.git'], { cwd: dir });
    assert.equal(getRemoteUrl(dir), 'https://github.com/org/repo.git');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
