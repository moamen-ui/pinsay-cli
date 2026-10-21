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
import { deleteCommentMedia, normalizeMedia, pruneMedia, saveIfRooted, stepPaths } from '../apply/media.js';
import { promptRef, sharedFromApi, sharedFromParts, withExtraRules } from '../apply/shared.js';
import { fetchMemberRules } from '../apply/member-rules.js';
import { isStaged, commitAll, headSha, getRemoteUrl, commitUrlFor, getUserEmail } from '../apply/git.js';
import { findRepoRoot, readConfig, resolveProject, listProjects } from '../config.js';
import { fetchStatuses, resolveStatus, unknownStatusError, statusJson } from '../statuses.js';
import { parseCommentNumber, invalidNumberMessage, fetchCommentByNumber, CommentNotFoundError } from '../lib/comment-ref.js';
import { resolveModelsFromArgs, modelsBody, ModelsError, type AiModelEntry } from '../apply/models.js';
import type { ApplyClientContext, ApplyPageDto, PageContextDto, SavedCommentMedia, SavedMedia } from '../apply/types.js';

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
  // 'invalid_input': a missing or malformed tool argument (QA-BUG-01). 'forbidden' is only an HTTP 403 from the API.
  code: 'auth' | 'invalid_input' | 'not_found' | 'forbidden' | 'server_too_old' | 'git' | 'network' | 'paused';
  message: string;
};

export function mcpError(
  code: McpError['code'],
  message: string,
): McpError {
  return { code, message };
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
function pickElement(raw: any, screenshotPath: string | null = null): Record<string, unknown> {
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
    screenshotPath,
  };
}

function mcpMedia(rawMedia: unknown, saved: SavedMedia[] | undefined): any[] {
  return normalizeMedia(rawMedia).map((m, i) => {
    const s = saved?.[i];
    return {
      kind: m.kind,
      ordinal: m.ordinal,
      path: s?.path ?? null,
      url: m.url,
      contentType: m.contentType,
      sizeBytes: m.sizeBytes ?? null,
      durationMs: m.durationMs ?? null,
      transcript: m.transcript ?? null,
      transcriptSource: m.transcriptSource ?? null,
      transcriptionStatus: m.transcriptionStatus ?? null,
      available: m.available,
      ...(s?.error ? { error: s.error } : {}),
    };
  });
}

export function partitionItem(item: any, saved?: SavedCommentMedia | null): any {
  const elementRaw = item?.element || {};
  const snapshot = elementRaw?.snapshot;

  const replies = Array.isArray(item?.replies)
    ? item.replies.map((r: any, i: number) => {
        const bodyValue =
          typeof r?.body === 'object' && r?.body !== null
            ? String(r.body.value ?? '')
            : String(r?.body ?? '');
        return {
          authorName: r?.authorName ?? null,
          body: bodyValue,
          isAi: Boolean(r?.isAi),
          media: mcpMedia(r?.media, saved?.replies.find((x) => x.position === i + 1)?.media),
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

  const rawActions: any[] = Array.isArray(item?.pickedActions) ? item.pickedActions : [];

  const bodyValue =
    typeof item?.body === 'object' && item?.body !== null
      ? String(item.body.value ?? '')
      : String(item?.body ?? '');

  const paths = stepPaths(saved);
  const pageContext =
    item.pageContext && Array.isArray(item.pageContext.stepEntries) && paths.size > 0
      ? {
          ...item.pageContext,
          stepEntries: item.pageContext.stepEntries.map((s: any) =>
            typeof s?.screenshotOrdinal === 'number' && paths.has(s.screenshotOrdinal)
              ? { ...s, screenshotPath: paths.get(s.screenshotOrdinal) }
              : s,
          ),
        }
      : item.pageContext;

  return {
    number: item.number,
    internalId: item.id,
    status: item.status,
    environment: item.environment,
    createdAt: item.createdAt ?? '',
    authorName: item.authorName ?? null,
    isBugReport: Boolean(item.isBugReport),
    element: pickElement(elementRaw, saved?.screenshot?.path ?? null),
    pageContextId: item.pageContextId ?? null,
    page: item.page,
    pageContext,
    textSource: typeof item?.textSource === 'string' ? item.textSource : null,
    untrusted: {
      body: bodyValue,
      media: mcpMedia(item?.media, saved?.media),
      replies,
      snapshot: snapshot ?? null,
    },
    trusted: {
      aiRuleRefs: Array.isArray(item?.aiRuleRefs) ? item.aiRuleRefs.map(String) : [],
      pickedActions: pickedActions.map((pa: any, j: number) => ({
        id: rawActions[j]?.ref ?? rawActions[j]?.id ?? promptRef(pa.text, pa.prompt),
        text: pa.text,
      })),
    },
  };
}

/**
 * Reshapes an AiCommentView so untrusted and trusted fields are partitioned.
 *
 * Top-level keys are exactly:
 * number, internalId, status, environment, createdAt, authorName, isBugReport, element,
 * appliedAt, appliedByLabel, commitUrl, textSource, shared, untrusted, trusted
 */
export function reshapeComment(raw: any, page?: any, saved?: SavedCommentMedia | null): any {
  const view = toAiCommentView(raw, page, saved);
  const parts = sharedFromParts([
    {
      aiRules: view.aiRules.map((r) => ({ ...r, roleName: r.roleName ?? null })),
      pickedActions: view.pickedActions,
    },
  ]);
  const bodyValue =
    typeof view.body === 'object' && view.body !== null
      ? String(view.body.value ?? '')
      : String(view.body ?? '');

  const replies = Array.isArray(view.replies)
    ? view.replies.map((r: any, i: number) => ({
        authorName: r.authorName ?? null,
        body:
          typeof r.body === 'object' && r.body !== null
            ? String(r.body.value ?? '')
            : String(r.body ?? ''),
        isAi: Boolean(r.isAi),
        media: mcpMedia(raw?.replies?.[i]?.media, saved?.replies.find((x) => x.position === i + 1)?.media),
      }))
    : [];

  return {
    number: view.number,
    internalId: view.internalId,
    status: view.status,
    environment: view.environment,
    createdAt: view.createdAt,
    authorName: view.authorName,
    isBugReport: view.isBugReport,
    element: view.element,
    appliedAt: view.appliedAt,
    appliedByLabel: view.appliedByLabel,
    commitUrl: view.commitUrl,
    textSource: view.textSource,
    shared: parts.shared,
    untrusted: {
      body: bodyValue,
      media: mcpMedia(raw?.media, saved?.media),
      replies,
    },
    trusted: {
      aiRuleRefs: parts.refs[0].aiRuleRefs,
      pickedActions: view.pickedActions.map((p, j) => ({ id: parts.refs[0].actionIds[j], text: p.text })),
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
  const catalog = await fetchStatuses(ctx);
  let statusKey: string | undefined;
  if (args?.status !== undefined && args.status !== null && String(args.status).trim() !== '') {
    const resolvedStatus = resolveStatus(args.status, catalog);
    if (!resolvedStatus) throw mcpError('invalid_input', unknownStatusError(String(args.status), catalog));
    statusKey = resolvedStatus.key;
  }
  const envNum = mapEnvironmentToNumber(args?.environment);
  const page = typeof args?.page === 'number' && args.page >= 1 ? args.page : 1;
  const pageSize =
    typeof args?.pageSize === 'number' && args.pageSize >= 1 && args.pageSize <= 100
      ? args.pageSize
      : 50;

  const queryParts = ['view=summary', `pageNumber=${page}`, `pageSize=${pageSize}`];
  if (statusKey !== undefined) queryParts.push(`statusKey=${encodeURIComponent(statusKey)}`);
  if (envNum !== undefined) queryParts.push(`environment=${envNum}`);

  const url = `/api/projects/${encodeURIComponent(ctx.project)}/comments?${queryParts.join('&')}`;
  const res = await api<any>(ctx.server, url, { token: ctx.token });

  const rawItems: any[] = res?.items ?? [];
  const items = rawItems.map((item: any) => ({
    number: item.number,
    internalId: item.id,
    status: item.status,
    ...statusJson(item, catalog),
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

  const envNum = mapEnvironmentToNumber(args?.environment);
  const statusNum = 2; // ready to apply

  const queryParts = [`status=${statusNum}`];
  if (envNum !== undefined) queryParts.push(`environment=${envNum}`);
  const qs = `?${queryParts.join('&')}`;

  let rawItems: any[] = [];
  let note: string | undefined;
  let apiParts: ReturnType<typeof sharedFromApi> = null;

  try {
    const res = await api<any>(
      ctx.server,
      `/api/admin/projects/${encodeURIComponent(ctx.project)}/apply-queue${qs}&shape=shared`,
      { token: ctx.token },
    );
    apiParts = sharedFromApi(res, (res?.items ?? []).length);
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
      const memberRules = await fetchMemberRules({ server: ctx.server, project: ctx.project, token: ctx.token });
      rawItems = (res?.items ?? []).map((item: any) => ({
        id: item.id,
        number: item.number,
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
        aiRules: memberRules,
        isBugReport: false,
        page: item.route ? { route: item.route } : undefined,
      }));
    } else {
      throw err;
    }
  }

  const parts =
    apiParts ??
    sharedFromParts(
      rawItems.map((i: any) => ({
        aiRules: Array.isArray(i.aiRules) ? i.aiRules : [],
        pickedActions: Array.isArray(i.pickedActions) ? i.pickedActions : [],
      })),
    );
  rawItems = rawItems.map((raw: any, i: number) => ({
    ...raw,
    aiRuleRefs: parts.refs[i].aiRuleRefs,
    pickedActions: (Array.isArray(raw.pickedActions) ? raw.pickedActions : []).map((pa: any, j: number) => ({
      ...pa,
      ref: parts.refs[i].actionIds[j],
    })),
  }));

  const root = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : undefined;
  if (root) await pruneMedia(root);
  const items = [];
  for (const raw of rawItems) {
    const saved = await saveIfRooted(raw, { root, projectKey: ctx.project, server: ctx.server, token: ctx.token });
    items.push(partitionItem(raw, saved));
  }
  const result: any = {
    commitStyle,
    shared: withExtraRules(parts.shared, projectCtx.aiRules ?? []),
    items,
  };
  if (note) {
    result.note = note;
  }
  return result;
}

export async function handleGetComment(
  args: { number: number },
  ctx: McpContext,
): Promise<any> {
  const number = parseCommentNumber(args?.number);
  if (number === null) {
    throw mcpError('invalid_input', invalidNumberMessage(args?.number, (args as any)?.id));
  }

  let id: number;
  try {
    const resolved = await fetchCommentByNumber<any>(ctx.server, ctx.token, ctx.project, number);
    id = resolved.id;
  } catch (err) {
    if (err instanceof CommentNotFoundError) {
      throw mcpError('not_found', err.message);
    }
    throw err;
  }

  try {
    const raw = await api<any>(ctx.server, `/api/comments/${id}`, {
      token: ctx.token,
    });
    const root = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : undefined;
    if (root) await pruneMedia(root);
    const saved = await saveIfRooted(raw, { root, projectKey: ctx.project, server: ctx.server, token: ctx.token });
    return reshapeComment(raw, raw?.page, saved);
  } catch (err: any) {
    if (err instanceof ApiError && err.code === 404) {
      throw mcpError('not_found', `Comment #${number} not found`);
    }
    throw err;
  }
}

/** Validate the `models` array / legacy `model` args; a bad value is a tool error, not a silent drop. */
function parseModelsArgs(args: { model?: unknown; models?: unknown } | undefined): AiModelEntry[] {
  try {
    return resolveModelsFromArgs(args);
  } catch (err) {
    if (err instanceof ModelsError) throw mcpError('invalid_input', err.message);
    throw err;
  }
}

async function dropSavedMedia(ctx: McpContext, number: number): Promise<void> {
  if (typeof ctx.cwd === 'string' && ctx.cwd !== '') await deleteCommentMedia(ctx.cwd, ctx.project, number);
}

export async function handleMarkApplied(
  args: { number: number; reply: string; commitUrl?: string; tool?: string; model?: string; models?: unknown },
  ctx: McpContext,
): Promise<any> {
  const number = parseCommentNumber(args?.number);
  const reply = args?.reply;
  if (number === null) {
    throw mcpError('invalid_input', invalidNumberMessage(args?.number, (args as any)?.id));
  }
  if (typeof reply !== 'string') {
    throw mcpError('invalid_input', 'number and reply are required');
  }

  let id: number;
  try {
    const resolved = await fetchCommentByNumber<any>(ctx.server, ctx.token, ctx.project, number);
    id = resolved.id;
  } catch (err) {
    if (err instanceof CommentNotFoundError) {
      throw mcpError('not_found', err.message);
    }
    throw err;
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

  await postEvent(ctx.server, ctx.token, { type: 'first_apply', projectKey: ctx.project, meta: { commentId: id } }, ctx.cwd);

  await dropSavedMedia(ctx, number);

  return {
    number,
    status: 'applied',
    commitUrl,
  };
}

export async function handleCommitAndMark(
  args: { numbers: number[]; reply: string; files?: string[]; tool?: string; model?: string; models?: unknown },
  ctx: McpContext,
): Promise<any> {
  const numbers = args?.numbers;
  const reply = args?.reply;
  const files = args?.files;
  if (numbers === undefined || numbers === null) {
    throw mcpError('invalid_input', invalidNumberMessage(undefined, (args as any)?.ids ?? (args as any)?.id));
  }
  const tool = args?.tool || ctx.configAiTool;
  const models = parseModelsArgs(args);

  if (!Array.isArray(numbers) || numbers.length === 0 || typeof reply !== 'string') {
    throw mcpError('git', 'numbers (non-empty array) and reply (string) are required');
  }

  const parsedNumbers: number[] = [];
  for (const x of numbers) {
    const n = parseCommentNumber(x);
    if (n === null) {
      throw mcpError('invalid_input', invalidNumberMessage(x));
    }
    parsedNumbers.push(n);
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

  // Each number is per project: resolve it to the comment's internal id first, then the existing
  // /api/comments/{id} calls below run with that id exactly as before.
  const comments: { number: number; id: number }[] = [];
  for (const n of parsedNumbers) {
    try {
      const resolved = await fetchCommentByNumber<any>(ctx.server, ctx.token, ctx.project, n);
      comments.push({ number: n, id: resolved.id });
    } catch (err) {
      if (err instanceof CommentNotFoundError) {
        throw mcpError('not_found', err.message);
      }
      throw err;
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
  const results: { number: number; commitUrl: string | null }[] = [];

  if (commitStyle === 'separate') {
    if (comments.length > 1) {
      if (!Array.isArray(files) || files.length === 0) {
        throw mcpError(
          'git',
          'files is required when commitStyle is Separate and multiple numbers are provided',
        );
      }

      for (let i = 0; i < comments.length; i++) {
        const { number, id } = comments[i];
        const prefix = `${number}:`;
        const filesForId: string[] = [];

        for (const f of files) {
          if (f.startsWith(prefix)) {
            filesForId.push(f.slice(prefix.length));
          } else if (i === 0 && !f.includes(':')) {
            filesForId.push(f);
          }
        }

        if (filesForId.length === 0) {
          throw mcpError('git', `No files specified for comment #${number}`);
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

        const commitMsg = `Apply ${projectCtx.productName} comment #${number} — ${shortBody}`;
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

      await postEvent(ctx.server, ctx.token, { type: 'first_apply', projectKey: ctx.project, meta: { commentId: id } }, ctx.cwd);

      await dropSavedMedia(ctx, number);
      results.push({ number, commitUrl });
      }
    } else {
      // Single number with Separate style
      const { number, id } = comments[0];
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

      const commitMsg = `Apply ${projectCtx.productName} comment #${number} — ${shortBody}`;
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

      await postEvent(ctx.server, ctx.token, { type: 'first_apply', projectKey: ctx.project, meta: { commentId: id } }, ctx.cwd);

      await dropSavedMedia(ctx, number);
      results.push({ number, commitUrl });
    }
  } else {
    // Single commit style for all numbers
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

    const commitMsg = `Apply ${comments.length} pending ${projectCtx.productName} comments`;
    const commitRes = commitAll(commitMsg, ctx.cwd);
    if (!commitRes.success) {
      throw mcpError('git', commitRes.error || 'Commit failed');
    }

    const sha = headSha(ctx.cwd);
    const commitUrl = commitUrlFor(sha, remote);

    for (const { number, id } of comments) {
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

      await postEvent(ctx.server, ctx.token, { type: 'first_apply', projectKey: ctx.project, meta: { commentId: id } }, ctx.cwd);

      await dropSavedMedia(ctx, number);
      results.push({ number, commitUrl });
    }
  }

  return results;
}

export async function handleReply(
  args: { number: number; body: string; tool?: string; model?: string; models?: unknown },
  ctx: McpContext,
): Promise<any> {
  const number = parseCommentNumber(args?.number);
  const body = args?.body;
  if (number === null) {
    throw mcpError('invalid_input', invalidNumberMessage(args?.number, (args as any)?.id));
  }
  if (typeof body !== 'string') {
    throw mcpError('invalid_input', 'number and body are required');
  }

  let id: number;
  try {
    const resolved = await fetchCommentByNumber<any>(ctx.server, ctx.token, ctx.project, number);
    id = resolved.id;
  } catch (err) {
    if (err instanceof CommentNotFoundError) {
      throw mcpError('not_found', err.message);
    }
    throw err;
  }

  const tool = args?.tool || ctx.configAiTool;
  const models = parseModelsArgs(args);

  const res = await api<any>(ctx.server, `/api/comments/${id}/replies`, {
    method: 'POST',
    body: { body, aiTool: tool || undefined, ...modelsBody(models) },
    token: ctx.token,
  });

  return { number, replyId: res?.id ?? res?.data?.id ?? null };
}

export async function handleSetStatus(
  args: { number: number; status: string },
  ctx: McpContext,
): Promise<any> {
  const number = parseCommentNumber(args?.number);
  const statusStr = String(args?.status || '').trim();

  if (number === null) {
    throw mcpError('invalid_input', invalidNumberMessage(args?.number, (args as any)?.id));
  }
  if (!statusStr) {
    throw mcpError('invalid_input', 'number and status are required');
  }

  const catalog = await fetchStatuses(ctx);
  const resolvedStatus = resolveStatus(statusStr, catalog);
  if (!resolvedStatus) {
    throw mcpError('invalid_input', unknownStatusError(statusStr, catalog));
  }
  if (resolvedStatus.status === 3) {
    throw mcpError('invalid_input', 'Status "applied" is only settable via mark tools');
  }

  let id: number;
  try {
    const resolved = await fetchCommentByNumber<any>(ctx.server, ctx.token, ctx.project, number);
    id = resolved.id;
  } catch (err) {
    if (err instanceof CommentNotFoundError) {
      throw mcpError('not_found', err.message);
    }
    throw err;
  }

  await api(ctx.server, `/api/comments/${id}`, {
    method: 'PATCH',
    body: { statusKey: resolvedStatus.key },
    token: ctx.token,
  });

  return { number, status: resolvedStatus.key };
}

export async function handleResolveSource(
  args: { hash: string },
  ctx: McpContext,
): Promise<any> {
  const hash = args?.hash;
  if (!hash || typeof hash !== 'string') {
    throw mcpError('invalid_input', 'hash is required');
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

/** Tools that need a resolved `project` in a multi-project repo: they act on a whole project's
 *  queue, or reference a comment by its number — and a number is per project. */
const PROJECT_SCOPED_TOOLS = new Set([
  'pinsay_list_comments',
  'pinsay_get_queue',
  'pinsay_get_comment',
  'pinsay_mark_applied',
  'pinsay_commit_and_mark',
  'pinsay_reply',
  'pinsay_set_status',
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
        'invalid_input',
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
