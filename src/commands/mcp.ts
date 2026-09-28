import { canonicalServer, readConfig, findRepoRoot, resolveProject } from '../config.js';
import { api, ApiError } from '../api.js';
import { resolveToken, readApiKey } from '../auth.js';
import { compareSemver, tooOldMessage } from '../checks.js';
import { BUILD_CLI_VERSION, BUILD_DEFAULT_SERVER } from '../build-constants.js';
import { runMcpServer } from '../mcp/server.js';
import type { McpContext } from '../mcp/tools.js';

export async function mcpCommand(
  cwd: string,
  parsed: Record<string, string | boolean> = {},
): Promise<void> {
  // `root`, not `cwd`: an MCP client (an editor, typically) can be started from an app
  // subdirectory of a multi-project repo, and every credential/config path below must resolve
  // relative to the repo root, not wherever that happened to be.
  const root = await findRepoRoot(cwd);
  const config = await readConfig(root).catch(() => ({} as any));
  const server = (
    (typeof parsed['server'] === 'string' ? parsed['server'] : config.server) ||
    canonicalServer(process.env.PINSAY_SERVER) ||
    BUILD_DEFAULT_SERVER
  ).replace(/\/$/, '');

  // `--project` (or PINSAY_PROJECT/config.project in single-project mode) is carried as-is —
  // `executeTool` (mcp/tools.ts) is what actually resolves it per call, falling back to cwd/the
  // only-configured-project when this is empty, so a multi-project repo works the same way here
  // as it does from a plain CLI invocation.
  const projectFlag = typeof parsed['project'] === 'string' ? parsed['project'] : undefined;
  const project =
    projectFlag ||
    config.project ||
    process.env.PINSAY_PROJECT ||
    '';

  const explicitKey = typeof parsed['key'] === 'string' ? parsed['key'] : undefined;
  const apiKey = explicitKey || (await readApiKey(root, server));

  // Requirement: Fails fast with a single stderr line and exit 3 if no key
  if (!apiKey) {
    console.error(
      'Missing API key. Set PINSAY_API_KEY, add .pinsay/credentials.env, or run `npx pinsay-cli login`.',
    );
    process.exit(3);
  }

  const token = await resolveToken(server, root, explicitKey).catch(() => undefined);

  // Check /api/meta for minCliVersion compatibility
  let serverTooOld: string | undefined;
  try {
    const meta = await api<any>(server, '/api/meta');
    const minCli = meta?.minCliVersion || '0.0.0';
    if (compareSemver(BUILD_CLI_VERSION, minCli) < 0) {
      serverTooOld = tooOldMessage(BUILD_CLI_VERSION, minCli);
    }
  } catch {
    // Best-effort check; 404 or network failures don't block startup
  }

  const logFile = typeof parsed['log'] === 'string' ? parsed['log'] : undefined;

  const ctx: McpContext & { serverTooOld?: string } = {
    cwd,
    server,
    project,
    token,
    apiKey,
    serverTooOld,
  };

  await runMcpServer(ctx, logFile);
}
