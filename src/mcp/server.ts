import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ALL_TOOLS } from './schemas.js';
import { executeTool, type McpContext } from './tools.js';
import { ApiError } from '../api.js';
import { fetchQueue } from '../apply/queue.js';
import { loadProjectContext } from '../apply/context.js';
import { buildApplyPrompt } from '../apply/prompt.js';
import { BUILD_CLI_VERSION } from '../build-constants.js';
import type { ApplyClientContext } from '../apply/types.js';

export function createMcpServer(ctx: McpContext): Server {
  const server = new Server(
    {
      name: 'pinsay',
      version: BUILD_CLI_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [...ALL_TOOLS],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};

    try {
      const result = await executeTool(name, args, ctx);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (err: any) {
      let code = 'network';
      let message = err?.message || String(err);

      if (err?.code && typeof err.code === 'string') {
        code = err.code;
      } else if (err instanceof ApiError) {
        if (err.code === 401) code = 'auth';
        else if (err.code === 403) code = 'forbidden';
        else if (err.code === 404) code = 'not_found';
        // DB-18: workspace paused / scheduled for deletion. Every write (and, for a key session,
        // every read but /me and /events) gets 423 while frozen — surfaced as a tool error carrying
        // the server's message, never a process.exit (this MCP server serves other tools' calls too).
        else if (err.code === 423) code = 'paused';
        else code = 'network';
      }

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ code, message }),
          },
        ],
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'pinsay://project',
          name: 'PinSay project configuration',
          description: 'Merged .pinsay/config.json and stack.json',
          mimeType: 'application/json',
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri !== 'pinsay://project') {
      throw new Error(`Unknown resource URI: ${uri}`);
    }

    let configObj: Record<string, any> = {};
    let stackObj: Record<string, any> = {};

    try {
      const configPath = join(ctx.cwd, '.pinsay/config.json');
      configObj = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {}

    try {
      const stackPath = join(ctx.cwd, '.pinsay/stack.json');
      stackObj = JSON.parse(readFileSync(stackPath, 'utf8'));
    } catch {}

    const merged = { ...configObj, ...stackObj };

    return {
      contents: [
        {
          uri: 'pinsay://project',
          mimeType: 'application/json',
          text: JSON.stringify(merged, null, 2),
        },
      ],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: 'pinsay_apply_instructions',
          description: 'Self-contained apply prompt for pending comments',
          arguments: [
            {
              name: 'environment',
              description: 'Filter by environment (local, staging, production)',
              required: false,
            },
          ],
        },
      ],
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name;
    if (name !== 'pinsay_apply_instructions') {
      throw new Error(`Unknown prompt: ${name}`);
    }

    const env = request.params.arguments?.environment;
    const clientCtx: ApplyClientContext = {
      server: ctx.server,
      project: ctx.project,
      token: ctx.token,
      apiKey: ctx.apiKey,
      cwd: ctx.cwd,
    };

    const items = await fetchQueue(clientCtx, { status: 2, environment: env });
    const projectContext = await loadProjectContext(clientCtx);
    const promptText = buildApplyPrompt(items, projectContext);

    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: promptText,
          },
        },
      ],
    };
  });

  return server;
}

export async function runMcpServer(
  ctx: McpContext,
  logFile?: string,
): Promise<void> {
  if (logFile) {
    // Write debug log if requested
    try {
      const fs = await import('node:fs');
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      const origWrite = process.stderr.write;
      (process.stderr as any).write = function (
        chunk: any,
        encoding?: any,
        cb?: any,
      ): boolean {
        logStream.write(chunk);
        return origWrite.call(process.stderr, chunk, encoding, cb);
      };
    } catch {}
  }

  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
