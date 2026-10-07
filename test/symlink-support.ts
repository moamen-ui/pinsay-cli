import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Whether this machine can create symlinks (Windows needs Developer Mode or admin). Probed once. */
export const canSymlink: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'pinsay-symlink-probe-'));
  try {
    symlinkSync('target', join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

export const NO_SYMLINK = 'this machine cannot create symlinks (Windows without Developer Mode or admin)';
