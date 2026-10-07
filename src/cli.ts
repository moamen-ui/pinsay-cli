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
import { ApiError } from './api.js';
import { serverSettingError } from './server.js';

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
        'no-browser'
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

const HELP = `
Usage: npx pinsay-cli <command> [options]

Commands:
  init      Set up the feedback widget in your project
  login     Sign in and save your API key (this machine, or this repo only)
  logout    Remove this machine's saved key
  whoami    Show the signed-in account and where the API key came from
  doctor    Diagnose an install and report what is wrong
  update    Refresh the served skills to the server's current version
  apply     Turn pending feedback into an AI apply prompt and mark applied
  list      List feedback comments (summary view)
  get       View comment details (whitelisted projection)
  map       Rebuild .pinsay/manifest.json from source, without a build
  status    Update comment status
  reply     Add a reply to a comment
  mcp       Start the Model Context Protocol (MCP) server

Options:
  -h, --help       Show this help message
  -v, --version    Show the CLI version

Run 'pinsay <command> --help' for command-specific options.
`;

async function main() {
    const { parsed, positionals } = parseArgs(argv.slice(2));
    const command = positionals[0];

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
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli init [options]

Options:
  --key <key>              API key
  --project <key>          Project key
  --create <name>          Create project with name
  --environment <list>     Also activate the project for these environments (comma-separated);
                           optional, normally managed in the dashboard
  --tool <tool>            AI tool
  --skills-dir <path>      Skills directory
  --app-url <url>          App URL
  --no-app-url             Skip App URL
  --html <path>            HTML file to inject into
  --no-inject              Skip injection
  --delivery <embed|extension>  How reviewers open the widget (default: embed, asked interactively
                           when omitted). embed = inject <pinsay-feedback> into your app (today's
                           default behaviour). extension = skip code injection; reviewers install
                           the Chrome extension instead.
  --no-skills              Skip skills installation
  --no-design              Skip design token detection
  --source-map             Wire in the Vite plugin that stamps component source hashes
  --scope <global|repo>    Where the API key is stored, without asking: global (this machine, all
                           repos, ~/.config/pinsay/credentials.json; the default with --yes) or
                           repo (.pinsay/credentials.env, gitignored, this repo only).
                           --local-credentials is an alias for --scope repo
  --no-browser             When signing in in the browser (first run, no key resolved yet), print
                           the link/code but don't try to open a browser
  -y, --yes                Non-interactive
  --json                   JSON output (implies --yes)
  -h, --help               Show help
`);
            process.exit(0);
        }
        await initCommand(cwd(), parsed);
    } else if (command === 'login') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli login [options]

Sign in and save your API key. On a terminal it asks where to save it:
  Global  this machine, every repo (~/.config/pinsay/credentials.json, honours $XDG_CONFIG_HOME)
  Repo    .pinsay/credentials.env in this repo only (gitignored)
With no terminal (CI, a pipe) or with --yes it saves globally, unless --scope repo is given.

With no --key on a real terminal, opens your browser to sign in (mirrors \`gh auth login\`): prints
a link and a short code, waits for you to approve it in the dashboard, then saves the personal API
key it hands back. Pass --key to skip the browser and validate a pasted key instead.

Options:
  --key <key>             API key — skips the browser flow entirely
  --no-browser            Print the sign-in link/code but don't try to open a browser
  --scope <global|repo>   Where to save the key, without asking
  --local-credentials     Alias for --scope repo
  -y, --yes               Don't ask; save globally unless --scope repo is given
  -h, --help              Show this help
`);
            process.exit(0);
        }
        await loginCommand(cwd(), parsed);
    } else if (command === 'logout') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli logout [options]

Removes this machine's saved global key.

Options:
  --json             Emit { ok, server, removed } as JSON
  -h, --help         Show this help
`);
            process.exit(0);
        }
        await logoutCommand(cwd(), parsed);
    } else if (command === 'whoami') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli whoami [options]

Prints the server, the signed-in account, and which of env/repo/global answered the API key —
never the key itself.

Options:
  --json             Emit { ok, server, displayName, email, source } as JSON
  -h, --help         Show this help
`);
            process.exit(0);
        }
        await whoamiCommand(cwd(), parsed);
    } else if (command === 'doctor') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli doctor [options]

Checks an existing install and prints one line per check.

Options:
  --project <key>    Override the project key
  --json             Emit { ok, checks } as JSON
  --fix              Apply the idempotent repairs (gitignore, skills, stack)
  --refresh-stack    Refresh local design tokens without contacting server
  -h, --help         Show this help

Exit codes:
  0  everything passed (warnings allowed)
  1  a check failed
  3  the API key is missing or rejected
  5  this CLI is older than the server requires
`);
            process.exit(0);
        }
        const code = await doctorCommand(cwd(), {
            project: typeof parsed['project'] === 'string' ? parsed['project'] : undefined,
            json: parsed['json'] === true,
            fix: parsed['fix'] === true,
            refreshStack: parsed['refresh-stack'] === true,
        }, BUILD_CLI_VERSION);
        process.exit(code);
    } else if (command === 'update') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli update [options]

Refreshes the AI skills and pinsay.sh from the server.

Options:
  --check            Report what is out of date without writing anything
  -h, --help         Show this help
`);
            process.exit(0);
        }
        const code = await updateCommand(cwd(), {
            check: parsed['check'] === true,
        });
        process.exit(code);
    } else if (command === 'apply') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli apply [options]

Turn pending feedback comments into a self-contained AI apply prompt.

Options:
  --plan             Plan only: list files without making edits
  --tool <name>      Hand off prompt to claude, opencode, cursor, or clipboard
  --mark <id>|all    Commit staged changes and mark comment(s) applied
  --reply <text>     Reply text for applied comment (required with --mark)
  --no-commit        Mark without committing: the fix is already committed (records --commit, default HEAD)
  --commit <sha>     With --no-commit: the commit that holds the fix (default HEAD)
  --dry-run          Print what --mark would do without making git/API changes
  --models <list>    Every model that worked on the item, with its role, for --mark/--fail:
                     "<id>=<role>,<id>=<role>" (role: planner|implementer|reviewer, optional;
                     e.g. "claude-opus-5-5=planner,claude-sonnet-5-5=implementer,claude-opus-5-5=reviewer").
                     Env fallback: PINSAY_AI_MODELS
  --model <id>       One model id (role unset); merged after --models. Env: PINSAY_AI_MODEL
  --fail <id>        Mark apply failed with a reply
  --reason <text>    Failure reason (required with --fail)
  --status <status>  Filter queue by status (open, ready, applied, archived)
  --env <env>        Filter queue by environment (local, staging, production)
  --json             Emit output as JSON
  -h, --help         Show this help
`);
            process.exit(0);
        }
        await applyCommand(cwd(), parsed, positionals);
    } else if (command === 'list' || command === 'comments') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli list [status] [environment] [options]

List feedback comments in a summary view.

Options:
  --status <status>  Filter by status (open, ready, applied, archived)
  --env <env>        Filter by environment (local, staging, production)
  --json             Emit comments as JSON
  -h, --help         Show this help
`);
            process.exit(0);
        }
        await listCommand(cwd(), parsed, positionals);
    } else if (command === 'map') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli map --from-source

Rebuild .pinsay/manifest.json from source, without running a build.

The manifest is normally produced by the Vite plugin during a build. Use this after a fresh clone
(the manifest is generated, so it is not committed) or after renaming components, when the stamped
hashes in existing comments no longer resolve.

Options:
  --from-source   Required. Walk .jsx/.tsx/.vue files and rebuild the map.
`);
            process.exit(0);
        }
        const { mapCommand } = await import('./commands/map.js');
        await mapCommand(cwd(), parsed);
    } else if (command === 'get') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli get <id> [options]

View whitelisted comment projection for AI agents.

Options:
  --json             Emit whitelisted AiCommentView JSON
  -h, --help         Show this help
`);
            process.exit(0);
        }
        await getCommand(cwd(), parsed, positionals);
    } else if (command === 'status') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli status <id> <open|ready|applied|archived>
       npx pinsay-cli status --deployed [sha]

Update comment status, or report a deployed build.

--deployed [sha]   Mark every applied comment this build contains as live. Defaults to HEAD.
                   Ancestry is computed here, in the repository, and sent to the server as a
                   list of shas — the server has no clone and cannot work it out itself.
`);
            process.exit(0);
        }
        if (parsed['deployed'] !== undefined) {
            const { deployedCommand } = await import('./commands/deployed.js');
            await deployedCommand(cwd(), parsed);
        } else {
            await statusCommand(cwd(), parsed, positionals);
        }
    } else if (command === 'reply') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli reply <id> "<text>"

Add a reply to a comment.
`);
            process.exit(0);
        }
        await replyCommand(cwd(), parsed, positionals);
    } else if (command === 'mcp') {
        if (parsed['help']) {
            console.log(`
Usage: npx pinsay-cli mcp [options]

Start the PinSay stdio MCP server for AI tools.

Options:
  --log <file>       Log MCP server traffic to file
  --project <key>    Project key
  --key <key>        API key
  -h, --help         Show this help
`);
            process.exit(0);
        }
        await mcpCommand(cwd(), parsed);
    } else {
        console.error(`Unknown command: ${command}`);
        process.exit(2);
    }
}

main().catch(err => {
    // DB-18 (Opus MEDIUM): a mid-run freeze (the workspace paused/scheduled for deletion between
    // the /me pre-check in apply.ts and a later downstream call) surfaces here as an unhandled
    // ApiError(423) — without this, every such case fell through to the generic exit code 1 instead
    // of the exit 2 reserved for a frozen workspace, and a caller (CI, a wrapper script) could not
    // tell "workspace is paused, stop" apart from "the CLI itself broke".
    if (err instanceof ApiError && err.code === 423) {
        console.error(err.message || 'Workspace is paused or scheduled for deletion.');
        process.exit(2);
    }
    console.error('Fatal error:', err);
    process.exit(1);
});
