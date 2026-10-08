import * as readline from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { answeredLine, colorEnabled, cyan, dim, questionLine, red, sym } from './ui/style.js';

/** Written (with a leading and trailing newline) before exit 130 whenever a prompt is abandoned. */
export const CANCELLED_MESSAGE = 'Cancelled. Nothing was written.';

/** Ctrl-C or Ctrl-D at any prompt: give the terminal back, say nothing was written, exit 130. */
function cancelExit(wasRaw = false): never {
    if (process.stdin.setRawMode) process.stdin.setRawMode(wasRaw);
    process.stdout.write(`\n${CANCELLED_MESSAGE}\n`);
    process.exit(130);
}

/**
 * Refuses to prompt when there is no terminal to prompt on.
 *
 * Without this the failure is silent and looks like success: `rl.question()` never resolves on
 * EOF, so the event loop drains and node exits 0 having written nothing. A user running `init`
 * from CI, a pipe, or an editor-embedded shell sees the first prompt, gets their shell back, and
 * has no way to tell that nothing happened — the exit code says it worked.
 */
function assertInteractive(): void {
    if (process.stdin.isTTY) return;
    console.error(
        red('This command is interactive, but stdin is not a terminal.') + '\n' +
        'Piped input, CI, and some editor-embedded shells have no TTY, so there is no way to ask you anything.\n\n' +
        'Either run it in a real terminal, or pass every answer as a flag:\n' +
        '  npx -y pinsay-cli init --key ptr_... --project <key> --yes\n\n' +
        "Run 'npx -y pinsay-cli init --help' for the full list of flags."
    );
    process.exit(2);
}

let shared: readline.Interface | null = null;
let plain: readline.Interface | null = null;

/**
 * ONE terminal-mode interface for the whole process, not one per question.
 *
 * Creating and closing an interface per prompt leaves stdin in a state where the next interface
 * swallows the first keypress — which is why every second prompt appeared to need two Enters.
 */
function iface(): readline.Interface {
    if (!shared) {
        shared = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
        });
        // Ctrl-C during a prompt should end the program, not fall through as an empty answer and
        // let init continue with defaults the user never chose.
        shared.on('SIGINT', () => cancelExit());
    }
    return shared;
}

/**
 * The colour-off interface. `terminal: false` keeps readline from writing any escape codes of its
 * own, so a no-colour run stays byte-for-byte escape-free.
 *
 * A fresh interface per question: bytes typed during a raw-mode step (confirm, hidden input) land
 * in the old interface's line buffer, and a reused interface would hand them over as the next
 * answer.
 */
function plainIface(): readline.Interface {
    plain?.close();
    plain = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
    });
    // Same behaviour as the shared interface if SIGINT is ever emitted on it.
    plain.on('SIGINT', () => cancelExit());
    return plain;
}

/** Releases stdin so the process can exit once prompting is done. */
export function closePrompts(): void {
    shared?.close();
    shared = null;
    plain?.close();
    plain = null;
}

export async function ask(
    question: string,
    options: { default?: string; validate?: (val: string) => string | undefined; secret?: boolean } = {},
): Promise<string> {
    assertInteractive();
    while (true) {
        console.log(questionLine(question + (options.default ? ` [${options.default}]` : '')));
        let answer: string;
        if (options.secret) {
            // Hidden input never goes through readline: readline echoes what it edits, so a raw
            // key reader is the only way to collect an answer without showing it.
            answer = await readSecret();
        } else {
            const rl = colorEnabled() ? iface() : plainIface();
            // The prompt goes THROUGH readline, never straight to stdout.
            //
            // Writing it with process.stdout.write and then calling rl.question('') looks
            // equivalent and is not: with terminal:true readline redraws its own (empty) prompt on
            // the same line, emitting `\x1b[1G\x1b[0J` — column 1, erase to end — which wipes the
            // question. The user sees a blank line, assumes it has hung, and hits Enter again.
            try {
                answer = await rl.question('  ' + sym.pointer + ' ');
            } catch (err: any) {
                // Ctrl-D (or stdin closing under us) rejects with an AbortError. Unhandled, node
                // prints its own stack trace — which looks like a crash in PinSay rather than the
                // deliberate "I'm done here" the user just typed.
                if (err?.code === 'ABORT_ERR') cancelExit();
                throw err;
            }
        }

        const finalAnswer = answer.trim() || options.default || '';

        if (options.validate) {
            const error = options.validate(finalAnswer);
            if (error) {
                console.log(red(error));
                continue;
            }
        }

        if (colorEnabled()) {
            // Collapse the band and the input line (or, for hidden input, just the band) into the
            // answered log line, so the history reads like a log.
            process.stdout.write(`\x1b[${options.secret ? 1 : 2}A\x1b[0J`);
        }
        console.log(answeredLine(question, options.secret ? '(hidden)' : finalAnswer));
        return finalAnswer;
    }
}

/**
 * Raw key reader for hidden input. Echoes nothing; Backspace edits; Enter finishes; Ctrl-C/Ctrl-D
 * cancel. Raw mode is restored on every way out.
 */
async function readSecret(): Promise<string> {
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw ?? false;
    // Every other keypress reader — above all the shared readline's line editor — must step aside
    // while the secret is typed: it would echo each character to stdout and leave it sitting in
    // the line buffer, so the next prompt would start with the password in it.
    const existingKeypress = process.stdin.listeners('keypress') as ((...args: unknown[]) => void)[];
    existingKeypress.forEach((fn) => process.stdin.removeListener('keypress', fn));
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    try {
        return await new Promise<string>((resolve) => {
            const onKey = (_str: string, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }) => {
                if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
                    cancelExit(wasRaw);
                } else if (key.name === 'return' || key.name === 'enter') {
                    cleanup();
                    resolve(value);
                } else if (key.name === 'backspace' || key.name === 'delete') {
                    value = value.slice(0, -1);
                } else if (!key.ctrl && !key.meta && key.sequence !== undefined && key.sequence.length === 1) {
                    value += key.sequence;
                }
            };
            const cleanup = () => process.stdin.off('keypress', onKey);
            process.stdin.on('keypress', onKey);
        });
    } finally {
        if (process.stdin.setRawMode) process.stdin.setRawMode(wasRaw);
        if (shared) {
            // Characters typed in raw mode may have reached the line editor before it was
            // detached; drop them so they never surface as the next answer.
            (shared as any).line = '';
            (shared as any).cursor = 0;
        }
        existingKeypress.forEach((fn) => process.stdin.on('keypress', fn));
    }
}

type MenuOptions = {
    /** Pre-ticked entries, for multi-select. */
    selected?: Set<number>;
    multi?: boolean;
};

/**
 * Shared menu behind both `select` and `multiSelect`.
 *
 * With colour: the question sits on a band, an arrow-key menu runs in raw mode, and confirming
 * collapses everything back into `✔ question · answer`. Without colour: a numbered list plus a
 * typed answer through the non-terminal readline — no raw mode, no escape codes anywhere.
 *
 * Raw mode is entered only for the duration of the menu and always restored, including on the
 * error path — leaving a terminal in raw mode is how a CLI ruins the shell it was run from.
 */
async function menu(question: string, items: string[], cursorStart: number, opts: MenuOptions): Promise<number[]> {
    assertInteractive();
    const multi = opts.multi ?? false;
    const selected = opts.selected ?? new Set<number>();
    let cursor = Math.max(0, Math.min(cursorStart, items.length - 1));

    if (!colorEnabled()) {
        return plainMenu(question, items, cursor, selected, multi);
    }

    const rl = iface();
    const hint = dim('  ' + (multi
        ? `${sym.up}/${sym.down} move ${sym.dot} space toggle ${sym.dot} a all ${sym.dot} enter confirm`
        : `${sym.up}/${sym.down} move ${sym.dot} enter select`));

    const render = (first: boolean) => {
        if (!first) process.stdout.write(`\x1b[${items.length + 1}A`);
        process.stdout.write('\x1b[0J');
        process.stdout.write(`${hint}\n`);
        items.forEach((item, i) => {
            const pointer = i === cursor ? cyan(sym.pointer) : ' ';
            const box = multi ? (selected.has(i) ? `${cyan(sym.boxOn)} ` : `${sym.boxOff} `) : '';
            const label = i === cursor ? cyan(item) : item;
            process.stdout.write(`${pointer} ${box}${label}\n`);
        });
    };

    console.log(questionLine(question));
    // readline is holding stdin for line editing; it must let go while we read raw keys.
    rl.pause();
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw ?? false;
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    render(true);

    try {
        return await new Promise<number[]>((resolve) => {
            const onKey = (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
                if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
                    cancelExit(wasRaw);
                }
                if (key.name === 'up' || key.name === 'k') {
                    cursor = (cursor - 1 + items.length) % items.length;
                    render(false);
                } else if (key.name === 'down' || key.name === 'j') {
                    cursor = (cursor + 1) % items.length;
                    render(false);
                } else if (multi && (key.name === 'space' || key.sequence === ' ')) {
                    selected.has(cursor) ? selected.delete(cursor) : selected.add(cursor);
                    render(false);
                } else if (multi && key.name === 'a') {
                    // Toggle-all rather than select-all: pressing it twice undoes it, which is what
                    // someone who hit it by accident expects.
                    if (selected.size === items.length) selected.clear();
                    else items.forEach((_, i) => selected.add(i));
                    render(false);
                } else if (key.name === 'return' || key.name === 'enter') {
                    if (multi && selected.size === 0) {
                        // Enter on an empty multi-select takes the row under the cursor, so the
                        // answer is never silently empty.
                        selected.add(cursor);
                    }
                    cleanup();
                    const chosen = multi ? [...selected].sort((a, b) => a - b) : [cursor];
                    // Back up to the question band (hint + items sit between) and collapse the
                    // whole block into the answered log line.
                    process.stdout.write(`\x1b[${items.length + 2}A\x1b[0J`);
                    console.log(answeredLine(question, chosen.map((i) => items[i]).join(', ')));
                    resolve(chosen);
                }
            };

            const cleanup = () => {
                process.stdin.off('keypress', onKey);
                if (process.stdin.setRawMode) process.stdin.setRawMode(wasRaw);
            };

            process.stdin.on('keypress', onKey);
        });
    } finally {
        if (process.stdin.setRawMode) process.stdin.setRawMode(wasRaw);
        rl.resume();
    }
}

/**
 * The colour-off menu: the question, one `  <n>) <item>` line per entry (multi ticks prefixed from
 * the defaults), then a typed answer. Empty input takes the default; anything but valid numbers
 * re-asks.
 */
async function plainMenu(
    question: string,
    items: string[],
    cursorStart: number,
    selected: Set<number>,
    multi: boolean,
): Promise<number[]> {
    const rl = plainIface();
    console.log(questionLine(question));
    items.forEach((item, i) => {
        const box = multi ? `${selected.has(i) ? sym.boxOn : sym.boxOff} ` : '';
        console.log(`  ${i + 1}) ${box}${item}`);
    });

    const defaults = multi
        ? (selected.size > 0 ? [...selected].sort((a, b) => a - b).map((i) => i + 1) : [1])
        : [cursorStart + 1];
    const prompt = multi
        ? `Choose numbers, comma-separated [${defaults.join(',')}]: `
        : `Choose 1-${items.length} [${defaults[0]}]: `;

    const finish = (indices: number[]): number[] => {
        console.log(answeredLine(question, indices.map((i) => items[i]).join(', ')));
        return indices;
    };

    while (true) {
        let raw: string;
        try {
            raw = (await rl.question(prompt)).trim();
        } catch (err: any) {
            // EOF (Ctrl-D) rejects the pending question; cancel beats a stack trace.
            if (err?.code === 'ABORT_ERR') cancelExit();
            throw err;
        }
        if (raw === '') return finish([...new Set(defaults.map((n) => n - 1))]);
        const nums = raw.split(',').map((part) => Number(part.trim()));
        const valid = nums.every((n) => Number.isInteger(n) && n >= 1 && n <= items.length) && (multi || nums.length === 1);
        if (!valid) {
            console.log(red(`Type a number from 1 to ${items.length}.`));
            continue;
        }
        return finish([...new Set(nums.map((n) => n - 1))].sort((a, b) => a - b));
    }
}

export async function select(question: string, items: string[], defaultItem?: string): Promise<string> {
    const start = defaultItem ? Math.max(0, items.indexOf(defaultItem)) : 0;
    const [chosen] = await menu(question, items, start, {});
    return items[chosen];
}

/**
 * Multi-select. Returns at least one item — see the Enter handling in `menu`.
 */
export async function multiSelect(question: string, items: string[], defaults: string[] = []): Promise<string[]> {
    const selected = new Set<number>();
    defaults.forEach((d) => {
        const i = items.indexOf(d);
        if (i >= 0) selected.add(i);
    });
    const start = selected.size ? Math.min(...selected) : 0;
    const chosen = await menu(question, items, start, { selected, multi: true });
    return chosen.map((i) => items[i]);
}

/**
 * One-keypress yes/no question (Enter = the default). `details` prints as dim lines under the
 * question; `answerLabel` names the answered line when it should differ from the question.
 */
export async function confirm(
    question: string,
    options: { defaultYes?: boolean; details?: string[]; answerLabel?: string } = {},
): Promise<boolean> {
    assertInteractive();
    const defaultYes = options.defaultYes ?? true;
    const details = options.details ?? [];
    console.log(questionLine(question + '  ' + (defaultYes ? '(Y/n)' : '(y/N)')));
    details.forEach((line) => console.log(dim('   ' + line)));
    console.log(dim('   ' + (defaultYes
        ? `Enter = Yes ${sym.dot} n = No`
        : `Enter = No ${sym.dot} y = Yes`)));

    // readline is holding stdin for line editing; it must let go while we read raw keys — and
    // stepping aside entirely is not enough, so its keypress editor is detached for the duration:
    // left attached it echoes the pressed key to stdout and leaves it in the line buffer.
    shared?.pause();
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw ?? false;
    const existingKeypress = process.stdin.listeners('keypress') as ((...args: unknown[]) => void)[];
    existingKeypress.forEach((fn) => process.stdin.removeListener('keypress', fn));
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();

    let answer: boolean;
    try {
        answer = await new Promise<boolean>((resolve) => {
            const onKey = (_str: string, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }) => {
                if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
                    cancelExit(wasRaw);
                } else if (!key.ctrl && !key.meta && (key.name === 'return' || key.name === 'enter')) {
                    cleanup();
                    resolve(defaultYes);
                } else if (!key.ctrl && !key.meta && (key.name?.toLowerCase() === 'y' || key.sequence?.toLowerCase() === 'y')) {
                    cleanup();
                    resolve(true);
                } else if (!key.ctrl && !key.meta && (key.name?.toLowerCase() === 'n' || key.sequence?.toLowerCase() === 'n')) {
                    cleanup();
                    resolve(false);
                }
                // Any other key: ignored.
            };

            const cleanup = () => {
                process.stdin.off('keypress', onKey);
                if (process.stdin.setRawMode) process.stdin.setRawMode(wasRaw);
            };

            process.stdin.on('keypress', onKey);
        });
    } finally {
        if (process.stdin.setRawMode) process.stdin.setRawMode(wasRaw);
        if (shared) {
            // The pressed key must not survive in the line editor as the next answer.
            (shared as any).line = '';
            (shared as any).cursor = 0;
        }
        existingKeypress.forEach((fn) => process.stdin.on('keypress', fn));
        shared?.resume();
    }

    if (colorEnabled()) {
        // Collapse the band, the details and the hint into the answered log line.
        process.stdout.write(`\x1b[${2 + details.length}A\x1b[0J`);
    }
    console.log(answeredLine(options.answerLabel ?? question, answer ? 'Yes' : 'No'));
    return answer;
}
