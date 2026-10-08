import { initCommand } from './commands/init.js';
import { doctorCommand } from './commands/doctor.js';
import { updateCommand } from './commands/update.js';
import { applyCommand } from './commands/apply.js';
import { listCommand, getCommand, statusCommand, replyCommand } from './commands/comments.js';
import { mcpCommand } from './commands/mcp.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { whoamiCommand } from './commands/whoami.js';
import { argv, cwd } from 'node:process';
import { BUILD_CLI_VERSION } from './build-constants.js';
import { reportFatal } from './errors.js';
import { resolveServer, serverSettingError } from './server.js';
import { setColorOverride } from './ui/style.js';

function parseArgs(args: string[]) {
    const parsed: Record<string, string | boolean> = {};
    const positionals: string[] = [];
    const booleanFlags = new Set([
        'no-app-url',
        'no-inject',
        'no-skills',
        'no-design',
        'source-map',
        'refresh-stack',
        'from-source',
        'pin',
        'yes',
        'json',
        'help',
        'fix',
        'check',
        'plan',
        'dry-run',
        'no-commit',
        'version',
        'local-credentials',
        'no-browser',
        // 0.9.0
        'embed',
        'global',
        'share-stack',
        'no-share-stack',
        'no-color',
        'all',
        'print'
    ]);

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            if (booleanFlags.has(key)) {
                parsed[key] = true;
            } else if (i + 1 < args.length && !args[i+1].startsWith('-')) {
                parsed[key] = args[i+1];
                i++;
            } else {
                parsed[key] = true;
            }
        } else if (arg.startsWith('-')) {
            const key = arg.slice(1);
            if (key === 'y') parsed['yes'] = true;
            if (key === 'h') parsed['help'] = true;
            if (key === 'v') parsed['version'] = true;
        } else {
            positionals.push(arg);
        }
    }
    return { parsed, positionals };
}

const HELP = `Usage: npx pinsay-cli <command> [options]

Set up
  init      Set up this repo (sign in, project, skills)
  embed     Put the widget in your app's code
  login     Sign in; the key is saved in this repo (--global: this machine)
  logout    Remove the key this repo uses
  remove    Remove everything PinSay added to this repo
Daily
  status    Who you are, this folder's project, comments waiting
  open      Open this project in the dashboard
  list      List feedback comments
  get       Show one comment
  apply     Turn pending feedback into an AI prompt; mark it applied
  reply     Reply to a comment
Tools
  doctor    Check this install and fix what it can
  update    Refresh the AI skills
  map       Rebuild the source map without a build
  mcp       Start the MCP server for AI tools
  whoami    Show the signed-in account and where the key came from

Run npx pinsay-cli <command> --help for examples.
Exit codes: 0 ok · 1 error · 2 bad usage / paused workspace · 3 key or permission · 4 can't reach PinSay · 5 CLI too old`;

/** One help row: the flag or example command, its description, and whether the flag is an old spelling. */
type HelpFlag = [flag: string, text: string, old?: boolean];

type HelpEntry = {
    purpose: string;
    usage: string;
    /** The flags shown by plain `--help` (at most 8). */
    common: [string, string][];
    /** Every flag the command accepts; `--help --all` shows this list, old flags suffixed `(old)`. */
    all: HelpFlag[];
    examples: [string, string][];
    /** Extra plain lines after the examples (exit codes). */
    notes?: string[];
};

const HELP_TEXTS: Record<string, HelpEntry> = {
    init: {
        purpose: 'Set up this repo (sign in, project, skills)',
        usage: 'npx pinsay-cli init [options]',
        common: [
            ['--project <key>', 'Use this project'],
            ['--embed', 'Put the widget in your code'],
            ['--key <key>', 'Sign in with this key instead of the browser'],
            ['--path <app>', 'The app folder, in a repo with several apps'],
            ['--no-browser', "Print the sign-in link; don't open a browser"],
            ['--no-skills', "Don't install the AI skills"],
            ['-y, --yes', 'No questions (CI)'],
            ['--json', 'Machine-readable output (implies --yes)'],
        ],
        all: [
            ['-y, --yes', 'No questions (CI)'],
            ['--json', 'Machine-readable output (implies --yes)'],
            ['--project <key>', 'Use this project'],
            ['--create <name>', 'Create a project with this name'],
            ['--environment <list>', 'Also activate these environments (comma-separated)'],
            ['--embed', 'Put the widget in your code'],
            ['--html <path>', 'The HTML file to inject the widget into'],
            ['--pin', 'Pin the widget to the build the server serves now'],
            ['--dry-run', 'Show the plan; write and send nothing'],
            ['--path <app>', 'The app folder, in a repo with several apps'],
            ['--key <key>', 'Sign in with this key instead of the browser'],
            ['--global', 'Save the key on this machine (repo is the default)'],
            ['--no-browser', "Print the sign-in link; don't open a browser"],
            ['--tool <tool>', 'AI tool for the skills (asked when omitted)'],
            ['--skills-dir <path>', 'Where the skills are installed'],
            ['--app-url <url>', 'The app URL recorded with the project'],
            ['--no-app-url', 'Skip the App URL question'],
            ['--source-map', 'Wire in the Vite plugin that stamps source hashes'],
            ['--no-skills', "Don't install the AI skills"],
            ['--no-design', "Don't detect design tokens"],
            ['--share-stack', "Let PinSay learn this app's stack (the default)"],
            ['--no-share-stack', "Share nothing about this app's stack"],
            ['--delivery <embed|extension>', 'How reviewers open the widget', true],
            ['--no-inject', 'Skip injection (use --embed or --html)', true],
            ['--scope <global|repo>', 'Where the key is saved (--global is the new spelling)', true],
            ['--local-credentials', 'Alias of --scope repo', true],
        ],
        examples: [
            ['npx pinsay-cli init', 'Set up this repo (asks a few questions)'],
            ['npx pinsay-cli init --project my-app --embed', 'Use project my-app and put the widget in your code'],
            ['npx pinsay-cli init --project my-app --yes', 'No questions (CI); add --no-share-stack to share nothing'],
        ],
    },
    embed: {
        purpose: "Put the widget in your app's code",
        usage: 'npx pinsay-cli embed [options]',
        common: [
            ['--html <file>', 'The HTML file to inject into (outranks detection)'],
            ['--path <app>', 'The app folder, in a repo with several apps'],
            ['--project <key>', 'The project key to embed'],
            ['--pin', 'Pin the widget to the build the server serves now'],
            ['--dry-run', 'Show the plan; write and send nothing'],
            ['-y, --yes', "Don't ask for confirmation"],
            ['--json', 'Machine-readable output'],
        ],
        all: [
            ['--html <file>', 'The HTML file to inject into (outranks detection)'],
            ['--path <app>', 'The app folder, in a repo with several apps'],
            ['--project <key>', 'The project key to embed'],
            ['--pin', 'Pin the widget to the build the server serves now'],
            ['--dry-run', 'Show the plan; write and send nothing'],
            ['-y, --yes', "Don't ask for confirmation"],
            ['--json', 'Machine-readable output'],
        ],
        examples: [
            ['npx pinsay-cli embed', "Add the widget with this repo's settings"],
            ['npx pinsay-cli embed --html index.html', 'Inject into index.html, not the detected file'],
            ['npx pinsay-cli embed --dry-run', 'Show the plan; write and send nothing'],
        ],
    },
    login: {
        purpose: 'Sign in; the key is saved in this repo (--global: this machine)',
        usage: 'npx pinsay-cli login [options]',
        common: [
            ['--key <key>', 'Validate a pasted key; skip the browser'],
            ['--global', 'Save the key on this machine, not this repo'],
            ['--no-browser', "Print the sign-in link; don't open a browser"],
            ['--json', 'Machine-readable output'],
        ],
        all: [
            ['--key <key>', 'Validate a pasted key; skip the browser'],
            ['--global', 'Save the key on this machine, not this repo'],
            ['--no-browser', "Print the sign-in link; don't open a browser"],
            ['--json', 'Machine-readable output'],
            ['--scope <global|repo>', 'Where to save the key, without asking', true],
            ['--local-credentials', 'Alias of --scope repo', true],
        ],
        examples: [
            ['npx pinsay-cli login', 'Open the browser; save the key in this repo'],
            ['npx pinsay-cli login --global', 'Save the key on this machine'],
            ['npx pinsay-cli login --key <key>', 'Save a pasted key; no browser'],
        ],
    },
    logout: {
        purpose: 'Remove the key this repo uses',
        usage: 'npx pinsay-cli logout [options]',
        common: [
            ['--global', "Remove this machine's saved key instead"],
            ['--json', 'Emit { ok, server, source, removed } as JSON'],
        ],
        all: [
            ['--global', "Remove this machine's saved key instead"],
            ['--json', 'Emit { ok, server, source, removed } as JSON'],
            ['--scope <global|repo>', 'Old spelling; only global changes anything', true],
        ],
        examples: [
            ['npx pinsay-cli logout', "Remove this repo's key"],
            ['npx pinsay-cli logout --global', "Also remove this machine's key"],
        ],
    },
    remove: {
        purpose: 'Remove everything PinSay added to this repo',
        usage: 'npx pinsay-cli remove [options]',
        common: [
            ['--dry-run', 'Show what would be removed; delete nothing'],
            ['-y, --yes', 'Remove without asking'],
            ['--global', "Also remove this machine's saved key"],
            ['--json', 'Machine-readable output'],
        ],
        all: [
            ['--dry-run', 'Show what would be removed; delete nothing'],
            ['-y, --yes', 'Remove without asking'],
            ['--global', "Also remove this machine's saved key"],
            ['--json', 'Machine-readable output'],
        ],
        examples: [
            ['npx pinsay-cli remove --dry-run', 'Show what would be removed'],
            ['npx pinsay-cli remove --yes', 'Remove without asking'],
            ['npx pinsay-cli remove --global', "Also remove this machine's key"],
        ],
    },
    status: {
        purpose: "Who you are, this folder's project, comments waiting",
        usage:
            'npx pinsay-cli status\n' +
            '       npx pinsay-cli status <id> <open|ready|applied|archived>\n' +
            '       npx pinsay-cli status --deployed [sha]',
        common: [
            ['--json', 'Overview as JSON'],
            ['--deployed [sha]', 'Mark applied comments live (default HEAD)'],
            ['--project <key>', 'Project for --deployed'],
            ['--key <key>', 'API key'],
        ],
        all: [
            ['--json', 'Overview as JSON'],
            ['--deployed [sha]', 'Mark applied comments live (default HEAD)'],
            ['--project <key>', 'Project for --deployed'],
            ['--key <key>', 'API key'],
        ],
        examples: [
            ['npx pinsay-cli status', "Who you are and what's waiting"],
            ['npx pinsay-cli status 42 ready', 'Mark comment 42 ready'],
            ['npx pinsay-cli status --deployed', "Mark this build's applied comments live"],
        ],
    },
    open: {
        purpose: 'Open this project in the dashboard',
        usage: 'npx pinsay-cli open [options]',
        common: [
            ['--project <key>', "Project to open (default: this folder's)"],
            ['--print', "Print the URL; don't open a browser"],
        ],
        all: [
            ['--project <key>', "Project to open (default: this folder's)"],
            ['--print', "Print the URL; don't open a browser"],
            ['-y, --yes', "Non-interactive; don't open a browser"],
        ],
        examples: [
            ['npx pinsay-cli open', "Open this project's dashboard"],
            ['npx pinsay-cli open --print', "Print the URL; don't open a browser"],
        ],
    },
    list: {
        purpose: 'List feedback comments',
        usage: 'npx pinsay-cli list [status] [environment]',
        common: [
            ['--status <status>', 'Filter (open, ready, applied, archived)'],
            ['--env <env>', 'Filter (local, staging, production)'],
            ['--project <key>', "Project (default: this folder's)"],
            ['--json', 'Comments as JSON'],
        ],
        all: [
            ['--status <status>', 'Filter (open, ready, applied, archived)'],
            ['--env <env>', 'Filter (local, staging, production)'],
            ['--project <key>', "Project (default: this folder's)"],
            ['--key <key>', 'API key'],
            ['--json', 'Comments as JSON'],
        ],
        examples: [
            ['npx pinsay-cli list', "Every project's comments"],
            ['npx pinsay-cli list open', 'Only open comments'],
            ['npx pinsay-cli list --json', 'Comments as JSON'],
        ],
    },
    get: {
        purpose: 'Show one comment',
        usage: 'npx pinsay-cli get <id>',
        common: [
            ['--json', 'Full view as JSON, with the resolved source'],
        ],
        all: [
            ['--id <id>', 'The comment id (same as the argument)'],
            ['--key <key>', 'API key'],
            ['--json', 'Full view as JSON, with the resolved source'],
        ],
        examples: [
            ['npx pinsay-cli get 42', 'Show comment 42'],
            ['npx pinsay-cli get 42 --json', 'The same view as JSON'],
        ],
    },
    apply: {
        purpose: 'Turn pending feedback into an AI prompt; mark it applied',
        usage: 'npx pinsay-cli apply [options]',
        common: [
            ['--tool <name>', 'claude, opencode, cursor, or clipboard'],
            ['--plan', 'List the files without edits'],
            ['--mark <id>|all', 'Commit and mark applied (needs --models)'],
            ['--reply <text>', 'Reply recorded with --mark'],
            ['--models <list>', '"<id>=<role>", mandatory with --mark'],
            ['--status <status>', 'Filter the queue (open, ready, applied, archived)'],
            ['--env <env>', 'Filter (local, staging, production)'],
            ['--json', 'Queue as JSON'],
        ],
        all: [
            ['--tool <name>', 'claude, opencode, cursor, or clipboard'],
            ['--plan', 'List the files without edits'],
            ['--mark <id>|all', 'Commit and mark applied (needs --models)'],
            ['--reply <text>', 'Reply recorded with --mark'],
            ['--models <list>', '"<id>=<role>", mandatory with --mark'],
            ['--model <id>', 'One model id, merged after --models'],
            ['--commit <sha>', 'With --no-commit: the commit with the fix'],
            ['--no-commit', 'Mark without committing'],
            ['--dry-run', 'Print what --mark would do; change nothing'],
            ['--fail <id>', 'Mark apply failed with a reply'],
            ['--reason <text>', 'Why it failed (required with --fail)'],
            ['--status <status>', 'Filter the queue (open, ready, applied, archived)'],
            ['--env <env>', 'Filter (local, staging, production)'],
            ['--key <key>', 'API key'],
            ['--project <key>', 'Project for the queue'],
            ['--json', 'Queue as JSON'],
        ],
        examples: [
            ['npx pinsay-cli apply', 'Print the AI apply prompt for pending feedback'],
            ['npx pinsay-cli apply --tool claude', 'Hand the prompt to claude'],
            ['npx pinsay-cli apply --mark 42 --models "<model>=implementer"', 'Commit and mark comment 42 applied'],
        ],
        notes: [
            'Exit codes: 0 ok · 1 error · 2 bad usage / paused workspace',
            "            3 key or permission · 4 can't reach PinSay · 5 CLI too old",
        ],
    },
    reply: {
        purpose: 'Reply to a comment',
        usage: 'npx pinsay-cli reply <id> "<text>"',
        common: [
            ['--key <key>', 'API key'],
        ],
        all: [
            ['--key <key>', 'API key'],
        ],
        examples: [
            ['npx pinsay-cli reply 42 "shipping in v2"', 'Reply to comment 42'],
            ['npx pinsay-cli reply 7 "duplicate of 42"', 'The reply shows under the comment'],
        ],
    },
    doctor: {
        purpose: 'Check this install and fix what it can',
        usage: 'npx pinsay-cli doctor [options]',
        common: [
            ['--project <key>', 'Override the project key'],
            ['--fix', 'Apply the idempotent repairs (gitignore, skills, stack)'],
            ['--refresh-stack', 'Refresh local design tokens without the server'],
            ['--json', 'Emit { ok, checks } as JSON'],
        ],
        all: [
            ['--project <key>', 'Override the project key'],
            ['--fix', 'Apply the idempotent repairs (gitignore, skills, stack)'],
            ['--refresh-stack', 'Refresh local design tokens without the server'],
            ['--json', 'Emit { ok, checks } as JSON'],
        ],
        examples: [
            ['npx pinsay-cli doctor', 'Check this install'],
            ['npx pinsay-cli doctor --fix', 'Also apply the safe repairs'],
        ],
        notes: [
            'Exit codes: 0 ok · 1 a check failed · 3 key or permission',
            "            4 can't reach PinSay · 5 CLI too old",
        ],
    },
    update: {
        purpose: 'Refresh the AI skills',
        usage: 'npx pinsay-cli update [options]',
        common: [
            ['--check', 'Report what is out of date; write nothing'],
        ],
        all: [
            ['--check', 'Report what is out of date; write nothing'],
        ],
        examples: [
            ['npx pinsay-cli update', 'Refresh the skills now'],
            ['npx pinsay-cli update --check', 'Only report what is out of date'],
        ],
    },
    map: {
        purpose: 'Rebuild the source map without a build',
        usage: 'npx pinsay-cli map --from-source',
        common: [
            ['--from-source', 'Required: walk the sources and rebuild the map'],
        ],
        all: [
            ['--from-source', 'Required: walk the sources and rebuild the map'],
        ],
        examples: [
            ['npx pinsay-cli map --from-source', "Fresh clone: the manifest isn't committed"],
            ['npx pinsay-cli map --from-source', 'After a rename: old hashes resolve again'],
        ],
    },
    mcp: {
        purpose: 'Start the MCP server for AI tools',
        usage: 'npx pinsay-cli mcp [options]',
        common: [
            ['--log <file>', 'Log MCP traffic to a file'],
            ['--project <key>', 'Project key'],
            ['--key <key>', 'API key'],
        ],
        all: [
            ['--log <file>', 'Log MCP traffic to a file'],
            ['--project <key>', 'Project key'],
            ['--key <key>', 'API key'],
        ],
        examples: [
            ['npx pinsay-cli mcp', 'Start the server on stdio'],
            ['npx pinsay-cli mcp --log mcp.log', 'Also log traffic to mcp.log'],
        ],
    },
    whoami: {
        purpose: 'Show the signed-in account and where the key came from',
        usage: 'npx pinsay-cli whoami [options]',
        common: [
            ['--json', 'Emit { ok, server, displayName, email, source } as JSON'],
        ],
        all: [
            ['--json', 'Emit { ok, server, displayName, email, source } as JSON'],
        ],
        examples: [
            ['npx pinsay-cli whoami', 'Show the signed-in account'],
            ['npx pinsay-cli whoami --json', 'The same facts as JSON'],
        ],
    },
};

const HELP_WIDTH = 80;

/** Wrap a description on whole words. Empty input yields no lines. */
function wrapWords(text: string, width: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(' ')) {
        if (line !== '' && line.length + 1 + word.length > width) {
            lines.push(line);
            line = word;
        } else {
            line = line === '' ? word : `${line} ${word}`;
        }
    }
    if (line !== '') lines.push(line);
    return lines;
}

/**
 * Two-column rows: the flag column sized to the longest entry (capped at `maxColumn`), long text
 * wrapped with a hanging indent, and a flag longer than the column gets its text below it.
 */
function renderRows(rows: { flag: string; text: string }[], maxColumn: number): string[] {
    const out: string[] = [];
    const longest = Math.max(...rows.map((r) => r.flag.length));
    const column = Math.min(maxColumn, longest) + 2;
    for (const { flag, text } of rows) {
        if (flag.length + 2 > column) {
            out.push(`  ${flag}`);
            for (const line of wrapWords(text, HELP_WIDTH - 6)) out.push(`      ${line}`);
        } else {
            const parts = wrapWords(text, HELP_WIDTH - 2 - column);
            out.push(`  ${flag.padEnd(column)}${parts[0] ?? ''}`);
            for (const line of parts.slice(1)) out.push(`  ${' '.repeat(column)}${line}`);
        }
    }
    return out;
}

function renderHelp(entry: HelpEntry, showAll: boolean): string {
    const lines: string[] = [entry.purpose, '', `Usage: ${entry.usage}`, '', 'Options:'];
    const rows = (showAll ? entry.all : entry.common).map(([flag, text, old]) => ({
        flag,
        text: old ? `${text} (old)` : text,
    }));
    rows.push({ flag: '-h, --help', text: 'Show help' });
    lines.push(...renderRows(rows, 24));
    lines.push('', 'Examples:');
    lines.push(...renderRows(entry.examples.map(([cmd, text]) => ({ flag: cmd, text })), 30));
    if (entry.notes) lines.push('', ...entry.notes);
    return lines.join('\n');
}

function exitHelp(command: string, parsed: Record<string, string | boolean>): never {
    console.log(renderHelp(HELP_TEXTS[command], parsed['all'] === true));
    process.exit(0);
}

async function main() {
    const { parsed, positionals } = parseArgs(argv.slice(2));
    const command = positionals[0];

    // Before anything prints: with --no-color even a forced colour environment stays plain.
    if (parsed['no-color']) setColorOverride(false);

    // Before any command dispatch: the server rejects a CLI older than its `minCliVersion`, and the
    // upgrade hint that rejection prints is useless if there is no way to read the version you have.
    if (parsed['version'] && !command) {
        console.log(BUILD_CLI_VERSION);
        process.exit(0);
    }

    if (parsed['help'] || command === '--help' || !command) {
        if (!command || command === '--help') {
            console.log(HELP);
            process.exit(0);
        }
    }
    
    // No server choice since 0.8.0 (see server.ts): a `--server` flag, or a `.pinsay/config.json`
    // naming another server, stops here before anything talks to a server. `map` never does.
    if (command !== 'map' && !parsed['help']) {
        const serverError = await serverSettingError(cwd(), parsed);
        if (serverError) {
            console.error(serverError);
            process.exit(2);
        }
    }

    if (command === 'init') {
        if (parsed['help']) exitHelp('init', parsed);
        await initCommand(cwd(), parsed);
    } else if (command === 'login') {
        if (parsed['help']) exitHelp('login', parsed);
        await loginCommand(cwd(), parsed);
    } else if (command === 'logout') {
        if (parsed['help']) exitHelp('logout', parsed);
        await logoutCommand(cwd(), parsed);
    } else if (command === 'whoami') {
        if (parsed['help']) exitHelp('whoami', parsed);
        await whoamiCommand(cwd(), parsed);
    } else if (command === 'doctor') {
        if (parsed['help']) exitHelp('doctor', parsed);
        const code = await doctorCommand(cwd(), {
            project: typeof parsed['project'] === 'string' ? parsed['project'] : undefined,
            json: parsed['json'] === true,
            fix: parsed['fix'] === true,
            refreshStack: parsed['refresh-stack'] === true,
        }, BUILD_CLI_VERSION);
        process.exit(code);
    } else if (command === 'update') {
        if (parsed['help']) exitHelp('update', parsed);
        const code = await updateCommand(cwd(), {
            check: parsed['check'] === true,
        });
        process.exit(code);
    } else if (command === 'apply') {
        if (parsed['help']) exitHelp('apply', parsed);
        await applyCommand(cwd(), parsed, positionals);
    } else if (command === 'list' || command === 'comments') {
        if (parsed['help']) exitHelp('list', parsed);
        await listCommand(cwd(), parsed, positionals);
    } else if (command === 'map') {
        if (parsed['help']) exitHelp('map', parsed);
        const { mapCommand } = await import('./commands/map.js');
        await mapCommand(cwd(), parsed);
    } else if (command === 'get') {
        if (parsed['help']) exitHelp('get', parsed);
        await getCommand(cwd(), parsed, positionals);
    } else if (command === 'status') {
        if (parsed['help']) exitHelp('status', parsed);
        if (positionals.length === 1 && parsed['deployed'] === undefined) {
            const { overviewCommand } = await import('./commands/overview.js');
            await overviewCommand(cwd(), parsed);
        } else if (parsed['deployed'] !== undefined) {
            const { deployedCommand } = await import('./commands/deployed.js');
            await deployedCommand(cwd(), parsed);
        } else {
            await statusCommand(cwd(), parsed, positionals);
        }
    } else if (command === 'reply') {
        if (parsed['help']) exitHelp('reply', parsed);
        await replyCommand(cwd(), parsed, positionals);
    } else if (command === 'mcp') {
        if (parsed['help']) exitHelp('mcp', parsed);
        await mcpCommand(cwd(), parsed);
    } else if (command === 'embed') {
        if (parsed['help']) exitHelp('embed', parsed);
        const { embedCommand } = await import('./commands/embed.js');
        await embedCommand(cwd(), parsed);
    } else if (command === 'open') {
        if (parsed['help']) exitHelp('open', parsed);
        const { openCommand } = await import('./commands/open.js');
        await openCommand(cwd(), parsed);
    } else if (command === 'remove') {
        if (parsed['help']) exitHelp('remove', parsed);
        const { removeCommand } = await import('./commands/remove.js');
        await removeCommand(cwd(), parsed);
    } else {
        console.error(`Unknown command: ${command}`);
        process.exit(2);
    }
}

main().catch((err) => {
    reportFatal(err, { json: argv.includes('--json'), server: resolveServer() });
});
