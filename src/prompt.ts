import * as readline from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { Writable } from 'node:stream';

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
        '\x1b[31mThis command is interactive, but stdin is not a terminal.\x1b[0m\n' +
        'Piped input, CI, and some editor-embedded shells have no TTY, so there is no way to ask you anything.\n\n' +
        'Either run it in a real terminal, or pass every answer as a flag:\n' +
        '  npx -y pinsay init --server <url> --key ptr_... --project <key> --environment local --yes\n\n' +
        "Run 'npx -y pinsay init --help' for the full list of flags."
    );
    process.exit(2);
}

let muted = false;

/**
 * Output that can be silenced mid-question, for hidden input.
 *
 * It wraps stdout rather than replacing it so that readline still controls the line — see `ask`
 * for why that matters.
 */
const gatedStdout = new Writable({
    write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding as BufferEncoding);
        callback();
    },
});

let shared: readline.Interface | null = null;

/**
 * ONE interface for the whole process, not one per question.
 *
 * Creating and closing an interface per prompt leaves stdin in a state where the next interface
 * swallows the first keypress — which is why every second prompt appeared to need two Enters.
 */
function iface(): readline.Interface {
    if (!shared) {
        shared = readline.createInterface({
            input: process.stdin,
            output: gatedStdout,
            terminal: true,
        });
        // Ctrl-C during a prompt should end the program, not fall through as an empty answer and
        // let init continue with defaults the user never chose.
        shared.on('SIGINT', () => {
            process.stdout.write('\n');
            process.exit(130);
        });
    }
    return shared;
}

/** Releases stdin so the process can exit once prompting is done. */
export function closePrompts(): void {
    shared?.close();
    shared = null;
}

export async function ask(
    question: string,
    options: { default?: string; validate?: (val: string) => string | undefined; secret?: boolean } = {},
): Promise<string> {
    assertInteractive();
    const rl = iface();
    const displayQuestion = options.default ? `${question} [${options.default}]: ` : `${question}: `;

    while (true) {
        // The prompt goes THROUGH readline, never straight to stdout.
        //
        // Writing it with process.stdout.write and then calling rl.question('') looks equivalent
        // and is not: with terminal:true readline redraws its own (empty) prompt on the same line,
        // emitting `\x1b[1G\x1b[0J` — column 1, erase to end — which wipes the question. The user
        // sees a blank line, assumes it has hung, and hits Enter again.
        const pending = rl.question(displayQuestion);
        // rl.question writes the prompt synchronously before returning, so muting here hides the
        // typed characters without hiding the question itself.
        if (options.secret) muted = true;
        let answer: string;
        try {
            answer = await pending;
        } catch (err: any) {
            // Ctrl-D (or stdin closing under us) rejects with an AbortError. Unhandled, node prints
            // its own stack trace — which looks like a crash in PinSay rather than the deliberate
            // "I'm done here" the user just typed.
            muted = false;
            if (err?.code === 'ABORT_ERR') {
                process.stdout.write('\nCancelled — nothing was written.\n');
                process.exit(130);
            }
            throw err;
        }
        muted = false;
        if (options.secret) process.stdout.write('\n');

        const finalAnswer = answer.trim() || options.default || '';

        if (options.validate) {
            const error = options.validate(finalAnswer);
            if (error) {
                console.log(`\x1b[31m${error}\x1b[0m`);
                continue;
            }
        }
        return finalAnswer;
    }
}

type MenuOptions = {
    /** Pre-ticked entries, for multi-select. */
    selected?: Set<number>;
    multi?: boolean;
    hint?: string;
};

/**
 * Shared arrow-key menu behind both `select` and `multiSelect`.
 *
 * Raw mode is entered only for the duration of the menu and always restored, including on the
 * error path — leaving a terminal in raw mode is how a CLI ruins the shell it was run from.
 */
async function menu(question: string, items: string[], cursorStart: number, opts: MenuOptions): Promise<number[]> {
    assertInteractive();
    const rl = iface();
    const selected = opts.selected ?? new Set<number>();
    let cursor = Math.max(0, Math.min(cursorStart, items.length - 1));

    const hint =
        opts.hint ??
        (opts.multi
            ? '\x1b[2m  ↑/↓ move · space toggle · a all · enter confirm\x1b[0m'
            : '\x1b[2m  ↑/↓ move · enter select\x1b[0m');

    const render = (first: boolean) => {
        if (!first) process.stdout.write(`\x1b[${items.length + 1}A`);
        process.stdout.write('\x1b[0J');
        process.stdout.write(`${hint}\n`);
        items.forEach((item, i) => {
            const pointer = i === cursor ? '\x1b[36m❯\x1b[0m' : ' ';
            const box = opts.multi ? (selected.has(i) ? '\x1b[36m[x]\x1b[0m ' : '[ ] ') : '';
            const label = i === cursor ? `\x1b[36m${item}\x1b[0m` : item;
            process.stdout.write(`${pointer} ${box}${label}\n`);
        });
    };

    console.log(question);
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
                if (key.ctrl && key.name === 'c') {
                    cleanup();
                    process.stdout.write('\n');
                    process.exit(130);
                }
                if (key.name === 'up' || key.name === 'k') {
                    cursor = (cursor - 1 + items.length) % items.length;
                    render(false);
                } else if (key.name === 'down' || key.name === 'j') {
                    cursor = (cursor + 1) % items.length;
                    render(false);
                } else if (opts.multi && (key.name === 'space' || key.sequence === ' ')) {
                    selected.has(cursor) ? selected.delete(cursor) : selected.add(cursor);
                    render(false);
                } else if (opts.multi && key.name === 'a') {
                    // Toggle-all rather than select-all: pressing it twice undoes it, which is what
                    // someone who hit it by accident expects.
                    if (selected.size === items.length) selected.clear();
                    else items.forEach((_, i) => selected.add(i));
                    render(false);
                } else if (key.name === 'return' || key.name === 'enter') {
                    if (opts.multi && selected.size === 0) {
                        // Enter on an empty multi-select takes the row under the cursor, so the
                        // answer is never silently empty.
                        selected.add(cursor);
                    }
                    cleanup();
                    resolve(opts.multi ? [...selected].sort((a, b) => a - b) : [cursor]);
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
