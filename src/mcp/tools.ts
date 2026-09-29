import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { api, ApiError } from '../api.js';
import { postEvent } from '../events.js';
import { runInitChecks } from '../checks.js';
import { exitCodeFor } from '../commands/doctor.js';
import { BUILD_CLI_VERSION } from '../build-constants.js';
import { toAiCommentView } from '../apply/projection.js';
import { loadProjectContext } from '../apply/context.js';
import { isStaged, commitAll, headSha, getRemoteUrl, commitUrlFor, getUserEmail } from '../apply/git.js';
import { findRepoRoot, readConfig, resolveProject, listProjects } from '../config.js';
import { resolveModelsFromArgs, modelsBody, ModelsError, type AiModelEntry } from '../apply/models.js';
import type { ApplyClientContext, ApplyPageDto, PageContextDto } from '../apply/types.js';

export type McpContext = {
  cwd: string;
  server: string;
  project: string;
  token?: string;
  apiKey?: string;
  /** The tool recorded at `init` time (config.aiTool) — the default for a call's `tool` argument
   *  when the caller omits it. Set by executeTool from the repo's `.pinsay/config.json`. */
  configAiTool?: string;
};

export type McpError = {
  // DB-18: 'paused' — a 423 (workspace paused / scheduled for deletion) mapped by server.ts's
  // ApiError handling; thrown as a plain ApiError from api(), never constructed via mcpError()
  // directly, but listed here so callers narrowing on `code` see it in the type.
  code: 'auth' | 'not_found' | 'forbidden' | 'server_too_old' | 'git' | 'network' | 'paused';
  message: string;
};

export function mcpError(
  code: McpError['code'],
  message: string,
): McpError {
  return { code, message };
}

function mapStatusToNumber(status?: number | string): number | undefined {
  if (status === undefined || status === null) return undefined;
  if (typeof status === 'number') return status;
  const s = String(status).toLowerCase();
  if (s === 'open' || s === '1') return 1;
  if (s === 'ready' || s === 'readytoapply' || s === '2') return 2;
  if (s === 'applied' || s === '3') return 3;
  if (s === 'archived' || s === '4') return 4;
  return undefined;
}

function mapEnvironmentToNumber(env?: number | string): number | undefined {
  if (env === undefined || env === null) return undefined;
  if (typeof env === 'number') return env;
  const e = String(env).toLowerCase();
  if (e === 'local' || e === '1') return 1;
  if (e === 'staging' || e === '2') return 2;
  if (e === 'production' || e === 'prod' || e === '3') return 3;
  return undefined;
}

/**
 * Grouping helper that partitions untrusted stakeholder text and trusted actions.
 *
 * Requirements:
 * - item.untrusted has exactly { body, replies, snapshot }
 * - item.trusted has { pickedActions }
 * - zero "prompt" keys outside trusted
 * - zero hasPayloadFlag / payloadFlags / sensitive keys
 */
/**
 * The element fields an AI tool may see, named explicitly.
 *
 * NOT a spread of whatever the server sent. A spread inherits every field the DTO grows next — the
 * exact pattern R2-06 exists to prevent — and the payload flags would have ridden through it while
 * the top-level test still passed.
 */
function pickElement(raw: any): Record<string, unknown> {
  return {
    selector: raw?.selector ?? null,
    route: raw?.route ?? null,
    sourcePath: raw?.sourcePath ?? null,
    classes: raw?.classes ?? null,
    appliedCssRules: raw?.appliedCssRules ?? null,
    parentInfo: raw?.parentInfo ?? raw?.parent ?? null,
    pageUrl: raw?.pageUrl ?? null,
    pageTitle: raw?.pageTitle ?? null,
    pageRef: raw?.pageRef ?? null,
    viewportWidth: raw?.viewportWidth ?? null,
    viewportHeight: raw?.viewportHeight ?? null,
    deviceType: raw?.deviceType ?? null,
    screenshotUrl: raw?.screenshotUrl ?? null,
  };
}

export function partitionItem(item: any): any {
  const elementRaw = item?.element || {};
  const snapshot = elementRaw?.snapshot;

  const replies = Array.isArray(item?.replies)
    ? item.replies.map((r: any) => {
        const bodyValue =
          typeof r?.body === 'object' && r?.body !== null
            ? String(r.body.value ?? '')
            : String(r?.body ?? '');
        return {
          authorName: r?.authorName ?? null,
          body: bodyValue,
          isAi: Boolean(r?.isAi),
        };
      })
    : [];

  const pickedActions = Array.isArray(item?.pickedActions)
    ? item.pickedActions.map((pa: any) => ({
        text: String(pa.text ?? ''),
        prompt: String(pa.prompt ?? ''),
      }))
    : Array.isArray(item?.pickedActionTexts)
    ? item.pickedActionTexts.map((text: any) => ({
        text: String(text ?? ''),
        prompt: '',
      }))
    : [];

  const bodyValue =
    typeof item?.body === 'object' && item?.body !== null
      ? String(item.body.value ?? '')
      : String(item?.body ?? '');

  return {
    id: item.id,
    status: item.status,
    environment: item.environment,
    createdAt: item.createdAt ?? '',
    authorName: item.authorName ?? null,
    isBugReport: Boolean(item.isBugReport),
    element: pickElement(elementRaw),
    pageContextId: item.pageContextId ?? null,
    page: item.page,
    pageContext: item.pageContext,
    untrusted: {
      body: bodyValue,
      replies,
      snapshot: snapshot ?? null,
    },
    trusted: {
      pickedActions,
    },
  };
}

/**
 * Reshapes an AiCommentView so untrusted and trusted fields are partitioned.
 *
 * Top-level keys are exactly:
 * id, status, environment, createdAt, authorName, isBugReport, element,
 * appliedAt, appliedByLabel, commitUrl, untrusted, trusted
 */
export function reshapeComment(raw: any, page?: any): any {
  const view = toAiCommentView(raw, page);
  const bodyValue =
    typeof view.body === 'object' && view.body !== null
      ? String(view.body.value ?? '')
      : String(view.body ?? '');

  const replies = Array.isArray(view.replies)
    ? view.replies.map((r: any) => ({
        authorName: r.authorName ?? null,
        body:
          typeof r.body === 'object' && r.body !== null
            ? String(r.body.value ?? '')
            : String(r.body ?? ''),
        isAi: Boolean(r.isAi),
      }))
    : [];

  return {
    id: view.id,
    status: view.status,
    environment: view.environment,
    createdAt: view.createdAt,
    authorName: view.authorName,
    isBugReport: view.isBugReport,
    element: view.element,
    appliedAt: view.appliedAt,
    appliedByLabel: view.appliedByLabel,
    commitUrl: view.commitUrl,
    untrusted: {
      body: bodyValue,
      replies,
    },
    trusted: {
      pickedActions: view.pickedActions,
    },
  };
}

export async function handleListComments(
  args: {
    status?: string;
    environment?: string;
    page?: number;
    pageSize?: number;
  },
  ctx: McpContext,
): Promise<any> {
  const statusNum = mapStatusToNumber(args?.status);
  const envNum = mapEnvironmentToNumber(args?.environment);
  const page = typeof args?.page === 'number' && args.page >= 1 ? args.page : 1;
  const pageSize =
    typeof args?.pageSize === 'number' && args.pageSize >= 1 && args.pageSize <= 100
      ? args.pageSize
      : 50;

  const queryParts = ['view=summary', `pageNumber=${page}`, `pageSize=${pageSize}`];
  if (statusNum !== undefined) queryParts.push(`status=${statusNum}`);
  if (envNum !== undefined) queryParts.push(`environment=${envNum}`);

  const url = `/api/projects/${encodeURIComponent(ctx.project)}/comments?${queryParts.join('&')}`;
  const res = await api<any>(ctx.server, url, { token: ctx.token });

  const rawItems: any[] = res?.items ?? [];
  const items = rawItems.map((item: any) => ({
    id: item.id,
    status: item.status,
    environment: item.environment,
    body: item.body ?? '',
    untrusted: {
      body: item.body ?? '',
    },
    route: item.route ?? null,
    sourcePath: item.sourcePath ?? null,
    authorName: item.authorName ?? null,
    createdAt: item.createdAt,
  }));

  const totalPages = res?.pagination?.totalPages ?? 1;
  const actualPage = res?.pagination?.pageNumber ?? page;

  return {
    items,
    page: actualPage,
    totalPages,
  };
}

export async function handleGetQueue(
  args: { environment?: string },
  ctx: McpContext,
): Promise<any> {
  const clientCtx: ApplyClientContext = {
    server: ctx.server,
    project: ctx.project,
    token: ctx.token,
    apiKey: ctx.apiKey,
    cwd: ctx.cwd,
  };

  const projectCtx = await loadProjectContext(clientCtx);
  const commitStyle =
    (projectCtx.commitStyle || 'Single').toLowerCase() === 'separate' ? 'separate' : 'single';
  const aiRules = (projectCtx.aiRules || []).map((r: any) => ({
    scope: r.scope,
    priority: r.priority,
    title: r.title,
    prompt: r.prompt,
  }));

  const envNum = mapEnvironmentToNumber(args?.environment);
  const statusNum = 2; // ready to apply

  const queryParts = [`status=${statusNum}`];
  if (envNum !== undefined) queryParts.push(`environment=${envNum}`);
  const qs = `?${queryParts.join('&')}`;

  let rawItems: any[] = [];
  let note: string | undefined;

  try {
    const res = await api<any>(
      ctx.server,
      `/api/admin/projects/${encodeURIComponent(ctx.project)}/apply-queue${qs}`,
      { token: ctx.token },
    );
    const pages: Record<string, ApplyPageDto> = res?.pages ?? {};
    const pageContexts: Record<string, PageContextDto> = res?.pageContexts ?? {};
    rawItems = (res?.items ?? []).map((item: any) => {
      const pageRef = item?.element?.pageRef;
      const page = pageRef ? pages[pageRef] : undefined;
      const pageContextId = item?.pageContextId;
      const pageContext =
        pageContextId !== undefined && pageContextId !== null
          ? pageContexts[String(pageContextId)]
          : undefined;
      return {
        ...item,
        page,
        pageContext,
      };
    });
  } catch (err: any) {
    if (err instanceof ApiError && err.code === 403) {
      note = 'Note: predefined-action prompts need an admin key';
      const summaryQuery = `view=summary${qs ? `&${qs.slice(1)}` : ''}`;
      const res = await api<any>(
        ctx.server,
        `/api/projects/${encodeURIComponent(ctx.project)}/comments?${summaryQuery}`,
        { token: ctx.token },
      );
      rawItems = (res?.items ?? []).map((item: any) => ({
        id: item.id,
        status: item.status,
        environment: item.environment,
        body: item.body ?? '',
        authorName: item.authorName ?? null,
        createdAt: item.createdAt ?? '',
        element: {
          selector: item.selector ?? null,
          snapshot: item.snapshot ?? null,
          sourcePath: item.sourcePath ?? null,
        },
        replies: [],
        pickedActions: [],
        aiRules: [],
        isBugReport: false,
        page: item.route ? { route: item.route } : undefined,
      }));
    } else {
      throw err;
    }
  }

  const items = rawItems.map(partitionItem);
  const result: any = {
    commitStyle,
    aiRules,
    items,
  };
  if (note) {
    result.note = note;
  }
  return result;
}

export async function handleGetComment(
  args: { id: number },
  ctx: McpContext,
): Promise<any> {
  const id = Number(args?.id);
  if (!id || isNaN(id)) {
    throw mcpError('not_found', 'Comment ID is required');
  }

  try {
    const raw = await api<any>(ctx.server, `/api/comments/${id}`, {
      token: ctx.token,
    });
    return reshapeComment(raw, raw?.page);
  } catch (err: any) {
    if (err instanceof ApiError && err.code === 404) {
      throw mcpError('not_found', `Comment #${id} not found`);
    }
    throw err;
  }
}

/** Validate the `models` array / legacy `model` args; a bad value is a tool error, not a silent drop. */
function parseModelsArgs(args: { model?: unknown; models?: unknown } | undefined): AiModelEntry[] {
  try {
    return resolveModelsFromArgs(args);
  } catch (err) {
    if (err instanceof ModelsError) throw mcpError('forbidden', err.message);
    throw err;
  }
}

export async function handleMarkApplied(
  args: { id: number; reply: string; commitUrl?: string; tool?: string; model?: string; models?: unknown },
  ctx: McpContext,
): Promise<any> {
  const id = Number(args?.id);
  const reply = args?.reply;
  if (!id || isNaN(id) || typeof reply !== 'string') {
    throw mcpError('forbidden', 'id and reply are required');
  }

  const email = getUserEmail(ctx.cwd);
  const appliedByLabel = email;
  const commitUrl = args.commitUrl || null;
  const tool = args.tool || ctx.configAiTool;
  const models = parseModelsArgs(args);

  await api(ctx.server, `/api/comments/${id}`, {
    method: 'PATCH',
    body: {
      status: 3,
      reply,
      appliedByLabel,
      commitUrl,
      aiTool: tool || undefined,
      ...modelsBody(models),
    },
    token: ctx.token,
  });

  await postEvent(ctx.server, ctx.token, {
    type: 'first_apply',
    projectKey: ctx.project,
    meta: { commentId: id },
  });

  return {
    id,
    status: 'applied',
    commitUrl,
  };
}

export async function handleCommitAndMark(
  args: { ids: number[]; reply: string; files?: string[]; tool?: string; model?: string; models?: unknown },
  ctx: McpContext,
): Promise<any> {
  const ids = args?.ids;
  const reply = args?.reply;
  const files = args?.files;
  const tool = args?.tool || ctx.configAiTool;
  const models = parseModelsArgs(args);

  if (!Array.isArray(ids) || ids.length === 0 || typeof reply !== 'string') {
    throw mcpError('git', 'ids (non-empty array) and reply (string) are required');
  }

  // Validate files if present
  if (Array.isArray(files) && files.length > 0) {
    for (const entry of files) {
      const cleanPath = entry.includes(':') ? entry.split(':').slice(1).join(':') : entry;
      if (isAbsolute(cleanPath)) {
        throw mcpError('git', `Path must be relative to repo root: ${cleanPath}`);
      }
      const resolved = resolve(ctx.cwd, cleanPath);
      const rel = relative(ctx.cwd, resolved);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw mcpError('git', `Path escapes repository root: ${cleanPath}`);
      }
      if (!existsSync(resolved)) {
        throw mcpError('git', `File does not exist: ${cleanPath}`);
      }
    }
  } else {
    // files is absent: check if already staged
    if (!isStaged(ctx.cwd)) {
      throw mcpError('git', 'Nothing staged');
    }
  }

  const clientCtx: ApplyClientContext = {
    server: ctx.server,
    project: ctx.project,
    token: ctx.token,
    apiKey: ctx.apiKey,
    cwd: ctx.cwd,
  };

  const projectCtx = await loadProjectContext(clientCtx);
  const commitStyle = (projectCtx.commitStyle || 'Single').toLowerCase();
  const email = getUserEmail(ctx.cwd);
  const appliedByLabel = email;
  const remote = getRemoteUrl(ctx.cwd);
  const results: { id: number; commitUrl: string | null }[] = [];

  if (commitStyle === 'separate') {
    if (ids.length > 1) {
      if (!Array.isArray(files) || files.length === 0) {
        throw mcpError(
          'git',
          'files is required when commitStyle is Separate and multiple ids are provided',
        );
      }

      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const prefix = `${id}:`;
        const filesForId: string[] = [];

        for (const f of files) {
          if (f.startsWith(prefix)) {
            filesForId.push(f.slice(prefix.length));
          } else if (i === 0 && !f.includes(':')) {
            filesForId.push(f);
          }
        }

        if (filesForId.length === 0) {
          throw mcpError('git', `No files specified for comment #${id}`);
        }

        const addRes = spawnSync('git', ['add', '--', ...filesForId], {
          cwd: ctx.cwd,
          encoding: 'utf8',
        });
        if (addRes.status !== 0) {
          throw mcpError('git', addRes.stderr || 'git add failed');
        }

        let shortBody = '';
        try {
          const c = await api<any>(ctx.server, `/api/comments/${id}`, { token: ctx.token });
          shortBody = (c?.body ?? '').slice(0, 60);
        } catch {}

        const commitMsg = `Apply ${projectCtx.productName} comment #${id} — ${shortBody}`;
        const commitRes = commitAll(commitMsg, ctx.cwd);
        if (!commitRes.success) {
          throw mcpError('git', commitRes.error || 'Commit failed');
        }

        const sha = headSha(ctx.cwd);
        const commitUrl = commitUrlFor(sha, remote);

        await api(ctx.server, `/api/comments/${id}`, {
          method: 'PATCH',
          body: {
            status: 3,
            reply,
            appliedByLabel,
            commitUrl,
            // The raw sha as well as the link. Without it a comment applied through MCP can never
            // be detected as deployed — only a sha can be tested for ancestry against a build —
            // so the same fix that shipped for `pinsay apply` has to hold here.
            commitSha: sha,
            aiTool: tool || undefined,
            ...modelsBody(models),
          },
          token: ctx.token,
        });

        await postEvent(ctx.server, ctx.token, {
          type: 'first_apply',
          projectKey: ctx.project,
          meta: { commentId: id },
        });

        results.push({ id, commitUrl });
      }
    } else {
      // Single id with Separate style
      const id = ids[0];
      if (Array.isArray(files) && files.length > 0) {
        const cleanFiles = files.map((f) => (f.includes(':') ? f.split(':').slice(1).join(':') : f));
        const addRes = spawnSync('git', ['add', '--', ...cleanFiles], {
          cwd: ctx.cwd,
          encoding: 'utf8',
        });
        if (addRes.status !== 0) {
          throw mcpError('git', addRes.stderr || 'git add failed');
        }
      }

      let shortBody = '';
      try {
        const c = await api<any>(ctx.server, `/api/comments/${id}`, { token: ctx.token });
        shortBody = (c?.body ?? '').slice(0, 60);
      } catch {}

      const commitMsg = `Apply ${projectCtx.productName} comment #${id} — ${shortBody}`;
      const commitRes = commitAll(commitMsg, ctx.cwd);
      if (!commitRes.success) {
        throw mcpError('git', commitRes.error || 'Commit failed');
      }

      const sha = headSha(ctx.cwd);
      const commitUrl = commitUrlFor(sha, remote);

      await api(ctx.server, `/api/comments/${id}`, {
        method: 'PATCH',
        body: {
          status: 3,
          reply,
          appliedByLabel,
          commitUrl,
          // Same reason as the single-comment path above.
          commitSha: sha,
          aiTool: tool || undefined,
          ...modelsBody(models),
        },
        token: ctx.token,
      });

      await postEvent(ctx.server, ctx.token, {
        type: 'first_apply',
        projectKey: ctx.project,
        meta: { commentId: id },
      });

      results.push({ id, commitUrl });
    }
  } else {
    // Single commit style for all ids
    if (Array.isArray(files) && files.length > 0) {
      const cleanFiles = files.map((f) => (f.includes(':') ? f.split(':').slice(1).join(':') : f));
      const addRes = spawnSync('git', ['add', '--', ...cleanFiles], {
        cwd: ctx.cwd,
        encoding: 'utf8',
      });
      if (addRes.status !== 0) {
        throw mcpError('git', addRes.stderr || 'git add failed');
      }
    }

    const commitMsg = `Apply ${ids.length} pending ${projectCtx.productName} comments`;
    const commitRes = commitAll(commitMsg, ctx.cwd);
    if (!commitRes.success) {
      throw mcpError('git', commitRes.error || 'Commit failed');
    }

    const sha = headSha(ctx.cwd);
    const commitUrl = commitUrlFor(sha, remote);

    for (const id of ids) {
      await api(ctx.server, `/api/comments/${id}`, {
        method: 'PATCH',
        body: {
          status: 3,
          reply,
          appliedByLabel,
          commitUrl,
          // Same reason as the separate-style paths above: without the raw sha, `pinsay status
          // --deployed` can never test this comment for ancestry against a deployed build, so it
          // stays "applied" forever even once the fix ships.
          commitSha: sha,
          aiTool: tool || undefined,
          ...modelsBody(models),
        },
        token: ctx.token,
      });

      await postEvent(ctx.server, ctx.token, {
        type: 'first_apply',
        projectKey: ctx.project,
        meta: { commentId: id },
      });

      results.push({ id, commitUrl });
    }
  }

  return results;
}

export async function handleReply(
  args: { id: number; body: string; tool?: string; model?: string; models?: unknown },
  ctx: McpContext,
): Promise<any> {
  const id = Number(args?.id);
  const body = args?.body;
  if (!id || isNaN(id) || typeof body !== 'string') {
    throw mcpError('forbidden', 'id and body are required');
  }

  const tool = args?.tool || ctx.configAiTool;
  const models = parseModelsArgs(args);

  const res = await api<any>(ctx.server, `/api/comments/${id}/replies`, {
    method: 'POST',
    body: { body, aiTool: tool || undefined, ...modelsBody(models) },
    token: ctx.token,
  });

  return { replyId: res?.id ?? res?.data?.id ?? null };
}

export async function handleSetStatus(
  args: { id: number; status: string },
  ctx: McpContext,
): Promise<any> {
  const id = Number(args?.id);
  const statusStr = String(args?.status || '').toLowerCase();

  if (!id || isNaN(id) || !statusStr) {
    throw mcpError('forbidden', 'id and status are required');
  }

  if (statusStr === 'applied') {
    throw mcpError('forbidden', 'Status "applied" is only settable via mark tools');
  }

  const statusNum = mapStatusToNumber(statusStr);
  if (statusNum === undefined) {
    throw mcpError('forbidden', `Invalid status: ${args.status}`);
  }

  await api(ctx.server, `/api/comments/${id}`, {
    method: 'PATCH',
    body: { status: statusNum },
    token: ctx.token,
  });

  return { id, status: statusStr };
}

export async function handleResolveSource(
  args: { hash: string },
  ctx: McpContext,
): Promise<any> {
  const hash = args?.hash;
  if (!hash || typeof hash !== 'string') {
    throw mcpError('forbidden', 'hash is required');
  }

  const manifestPath = join(ctx.cwd, '.pinsay/manifest.json');
  if (!existsSync(manifestPath)) {
    return { path: null, reason: 'no-manifest' };
  }

  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const json = JSON.parse(raw);
    // `entries` is the documented shape; `components` and the bare map are older forms that may
    // still be sitting in a checkout, and a resolver that only understood the newest one would
    // report "unknown-hash" for a manifest that is merely from a previous CLI.
    const entry = json.entries?.[hash] || json.components?.[hash] || json[hash];
    if (entry && entry.path) {
      return {
        path: entry.path,
        // Same story for the name: the plugin wrote `export`, the spec says `component`, and this
        // read `componentName` — so it answered null for every hash the plugin itself produced.
        componentName: entry.component || entry.componentName || entry.export || null,
      };
    }
    return { path: null, reason: 'unknown-hash' };
  } catch {
    return { path: null, reason: 'unknown-hash' };
  }
}

export async function handleDoctor(
  _args: any,
  ctx: McpContext,
): Promise<any> {
  const checks = await runInitChecks(
    ctx.cwd,
    { server: ctx.server, project: ctx.project },
    BUILD_CLI_VERSION,
  );
  const code = exitCodeFor(checks);
  const ok = code === 0;
  return { ok, checks };
}

/** `pinsay_list_projects` — every PinSay project this repo knows about (one, for a
 *  single-project repo), so a caller facing an ambiguous project-scoped tool call can see its
 *  choices before retrying with an explicit `project` argument. */
export async function handleListProjects(
  _args: any,
  ctx: McpContext,
): Promise<any> {
  const root = await findRepoRoot(ctx.cwd);
  const config = await readConfig(root);
  return { projects: listProjects(config) };
}

/** Tools that act on a whole project's queue rather than a single comment id — these are the
 *  ones a multi-project repo needs a resolved `project` for. */
const PROJECT_SCOPED_TOOLS = new Set([
  'pinsay_list_comments',
  'pinsay_get_queue',
  'pinsay_commit_and_mark',
  'pinsay_doctor',
]);

export async function executeTool(
  name: string,
  args: any,
  ctx: McpContext & { serverTooOld?: string },
): Promise<any> {
  if (ctx.serverTooOld) {
    throw mcpError('server_too_old', ctx.serverTooOld);
  }
  if (name === 'pinsay_list_projects') {
    return handleListProjects(args, ctx);
  }

  // Resolution order, same as every CLI command: an explicit `project` argument on this call →
  // `--project` given to `pinsay mcp` at startup (carried as `ctx.project`) → the project whose
  // `path` contains the cwd the MCP server was started in → the only configured project.
  const root = await findRepoRoot(ctx.cwd);
  const config = await readConfig(root);
  const flag = (typeof args?.project === 'string' && args.project) || (ctx.project || undefined);
  const resolved = resolveProject(config, ctx.cwd, root, flag);

  let project = ctx.project;
  if (resolved.ok) {
    project = resolved.project.key;
  } else if (PROJECT_SCOPED_TOOLS.has(name)) {
    if (resolved.reason === 'not-found') {
      throw mcpError('not_found', `Unknown project "${flag}". Configured: ${resolved.keys.join(', ')}`);
    }
    if (resolved.reason === 'ambiguous') {
      throw mcpError(
        'forbidden',
        `Several projects configured — pass "project" (one of: ${resolved.keys.join(', ')}). Call pinsay_list_projects to see them.`,
      );
    }
    // 'none': fall through with whatever ctx.project already was (e.g. a legacy config with
    // nothing resolvable at all) — the underlying handler reports its own "no project" error.
  }

  const effectiveCtx: McpContext & { serverTooOld?: string } = {
    ...ctx,
    project,
    cwd: root,
    configAiTool: config.aiTool,
  };

  switch (name) {
    case 'pinsay_list_comments':
      return handleListComments(args, effectiveCtx);
    case 'pinsay_get_queue':
      return handleGetQueue(args, effectiveCtx);
    case 'pinsay_get_comment':
      return handleGetComment(args, effectiveCtx);
    case 'pinsay_mark_applied':
      return handleMarkApplied(args, effectiveCtx);
    case 'pinsay_commit_and_mark':
      return handleCommitAndMark(args, effectiveCtx);
    case 'pinsay_reply':
      return handleReply(args, effectiveCtx);
    case 'pinsay_set_status':
      return handleSetStatus(args, effectiveCtx);
    case 'pinsay_resolve_source':
      return handleResolveSource(args, effectiveCtx);
    case 'pinsay_doctor':
      return handleDoctor(args, effectiveCtx);
    default:
      throw mcpError('not_found', `Unknown tool: ${name}`);
  }
}
