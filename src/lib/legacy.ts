import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const PINSAY_SH_NOTE = '.pinsay/pinsay.sh is no longer used. Delete it any time, or run npx pinsay-cli remove.';

/** The one-line note for an old install's script, or null when there is none. Never touches the file. */
export function pinsayShNote(root: string): string | null {
  return existsSync(join(root, '.pinsay', 'pinsay.sh')) ? PINSAY_SH_NOTE : null;
}
