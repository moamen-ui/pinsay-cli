# pinsay-cli

Command-line tool for [PinSay](https://pinsay.dev) — wire element-level feedback into your app, then let your AI coding tool apply the fixes.

## Quickstart

```bash
npx pinsay-cli init
```

`init` walks you through everything: server, project, AI tool, and the widget/script snippet to paste into your app. It takes about a minute.

- `npx pinsay-cli <command>` runs it without installing — but you type the full name every time.
- `npm i -g pinsay-cli` installs a real `pinsay` command on your PATH (recommended).

## Commands

| Command | What it does |
|---|---|
| `pinsay init` | Configure a repo (server, project, widget snippet, skills) |
| `pinsay login` / `whoami` / `logout` | Sign in once per machine; check / clear credentials |
| `pinsay list` / `get <id>` | List pending feedback; inspect one comment |
| `pinsay apply` | Generate the fix-it prompt for your AI tool, then record what changed |
| `pinsay apply --plan` | Preview proposed edits without touching code |
| `pinsay apply --mark <id> --reply "..."` | Mark comment(s) applied, with the commit URL |
| `pinsay status <id> <status>` / `reply <id> "<text>"` | Change a comment's status / reply |
| `pinsay doctor` | Verify config, credentials, server and widget health |
| `pinsay update` | Refresh the installed skills to the server's version |
| `pinsay map --from-source` | Rebuild the component-source manifest (Vite plugin users) |
| `pinsay mcp` | Run the MCP server for Claude Code / Cursor |

## How you use it day to day

1. A reviewer pins an element in your app and leaves a comment.
2. Run `pinsay apply` — it prints a self-contained prompt.
3. Paste it into your AI tool; it edits the code and commits.
4. Run `pinsay apply --mark <id> --reply "<what changed>"` to close the loop.

## API keys

Keys look like `pnsy_` + 40 hex characters. They resolve in this order: `PINSAY_API_KEY` env var → `.pinsay/credentials.env` → the per-machine store (`~/.config/pointer/credentials.json`, mode 0600, never committed).

## MCP (Claude Code / Cursor)

```json
{ "mcpServers": { "pinsay": { "command": "npx", "args": ["-y", "pinsay-cli", "mcp"] } } }
```

User-level config, not committed. The key stays inside the CLI process.

## Docs

Full guides: https://pinsay.dev/docs/ · Issues: https://github.com/moamen-ui/pinsay-cli/issues · support@pinsay.dev
