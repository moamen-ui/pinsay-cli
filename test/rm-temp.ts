import { rmSync } from 'node:fs';

/**
 * Removes a test's temp dir. On Windows a child process that was just closed (an MCP server spawned with
 * this dir as its cwd) can keep the folder locked for a while after close() returns, so the delete is
 * retried, and if Windows still reports it busy the folder is left for the OS temp cleanup instead of
 * failing a test whose assertions all passed. Any other error, or any error on macOS/Linux, still throws.
 */
export function rmTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (err: any) {
    if (process.platform === 'win32' && (err?.code === 'EBUSY' || err?.code === 'EPERM')) {
      console.error(`# left temp dir ${dir} (Windows: still in use by a closed child process)`);
      return;
    }
    throw err;
  }
}
