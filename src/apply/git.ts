import { spawnSync } from 'node:child_process';

/**
 * Git integration for apply flow.
 *
 * SECURITY INVARIANT:
 * This module strictly NEVER exposes or spawns any remote upload commands.
 * All operations are strictly local to the repository index, commit history,
 * and remote configuration inspection.
 */

export function isStaged(cwd?: string): boolean {
  const result = spawnSync('git', ['diff', '--cached', '--quiet'], {
    cwd,
    encoding: 'utf8',
  });
  // git diff --cached --quiet exits 0 if nothing staged, 1 if changes are staged
  return result.status !== 0;
}

export function commitOne(
  files: string[],
  msg: string,
  cwd?: string,
): { success: boolean; error?: string } {
  const args = files.length > 0 ? ['commit', '-m', msg, '--', ...files] : ['commit', '-m', msg];
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return { success: false, error: result.stderr || result.stdout };
  }
  return { success: true };
}

export function commitAll(
  msg: string,
  cwd?: string,
): { success: boolean; error?: string } {
  const result = spawnSync('git', ['commit', '-m', msg], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return { success: false, error: result.stderr || result.stdout };
  }
  return { success: true };
}

export function headSha(cwd?: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to resolve HEAD sha: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export function getRemoteUrl(cwd?: string, remote = 'origin'): string | null {
  const result = spawnSync('git', ['remote', 'get-url', remote], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

export function getUserEmail(cwd?: string): string {
  const result = spawnSync('git', ['config', 'user.email'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return 'ai-agent';
}

/**
 * Normalises a remote URL and generates a commit link for recognized hosting providers.
 * Supported providers: GitHub, GitLab, Bitbucket.
 * Unknown hosts or local file paths return null (widget displays '#').
 */
export function commitUrlFor(sha: string, remoteUrl: string | null): string | null {
  if (!remoteUrl || !sha) return null;

  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  // Normalise SSH and HTTPS remote forms:
  // e.g. git@github.com:owner/repo.git -> https://github.com/owner/repo
  // ssh://git@github.com/owner/repo.git -> https://github.com/owner/repo
  let hostPath = trimmed
    .replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');

  if (hostPath.includes('github.com')) {
    return `${hostPath}/commit/${sha}`;
  }
  if (hostPath.includes('gitlab.com')) {
    return `${hostPath}/-/commit/${sha}`;
  }
  if (hostPath.includes('bitbucket.org')) {
    return `${hostPath}/commits/${sha}`;
  }

  return null;
}
