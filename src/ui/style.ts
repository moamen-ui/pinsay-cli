/**
 * Terminal styling for every command. Colour uses the terminal's own 16-colour palette (never fixed RGB), so a
 * light and a dark theme each render a readable pair. `colorEnabled()` is the one switch: when it is false
 * every helper returns its input unchanged, so the output contains no ESC byte.
 */
let override: boolean | undefined;

/** `--no-color` sets this to false before any command runs (cli.ts). `undefined` = decide from the environment. */
export function setColorOverride(value: boolean | undefined): void {
  override = value;
}

export function colorEnabled(): boolean {
  if (override === false) return false;
  if ((process.env.NO_COLOR ?? '') !== '') return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  if ((process.env.CI ?? '').trim() !== '') return false;
  return Boolean(process.stdout.isTTY);
}

/** False on Windows consoles that cannot draw ✔ ❯ ⚠ (cmd.exe / PowerShell 5.1 outside Windows Terminal). */
export function unicodeEnabled(): boolean {
  if (process.platform !== 'win32') return true;
  const env = process.env;
  return Boolean(
    env.WT_SESSION ||
      env.TERM_PROGRAM === 'vscode' ||
      env.ConEmuTask ||
      env.TERMINUS_SUBLIME ||
      env.TERM === 'xterm-256color' ||
      env.TERM === 'alacritty',
  );
}

const U = { check: '✔', cross: '✘', warn: '⚠', question: '?', pointer: '❯', boxOn: '[x]', boxOff: '[ ]', arrow: '→', dot: '·', plus: '＋', ellipsis: '…', up: '↑', down: '↓' };
const A = { check: 'OK', cross: 'x', warn: '!', question: '?', pointer: '>', boxOn: '[x]', boxOff: '[ ]', arrow: '->', dot: '-', plus: '+', ellipsis: '...', up: 'up', down: 'down' };
export type SymbolName = keyof typeof U;

/** Glyphs, resolved on every read so a test can flip the platform/env between calls. */
export const sym: Record<SymbolName, string> = new Proxy({} as Record<SymbolName, string>, {
  get: (_t, name: string) => (unicodeEnabled() ? U : A)[name as SymbolName],
});

const wrap = (open: string) => (s: string): string => (colorEnabled() ? `\x1b[${open}m${s}\x1b[0m` : s);
export const dim = wrap('2');
export const bold = wrap('1');
export const green = wrap('32');
export const red = wrap('31');
export const yellow = wrap('33');
/** The accent for the plan heading and the `Next` line: bold in the terminal's own foreground (readable on every theme, QA N14). */
export const accent = wrap('1');

/** Bold bright-white text on a blue band, one space of padding each side. Plain text when colour is off. */
export function band(text: string): string {
  return colorEnabled() ? `\x1b[1;97;44m ${text} \x1b[0m` : text;
}

/** The active question line. Colour: `[ ? question ]` on the band. Plain: `? question`. */
export function questionLine(question: string): string {
  return colorEnabled() ? band(`${sym.question} ${question}`) : `? ${question}`;
}

/** The line a question collapses to once answered: `✔ question · answer`. */
export function answeredLine(question: string, answer: string): string {
  return `${green(sym.check)} ${question} ${sym.dot} ${dim(answer)}`;
}
