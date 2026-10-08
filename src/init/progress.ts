import { colorEnabled, sym } from '../ui/style.js';

/** The one progress line that rewrites itself on a TTY (SPEC B6); plain lines when piped, nothing under `--json`. */

export type ProgressMode = 'tty' | 'lines' | 'silent';

export function progressMode(json: boolean): ProgressMode {
  if (json) return 'silent';
  return colorEnabled() && process.stdout.isTTY ? 'tty' : 'lines';
}

export function createProgress(
  total: number,
  mode: ProgressMode,
  write: (s: string) => void = (s) => process.stdout.write(s),
): { step(label: string): void; done(): void } {
  let n = 0;
  return {
    step(label: string): void {
      n += 1;
      if (mode === 'silent') return;
      const text = `[${n}/${total}] ${label}${sym.ellipsis}`;
      if (mode === 'tty') write(`\r\x1b[2K${text}`);
      else write(`${text}\n`);
    },
    done(): void {
      if (mode === 'tty') write('\r\x1b[2K');
    },
  };
}
