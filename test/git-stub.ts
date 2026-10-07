import { execFileSync } from 'node:child_process';

/**
 * Makes `dir` a Git repo whose index tracks `linkPath` as a symlink to `target` (mode 120000), then has Git
 * itself check it out with core.symlinks=false — exactly what Git for Windows does without symlink
 * support: a plain text file whose content is the link target.
 */
export function gitSymlinkStub(dir: string, linkPath: string, target: string): void {
  const git = (args: string[], input?: string) =>
    execFileSync('git', args, { cwd: dir, input, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  const sha = git(['hash-object', '-w', '--stdin'], target);
  git(['update-index', '--add', '--cacheinfo', `120000,${sha},${linkPath}`]);
  git(['-c', 'core.symlinks=false', 'checkout-index', '-f', '--', linkPath]);
}
