/**
 * SPEC "Interactive": stdin and stdout are TTYs, no --yes/-y, no --json, and CI unset or empty.
 * Anything else is non-interactive: never prompt, use flags and defaults.
 */
export function isInteractive(options: Record<string, string | boolean> = {}): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (options['yes'] || options['json']) return false;
  return (process.env.CI ?? '').trim() === '';
}
