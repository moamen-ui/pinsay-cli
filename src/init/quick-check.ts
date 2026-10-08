import type { CheckResult } from '../checks.js';
import { dim, green, red, sym, yellow } from '../ui/style.js';

/**
 * The end-of-init quick check (SPEC B7): the checks ran silently, and only problems are printed — each warning or
 * error as one line plus its fix, everything passing collapsed into a single line.
 */

export function quickCheckLines(checks: CheckResult[]): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    if (check.status === 'ok') continue;
    lines.push(
      check.status === 'warn' ? `${yellow(sym.warn)} ${check.message}` : `${red(sym.cross)} ${check.message}`,
    );
    if (check.hint) lines.push(dim(`  Fix: ${check.hint}`));
  }
  if (lines.length === 0) return [`${green(sym.check)} Everything checks out.`];
  return lines;
}
