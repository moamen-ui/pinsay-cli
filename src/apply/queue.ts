import { authorKindOf } from './author-kind.js';
import { api, ApiError } from '../api.js';
import { ProjectNotFoundError } from '../errors.js';
import { fetchMemberRules } from './member-rules.js';
import { normalizeMedia } from './media.js';
import { referencedCommentsOf, referencedProjectsOf } from './projection.js';
import { sharedFromApi, sharedFromParts, type SharedBlock } from './shared.js';
import { fetchStatuses, resolveStatus, unknownStatusError } from '../statuses.js';
import type { ApplyClientContext, QueueItem, ApplyPageDto, PageContextDto } from './types.js';

export type QueueFilter = {
  status?: number | string;
  environment?: number | string;
};

function mapEnvironmentToNumber(env?: number | string): number | undefined {
  if (env === undefined || env === null) return undefined;
  if (typeof env === 'number') return env;
  const e = String(env).toLowerCase();
  if (e === 'local' || e === '1') return 1;
  if (e === 'staging' || e === '2') return 2;
  if (e === 'production' || e === 'prod' || e === '3') return 3;
  return undefined;
}

let warnedNonAdminFallback = false;

export function resetFallbackWarning(): void {
  warnedNonAdminFallback = false;
}

/**
 * Fetches the pending apply queue for a project.
 *
 * Tries the admin-scoped apply-queue first to receive admin prompts and AI rules.
 * If the user has a non-admin key (403), falls back to the public summary view of comments.
 */
export async function fetchQueue(
  ctx: ApplyClientContext,
  filter?: QueueFilter,
): Promise<QueueItem[]> {
  return (await fetchQueueShared(ctx, filter)).items;
}

/** Same as `fetchQueue`, plus the AI rules and predefined prompts once (`shared`); items carry refs only. */
export async function fetchQueueShared(
  ctx: ApplyClientContext,
  filter?: QueueFilter,
): Promise<{ shared: SharedBlock; items: QueueItem[] }> {
  const envNum = mapEnvironmentToNumber(filter?.environment);

  // No --status keeps Ready exactly as before; an explicit one is resolved (built-in or custom) and sent as a key.
  const queryParts: string[] = [];
  if (filter?.status === undefined) {
    queryParts.push('status=2');
  } else {
    const resolved = resolveStatus(filter.status, await fetchStatuses(ctx));
    if (!resolved) throw new Error(unknownStatusError(String(filter.status), await fetchStatuses(ctx)));
    queryParts.push(`statusKey=${encodeURIComponent(resolved.key)}`);
  }
  if (envNum !== undefined) queryParts.push(`environment=${envNum}`);
  const qs = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

  const adminQs = `?${[...queryParts, 'shape=shared'].join('&')}`;

  try {
    const res = await api<any>(
      ctx.server,
      `/api/admin/projects/${encodeURIComponent(ctx.project)}/apply-queue${adminQs}`,
      { token: ctx.token },
    );

    const items: any[] = res?.items ?? [];
    const pages: Record<string, ApplyPageDto> = res?.pages ?? {};
    const pageContexts: Record<string, PageContextDto> = res?.pageContexts ?? {};

    const mapped = items.map((item: any): QueueItem => {
      const pageRef = item?.element?.pageRef;
      const page: ApplyPageDto | undefined = pageRef ? pages[pageRef] : undefined;
      const pageContextId = item?.pageContextId;
      const pageContext: PageContextDto | undefined =
        pageContextId !== undefined && pageContextId !== null
          ? pageContexts[String(pageContextId)]
          : undefined;

      const refComments = referencedCommentsOf(item);
      const refProjects = referencedProjectsOf(item);
      return {
        id: item.id,
        number: item.number,
        status: item.status,
        statusKey: item.statusKey ?? null,
        customStatus: item.customStatus ?? null,
        environment: item.environment,
        body: item.body ?? '',
        authorName: item.authorName ?? null,
        authorKind: authorKindOf(item.authorKind),
        createdAt: item.createdAt ?? '',
        element: {
          pageRef: pageRef ?? null,
          selector: item.element?.selector ?? null,
          snapshot: item.element?.snapshot ?? null,
          sourcePath: item.element?.sourcePath ?? null,
          screenshotUrl: item.element?.screenshotUrl ?? null,
          classes: item.element?.classes ?? null,
          computedStyles: item.element?.computedStyles ?? null,
          appliedCssRules: item.element?.appliedCssRules ?? null,
          parent: item.element?.parent ?? null,
        },
        replies: Array.isArray(item.replies)
          ? item.replies.map((r: any) => ({
              id: r.id,
              authorId: r.authorId,
              authorName: r.authorName ?? null,
              body: r.body ?? '',
              createdAt: r.createdAt,
              isAi: Boolean(r.isAi),
              media: normalizeMedia(r.media),
              textSource: typeof r.textSource === 'string' ? r.textSource : null,
            }))
          : [],
        pickedActions: Array.isArray(item.pickedActions)
          ? item.pickedActions.map((pa: any) => ({
              text: String(pa.text ?? ''),
              prompt: String(pa.prompt ?? ''),
            }))
          : [],
        aiRules: Array.isArray(item.aiRules)
          ? item.aiRules.map((r: any) => ({
              title: String(r.title ?? ''),
              prompt: String(r.prompt ?? ''),
              scope: String(r.scope ?? 'Workspace'),
              priority: typeof r.priority === 'number' ? r.priority : 1,
              isPersonal: Boolean(r.isPersonal),
              ...(r.roleName ? { roleName: String(r.roleName) } : {}),
            }))
          : [],
        isBugReport: Boolean(item.isBugReport),
        pageContextId: pageContextId ?? null,
        page,
        pageContext,
        // Server-stamped comment language (R4 translate) and admin-defined fields (R4-01) —
        // both must be copied through or buildApplyPrompt silently omits them.
        language: typeof item.language === 'string' && item.language ? item.language : null,
        media: normalizeMedia(item.media),
        textSource: typeof item.textSource === 'string' ? item.textSource : null,
        customFields: Array.isArray(item.customFields)
          ? item.customFields
              .filter((f: any) => f && typeof f.key === 'string')
              .map((f: any) => ({
                key: String(f.key),
                label: typeof f.label === 'string' ? f.label : String(f.key),
                type: f.type,
                value: typeof f.value === 'string' ? f.value : String(f.value ?? ''),
                suggestedTool: typeof f.suggestedTool === 'string' ? f.suggestedTool : null,
              }))
          : undefined,
        // Mentions (AC-F2): copied through, or the apply prompt and --json silently omit them (QA-BUG-02).
        ...(refComments.length > 0 ? { referencedComments: refComments } : {}),
        ...(refProjects.length > 0 ? { referencedProjects: refProjects } : {}),
      };
    });
    const parts =
      sharedFromApi(res, mapped.length) ??
      sharedFromParts(mapped.map((i) => ({ aiRules: i.aiRules, pickedActions: i.pickedActions })));
    return { shared: parts.shared, items: applyRefs(mapped, parts.refs) };
  } catch (err: any) {
    if (err instanceof ApiError && err.code === 404) throw new ProjectNotFoundError(ctx.project, ctx.workspaceName);
    if (err instanceof ApiError && err.code === 403) {
      if (!warnedNonAdminFallback) {
        console.error('Note: predefined-action prompts need an admin key');
        warnedNonAdminFallback = true;
      }

      const summaryQuery = `view=summary${qs ? `&${qs.slice(1)}` : ''}`;
      let res: any;
      try {
        res = await api<any>(
          ctx.server,
          `/api/projects/${encodeURIComponent(ctx.project)}/comments?${summaryQuery}`,
          { token: ctx.token },
        );
      } catch (fallbackErr) {
        if (fallbackErr instanceof ApiError && fallbackErr.code === 404) {
          throw new ProjectNotFoundError(ctx.project, ctx.workspaceName);
        }
        throw fallbackErr;
      }

      const memberRules = await fetchMemberRules(ctx);
      const items: any[] = res?.items ?? [];
      const mapped = items.map((item: any): QueueItem => ({
        id: item.id,
        number: item.number,
        status: item.status,
        statusKey: item.statusKey ?? null,
        customStatus: item.customStatus ?? null,
        environment: item.environment,
        body: item.body ?? '',
        authorName: item.authorName ?? null,
        authorKind: authorKindOf(item.authorKind),
        createdAt: item.createdAt ?? '',
        element: {
          pageRef: null,
          selector: item.selector ?? null,
          snapshot: item.snapshot ?? null,
          sourcePath: item.sourcePath ?? null,
          screenshotUrl: null,
          classes: null,
          computedStyles: null,
          appliedCssRules: null,
          parent: null,
        },
        replies: [],
        pickedActions: [],
        aiRules: memberRules,
        isBugReport: false,
        pageContextId: null,
        page: item.route ? { route: item.route } : undefined,
        pageContext: undefined,
      }));
      const parts = sharedFromParts(mapped.map((i) => ({ aiRules: i.aiRules, pickedActions: i.pickedActions })));
      return { shared: parts.shared, items: applyRefs(mapped, parts.refs) };
    }
    throw err;
  }
}

function applyRefs(items: QueueItem[], refs: Array<{ aiRuleRefs: string[]; actionIds: string[] }>): QueueItem[] {
  return items.map((item, i) => ({
    ...item,
    aiRules: [],
    aiRuleRefs: refs[i].aiRuleRefs,
    pickedActions: item.pickedActions.map((pa, j) => ({ text: pa.text, prompt: '', id: refs[i].actionIds[j] })),
  }));
}
