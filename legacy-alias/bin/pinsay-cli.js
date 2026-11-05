#!/usr/bin/env node
// pinsay-cli is now @pinsay/cli. This alias keeps `npx pinsay-cli …` working: one notice on stderr
// (stdout carries --json output and the MCP stdio protocol, so nothing may be printed there), then
// @pinsay/cli's entry runs in this process with the same argv, so arguments and exit codes pass through.
process.stderr.write('pinsay-cli is now @pinsay/cli: use npx @pinsay/cli <command> (or npm i -g @pinsay/cli).\n');
await import('@pinsay/cli');
