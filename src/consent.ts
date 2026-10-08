import { findRepoRoot, readConfig } from './config.js';

/** Whether this repo lets the CLI send its stack and usage events. Only an explicit `shareStack: false` says no. */
export async function shareAllowed(cwd: string): Promise<boolean> {
  try {
    const root = await findRepoRoot(cwd);
    return (await readConfig(root)).shareStack !== false;
  } catch {
    return true;
  }
}

/** `--share-stack` → true, `--no-share-stack` → false, neither → undefined; both → an error message. */
export function shareFromFlags(options: Record<string, string | boolean>): { share?: boolean; error?: string } {
  const yes = options['share-stack'] === true;
  const no = options['no-share-stack'] === true;
  if (yes && no) return { error: 'Pass only one of --share-stack and --no-share-stack.' };
  if (yes) return { share: true };
  if (no) return { share: false };
  return {};
}
