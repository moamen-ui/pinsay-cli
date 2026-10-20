# pinsay-cli

Command-line tool for [PinSay](https://pinsay.dev) — wire element-level feedback into your app, then let your AI coding tool apply the fixes.

## Quickstart

```bash
npx pinsay-cli init
```

`init` signs you in in your browser, picks the project, detects your AI tool, asks whether to share your framework names (Yes by default; `--no-share-stack` to decline), shows a short plan and sets the repo up for the PinSay Chrome extension — no change to your app's code. Want the widget in your code? `npx pinsay-cli embed`.

- `npx pinsay-cli <command>` runs it without installing — but you type the full name every time.
- `npm i -g pinsay-cli` installs a real `pinsay` command on your PATH — then plain `pinsay <command>` works everywhere the docs say `npx pinsay-cli <command>`.

## Commands

| Command | What it does |
|---|---|
| `npx pinsay-cli init` | Set up this repo (sign in, project, skills; Chrome extension by default) |
| `npx pinsay-cli embed` | Put the widget in your app's code |
| `npx pinsay-cli login` / `whoami` / `logout` | Sign in; the key is saved in this repo; check (account, workspace) / clear credentials |
| `npx pinsay-cli remove` | Remove everything PinSay added to this repo |
| `npx pinsay-cli status` | Who you are, this folder's project, comments waiting |
| `npx pinsay-cli open` | Open this project in the dashboard |
| `npx pinsay-cli list` / `get <id>` | List pending feedback; inspect one comment |
| `npx pinsay-cli apply` | Generate the fix-it prompt for your AI tool, then record what changed |
| `npx pinsay-cli apply --plan` | Preview proposed edits without touching code |
| `npx pinsay-cli apply --mark <id> --reply "..."` | Mark comment(s) applied, with the commit URL |
| `npx pinsay-cli status <id> <status>` / `reply <id> "<text>"` | Change a comment's status / reply |
| `npx pinsay-cli doctor` | Verify config, credentials, server and widget health |
| `npx pinsay-cli update` | Refresh the installed skills to the server's version |
| `npx pinsay-cli map --from-source` | Rebuild the component-source manifest (Vite plugin users) |
| `npx pinsay-cli mcp` | Run the MCP server for Claude Code / Cursor |

## How you use it day to day

1. A reviewer pins an element in your app and leaves a comment.
2. Run `npx pinsay-cli apply` — it prints a self-contained prompt.
3. Paste it into your AI tool; it edits the code and commits.
4. Run `npx pinsay-cli apply --mark <id> --reply "<what changed>"` to close the loop.

## API keys

Keys look like `pnsy_` + 40 hex characters. They resolve in this order: `PINSAY_API_KEY` env var → `.pinsay/credentials.env` (mode 0600, hidden from git). `init` and `login` save the key in the repo; there is no machine-wide key since 0.10.0, and `npx pinsay-cli update` deletes one an older version saved (`~/.config/pinsay/credentials.json`).

## MCP (Claude Code / Cursor)

```json
{ "mcpServers": { "pinsay": { "command": "npx", "args": ["-y", "pinsay-cli", "mcp"] } } }
```

User-level config, not committed. The key stays inside the CLI process.

## Privacy

The CLI never reads or uploads your source code. It asks before sharing your framework names and AI tool (Yes by default; without a terminal also Yes unless `--no-share-stack`); on No it sends only a "setup done" signal. Design tokens stay in `.pinsay/stack.json`.

## Docs

Full guides: https://pinsay.dev/docs/ · Issues: https://github.com/moamen-ui/pinsay-cli/issues · support@pinsay.dev

## Changelog

### 0.14.1

- `apply --mark … --message "<text>"` sets the commit message `--mark` makes, so it can follow your project's commit rules; an empty `--message`, or `--message` with `--no-commit`, exits 2. Without `--message` the built-in message is unchanged.
- `get --json`, the MCP `pinsay_get_comment` tool and `apply --json` items print `environment` as `Local` / `Staging` / `Production` instead of 1/2/3.
- `get --json` picked actions no longer carry an empty `prompt`; prompt text stays in the admin `apply --json`.

### 0.14.0

- Custom statuses: `list --status`, `apply --status` and `status <number> <status>` (and the MCP `pinsay_list_comments` / `pinsay_set_status` tools) take a custom status by label or key (`c<id>`), case-insensitive. Output shows the status label; `--json` adds `statusKey` and `statusLabel` next to `status`.
- An unknown status now exits 2 with the workspace's statuses (MCP: `invalid_input`) instead of listing everything. `apply` alone still means Ready; `applied` stays Completed and is set only by `apply --mark`.

### 0.13.0

- Comment media in `get` (human output and `--json`) and in the MCP `pinsay_get_comment` / `pinsay_get_queue` tools: recording steps (each with its screenshot), annotated screenshots, voice messages and the files on replies. Each file is named by its saved path (`media[].path`, `element.screenshotPath`; MCP `untrusted.media[].path`).
- Voice messages come with their text and `transcriptSource` (`browser` or `server`); the human output labels each transcript.
- Files are saved under `.pinsay/media/<project>/<number>/`. Only downloads from the PinSay server's own origin are saved, capped at 25 MB each and limited to safe file extensions; a file that fails reads `(download failed: …)`. Folders older than 7 days are pruned, and `apply --mark` and the MCP mark tools delete the marked comment's folder.
- The apply prompt describes recordings as "Steps to reproduce" (each step, its screenshot and what failed after it), tells the agent to read annotation marks as instructions and voice messages as the person's words, handles comments with no text (their picked prompts, annotation or voice are the instruction), and treats files on replies as evidence of what is still wrong.
- AI rules and predefined prompts now come once per response, in a shared block, and each comment references them. `apply --json` prints `{ shared, items }` (was a bare array; with several projects, each entry gains `shared`): `shared.aiRules` (with `id` and `appliesTo`) and `shared.prompts` by `id`; each item names its author's Personal rules (`aiRuleRefs`) and its picked prompts (`pickedActions[].id`). The MCP tools return the same `shared` block and the apply prompt lists rules and prompts once with ids. Works with older servers too.

### 0.12.0

- Role AI rules: rules an admin ties to a workspace role now apply everywhere rules do — the apply prompt, `get --json` and the MCP tools. The prompt's precedence table gains the Role tier (Workspace → Project → Role → Personal), and role rules are labelled `[Role: <role name>]`.
- `get --json` and the MCP comment/queue outputs carry the effective rules (`aiRules`, with `roleName` on role rules; MCP exposes them under `trusted.aiRules`).
- Member (non-admin) keys: when the admin apply-queue is refused, the CLI fetches the workspace's, project's and the caller's role rules from the read-only ai-rules endpoint.

### 0.11.2

- MCP tools answer a missing or malformed argument (e.g. the legacy `id`) with error code `invalid_input` instead of `forbidden`; `forbidden` now means only an HTTP 403 from PinSay.

### 0.11.1

- MCP tools: passing the old `id` argument now says it was renamed to `number` instead of a generic error.
- `pinsay_reply` returns the comment `number` with the `replyId`.
- `--help` exit-code legend: exit 4 also covers "comment not found".

### 0.11.0

- Comments are numbered per project: `#1`, `#2`, … in `list`, `get`, `status`, `apply`, `reply` and the dashboard. Pass that number (or `--number`); the internal id is no longer accepted, and `get --id` is removed.
- `--json` output has both `number` and `internalId`.
- MCP tools take `number` / `numbers` instead of ids.

### 0.10.0

- The API key lives only in the repo: `--global` (login, init, logout, remove) is gone, and a key saved on the machine is no longer read.
- `update` deletes the machine-wide key file an older version saved, and says which file it removed.
- `whoami` shows the workspace; `status` / `apply` say "Project … not found in workspace …" instead of a generic error.

### 0.9.1

- `remove` works when the repo sits behind a linked or shortened path (Windows junctions / short paths).

### 0.9.0

- No more `.pinsay/pinsay.sh` (old copies keep working; `remove` deletes them).
- Asks before sharing framework names / usage events (`--share-stack`, `--no-share-stack`).
- `init` assumes the Chrome extension; `embed` / `init --embed` put the widget in code.
- Key saved in the repo by default; `--global` / `login --global`.
- Fewer questions, a plan with one confirm, quick check, one next step, `--dry-run`.
- New `remove`, `status`, `open`.
- Clearer prompts (coloured question band, `--no-color`, `NO_COLOR`).
- Plain errors, new exit code 4 when PinSay can't be reached.
- Shorter `--help`.
