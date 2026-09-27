# pinsay-cli

Command-line tool for [PinSay](https://pinsay.dev) — wire element-level feedback into your app, then let your AI coding tool apply the fixes.

## Quickstart

```bash
npx pinsay-cli init
```

`init` walks you through everything: server, project, AI tool, and the widget/script snippet to paste into your app. It takes about a minute.

- `npx pinsay-cli <command>` runs it without installing — but you type the full name every time.
- `npm i -g pinsay-cli` installs a real `pinsay` command on your PATH — then plain `pinsay <command>` works everywhere the docs say `npx pinsay-cli <command>`.

## Commands

| Command | What it does |
|---|---|
| `npx pinsay-cli init` | Configure a repo (server, project, widget snippet, skills) |
| `npx pinsay-cli login` / `whoami` / `logout` | Sign in once per machine; check / clear credentials |
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

Keys look like `pnsy_` + 40 hex characters. They resolve in this order: `PINSAY_API_KEY` env var → `.pinsay/credentials.env` → the per-machine store (`~/.config/pointer/credentials.json`, mode 0600, never committed).

## MCP (Claude Code / Cursor)

```json
{ "mcpServers": { "pinsay": { "command": "npx", "args": ["-y", "pinsay-cli", "mcp"] } } }
```

User-level config, not committed. The key stays inside the CLI process.

## Docs

Full guides: https://pinsay.dev/docs/ · Issues: https://github.com/moamen-ui/pinsay-cli/issues · support@pinsay.dev
