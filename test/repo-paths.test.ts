import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { linkOrCopy, resolveRepoPath, RepoPathError, writeRepoFile } from '../src/lib/repo-paths.js';

// The primary skills path, repo-relative, used across the cases below.
const R = '.claude/skills/pinsay-init/SKILL.md';

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(join(tmpdir(), 'pinsay-repo-paths-'));
}

/** Writes a plain file at `dir`/`rel` (mkdir its parent first) and returns its absolute path. */
async function stubFile(dir: string, rel: string, content: string): Promise<string> {
  const abs = join(dir, rel);
  await fsp.mkdir(dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  return abs;
}

/**
 * Makes `dir` a Git repo that tracks `.claude/skills` as a mode-120000 symlink to
 * `../.agents/skills`, and writes the plain file `.claude/skills` with that content (no newline) —
 * the shape Git for Windows produces with core.symlinks=false.
 */
async function gitSymlinkStub(dir: string): Promise<void> {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: '../.agents/skills' })
    .toString()
    .trim();
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${sha},.claude/skills`], { cwd: dir });
  await stubFile(dir, '.claude/skills', '../.agents/skills');
}

test('resolveRepoPath create:true from an empty dir creates the folders and returns the plain path', async () => {
  const dir = await tempDir();
  try {
    const r = await resolveRepoPath(dir, R, { create: true });
    assert.equal(r.abs, join(dir, R));
    const st = await fsp.stat(join(dir, '.claude/skills/pinsay-init'));
    assert.ok(st.isDirectory());
    assert.equal(r.redirectedVia, undefined);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true over existing folders returns the same abs', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, '.claude/skills/pinsay-init'), { recursive: true });
    const r = await resolveRepoPath(dir, R, { create: true });
    assert.equal(r.abs, join(dir, R));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true stops on a plain file in the way and leaves it unchanged', async () => {
  const dir = await tempDir();
  try {
    await stubFile(dir, '.claude/skills', 'hello\nworld\n');
    await assert.rejects(
      () => resolveRepoPath(dir, R, { create: true }),
      (err: unknown) => {
        assert.ok(err instanceof RepoPathError);
        assert.equal(err.kind, 'file-in-the-way');
        assert.equal(err.blocker, '.claude/skills');
        assert.match(err.message, /\.claude\/skills is a file, not a folder/);
        assert.match(err.hint, /git config core\.symlinks true/);
        return true;
      },
    );
    assert.equal(await fsp.readFile(join(dir, '.claude/skills'), 'utf8'), 'hello\nworld\n');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true follows an untracked stub file whose target exists as a folder', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, '.agents/skills'), { recursive: true });
    await stubFile(dir, '.claude/skills', '../.agents/skills');
    const r = await resolveRepoPath(dir, R, { create: true });
    assert.equal(r.abs, join(dir, '.agents/skills/pinsay-init/SKILL.md'));
    assert.equal(r.redirectedVia, '.claude/skills');
    assert.equal(await fsp.readFile(join(dir, '.claude/skills'), 'utf8'), '../.agents/skills');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true follows a stub with backslash separators in its content', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, '.agents/skills'), { recursive: true });
    await stubFile(dir, '.claude/skills', '..\\.agents\\skills');
    const r = await resolveRepoPath(dir, R, { create: true });
    assert.equal(r.abs, join(dir, '.agents/skills/pinsay-init/SKILL.md'));
    assert.equal(r.redirectedVia, '.claude/skills');
    assert.equal(await fsp.readFile(join(dir, '.claude/skills'), 'utf8'), '..\\.agents\\skills');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true follows a stub with a CRLF line ending', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, '.agents/skills'), { recursive: true });
    await stubFile(dir, '.claude/skills', '../.agents/skills\r\n');
    const r = await resolveRepoPath(dir, R, { create: true });
    assert.equal(r.abs, join(dir, '.agents/skills/pinsay-init/SKILL.md'));
    assert.equal(r.redirectedVia, '.claude/skills');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true follows a Git-tracked mode-120000 stub even when its target is missing', async () => {
  const dir = await tempDir();
  try {
    await gitSymlinkStub(dir);
    const r = await resolveRepoPath(dir, R, { create: true });
    assert.equal(r.abs, join(dir, '.agents/skills/pinsay-init/SKILL.md'));
    const st = await fsp.stat(join(dir, '.agents/skills/pinsay-init'));
    assert.ok(st.isDirectory());
    assert.equal(await fsp.readFile(join(dir, '.claude/skills'), 'utf8'), '../.agents/skills');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true leaves an untracked stub with a missing target as a file in the way', async () => {
  const dir = await tempDir();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await stubFile(dir, '.claude/skills', '../.agents/skills');
    await assert.rejects(
      () => resolveRepoPath(dir, R, { create: true }),
      (err: unknown) => {
        assert.ok(err instanceof RepoPathError);
        assert.equal(err.kind, 'file-in-the-way');
        return true;
      },
    );
    await assert.rejects(fsp.access(join(dir, '.agents')), /ENOENT/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true stops when a stub points outside the repository', async () => {
  const dir = await tempDir();
  const outside = await tempDir();
  try {
    await fsp.mkdir(join(outside, 'skills'), { recursive: true });
    await stubFile(dir, '.claude/skills', relative(join(dir, '.claude'), join(outside, 'skills')));
    await assert.rejects(
      () => resolveRepoPath(dir, R, { create: true }),
      (err: unknown) => {
        assert.ok(err instanceof RepoPathError);
        assert.equal(err.kind, 'link-outside-repo');
        return true;
      },
    );
    assert.deepEqual(await fsp.readdir(join(outside, 'skills')), []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true follows a broken symlink and the link starts working', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, '.claude'), { recursive: true });
    await fsp.symlink('../.agents/skills', join(dir, '.claude/skills'), 'file');
    const r = await resolveRepoPath(dir, R, { create: true });
    assert.equal(r.abs, join(dir, '.agents/skills/pinsay-init/SKILL.md'));
    await fsp.writeFile(r.abs, 'x', 'utf8');
    assert.equal(await fsp.readFile(join(dir, R), 'utf8'), 'x');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true stops when a broken symlink points outside the repository', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, '.claude'), { recursive: true });
    await fsp.symlink(`../../definitely-outside-${Date.now()}`, join(dir, '.claude/skills'), 'file');
    await assert.rejects(
      () => resolveRepoPath(dir, R, { create: true }),
      (err: unknown) => {
        assert.ok(err instanceof RepoPathError);
        assert.equal(err.kind, 'link-outside-repo');
        return true;
      },
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true walks through a live symlink to a folder', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, 'real-skills'), { recursive: true });
    await fsp.mkdir(join(dir, '.claude'), { recursive: true });
    await fsp.symlink('../real-skills', join(dir, '.claude/skills'), 'file');
    const r = await resolveRepoPath(dir, R, { create: true });
    assert.equal(r.abs, join(dir, R));
    const st = await fsp.stat(join(dir, 'real-skills/pinsay-init'));
    assert.ok(st.isDirectory());
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true stops when a live symlink points to a file', async () => {
  const dir = await tempDir();
  try {
    await stubFile(dir, 'file.txt', 'content');
    await fsp.mkdir(join(dir, '.claude'), { recursive: true });
    await fsp.symlink('../file.txt', join(dir, '.claude/skills'), 'file');
    await assert.rejects(
      () => resolveRepoPath(dir, R, { create: true }),
      (err: unknown) => {
        assert.ok(err instanceof RepoPathError);
        assert.equal(err.kind, 'file-in-the-way');
        assert.match(err.message, /points to a file/);
        return true;
      },
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true stops on a symlink loop', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, '.claude'), { recursive: true });
    await fsp.symlink('b', join(dir, '.claude/a'), 'file');
    await fsp.symlink('a', join(dir, '.claude/b'), 'file');
    await assert.rejects(
      () => resolveRepoPath(dir, '.claude/a/x/SKILL.md', { create: true }),
      (err: unknown) => {
        assert.ok(err instanceof RepoPathError);
        assert.equal(err.kind, 'link-loop');
        return true;
      },
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:false never creates anything', async () => {
  const dir = await tempDir();
  try {
    const r = await resolveRepoPath(dir, R, { create: false });
    assert.equal(r.abs, join(dir, R));
    await assert.rejects(fsp.access(join(dir, '.claude')), /ENOENT/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:false still redirects through a stub but creates nothing', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, '.agents/skills'), { recursive: true });
    await stubFile(dir, '.claude/skills', '../.agents/skills');
    const r = await resolveRepoPath(dir, R, { create: false });
    assert.equal(r.abs, join(dir, '.agents/skills/pinsay-init/SKILL.md'));
    assert.equal(r.redirectedVia, '.claude/skills');
    await assert.rejects(fsp.access(join(dir, '.agents/skills/pinsay-init')), /ENOENT/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRepoPath create:true keeps plain mkdir -p for a path outside the repo', async () => {
  const dir = await tempDir();
  try {
    const base = basename(dir);
    const rel = join('..', `${base}-out`, 'x', 'SKILL.md');
    const r = await resolveRepoPath(dir, rel, { create: true });
    assert.equal(r.abs, resolve(dir, rel));
    const st = await fsp.stat(resolve(dir, '..', `${base}-out`, 'x'));
    assert.ok(st.isDirectory());
    await fsp.rm(resolve(dir, '..', `${base}-out`), { recursive: true, force: true });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('writeRepoFile writes through a redirected path and leaves the stub unchanged', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, '.agents/skills'), { recursive: true });
    await stubFile(dir, '.claude/skills', '../.agents/skills');
    await writeRepoFile(dir, R, 'body');
    assert.equal(await fsp.readFile(join(dir, '.agents/skills/pinsay-init/SKILL.md'), 'utf8'), 'body');
    assert.equal(await fsp.readFile(join(dir, '.claude/skills'), 'utf8'), '../.agents/skills');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('writeRepoFile stops when a folder is at the final path', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, R), { recursive: true });
    await assert.rejects(
      () => writeRepoFile(dir, R, 'body'),
      (err: unknown) => {
        assert.ok(err instanceof RepoPathError);
        assert.equal(err.kind, 'directory-in-the-way');
        return true;
      },
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('writeRepoFile replaces a broken symlink at the final path with a regular file', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, '.claude/skills/pinsay-init'), { recursive: true });
    await fsp.symlink('nowhere.md', join(dir, R), 'file');
    await writeRepoFile(dir, R, 'body');
    const st = await fsp.lstat(join(dir, R));
    assert.ok(st.isFile());
    assert.equal(await fsp.readFile(join(dir, R), 'utf8'), 'body');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('writeRepoFile writes through a live symlink at the final path', async () => {
  const dir = await tempDir();
  try {
    await stubFile(dir, 'real.md', 'original');
    await fsp.mkdir(join(dir, '.claude/skills/pinsay-init'), { recursive: true });
    await fsp.symlink('../../../real.md', join(dir, R), 'file');
    await writeRepoFile(dir, R, 'body');
    const st = await fsp.lstat(join(dir, R));
    assert.ok(st.isSymbolicLink());
    assert.equal(await fsp.readFile(join(dir, 'real.md'), 'utf8'), 'body');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('linkOrCopy makes a relative symlink from the mirror to the source', async () => {
  const dir = await tempDir();
  try {
    const source = await stubFile(dir, '.claude/skills/pinsay-init/SKILL.md', 'src');
    const dest = join(dir, '.agents/skills/pinsay-init/SKILL.md');
    const r = await linkOrCopy(dir, source, '.agents/skills/pinsay-init/SKILL.md');
    assert.equal(r.mode, 'link');
    assert.equal(
      await fsp.readlink(dest),
      join('..', '..', '..', '.claude', 'skills', 'pinsay-init', 'SKILL.md'),
    );
    assert.equal(await fsp.readFile(dest, 'utf8'), 'src');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('linkOrCopy twice keeps the existing link', async () => {
  const dir = await tempDir();
  try {
    const source = await stubFile(dir, '.claude/skills/pinsay-init/SKILL.md', 'src');
    const dest = join(dir, '.agents/skills/pinsay-init/SKILL.md');
    const first = await linkOrCopy(dir, source, '.agents/skills/pinsay-init/SKILL.md');
    assert.equal(first.mode, 'link');
    const second = await linkOrCopy(dir, source, '.agents/skills/pinsay-init/SKILL.md');
    assert.equal(second.mode, 'link');
    const st = await fsp.lstat(dest);
    assert.ok(st.isSymbolicLink());
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('linkOrCopy replaces an earlier regular file at the destination with a link', async () => {
  const dir = await tempDir();
  try {
    const source = await stubFile(dir, '.claude/skills/pinsay-init/SKILL.md', 'src');
    const dest = join(dir, '.agents/skills/pinsay-init/SKILL.md');
    await stubFile(dir, '.agents/skills/pinsay-init/SKILL.md', 'old');
    const r = await linkOrCopy(dir, source, '.agents/skills/pinsay-init/SKILL.md');
    assert.equal(r.mode, 'link');
    const st = await fsp.lstat(dest);
    assert.ok(st.isSymbolicLink());
    assert.equal(await fsp.readFile(dest, 'utf8'), 'src');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('linkOrCopy replaces a broken symlink at the destination with a link', async () => {
  const dir = await tempDir();
  try {
    const source = await stubFile(dir, '.claude/skills/pinsay-init/SKILL.md', 'src');
    const dest = join(dir, '.agents/skills/pinsay-init/SKILL.md');
    await fsp.mkdir(join(dir, '.agents/skills/pinsay-init'), { recursive: true });
    await fsp.symlink('gone.md', dest, 'file');
    const r = await linkOrCopy(dir, source, '.agents/skills/pinsay-init/SKILL.md');
    assert.equal(r.mode, 'link');
    assert.equal(await fsp.readFile(dest, 'utf8'), 'src');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('linkOrCopy reports same when the destination already is the source file', async () => {
  const dir = await tempDir();
  try {
    await fsp.mkdir(join(dir, '.agents/skills'), { recursive: true });
    await stubFile(dir, '.claude/skills', '../.agents/skills');
    const source = await stubFile(dir, '.agents/skills/pinsay-init/SKILL.md', 'src');
    const r = await linkOrCopy(dir, source, '.agents/skills/pinsay-init/SKILL.md');
    assert.equal(r.mode, 'same');
    const st = await fsp.lstat(source);
    assert.ok(st.isFile());
    assert.ok(!st.isSymbolicLink());
    assert.equal(await fsp.readFile(source, 'utf8'), 'src');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('linkOrCopy falls back to a copy when symlink throws EPERM', async (t) => {
  const dir = await tempDir();
  try {
    const source = await stubFile(dir, '.claude/skills/pinsay-init/SKILL.md', 'src');
    const dest = join(dir, '.agents/skills/pinsay-init/SKILL.md');
    t.mock.method(fsp, 'symlink', async () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    const r = await linkOrCopy(dir, source, '.agents/skills/pinsay-init/SKILL.md');
    assert.equal(r.mode, 'copy');
    const st = await fsp.lstat(dest);
    assert.ok(st.isFile());
    assert.equal(await fsp.readFile(dest, 'utf8'), 'src');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('linkOrCopy stops when the destination is a folder', async () => {
  const dir = await tempDir();
  try {
    const source = await stubFile(dir, '.claude/skills/pinsay-init/SKILL.md', 'src');
    await fsp.mkdir(join(dir, '.agents/skills/pinsay-init/SKILL.md'), { recursive: true });
    await assert.rejects(
      () => linkOrCopy(dir, source, '.agents/skills/pinsay-init/SKILL.md'),
      (err: unknown) => {
        assert.ok(err instanceof RepoPathError);
        assert.equal(err.kind, 'directory-in-the-way');
        return true;
      },
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
