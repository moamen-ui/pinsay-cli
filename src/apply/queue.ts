import { api, ApiError } from '../api.js';
import type { ApplyClientContext, QueueItem, ApplyPageDto, PageContextDto } from './types.js';

export type QueueFilter = {
  status?: number | string;
  environment?: number | string;
};

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
  const statusNum = filter?.status !== undefined ? mapStatusToNumber(filter.status) : 2;
  const envNum = mapEnvironmentToNumber(filter?.environment);

  const queryParts: string[] = [];
  if (statusNum !== undefined) queryParts.push(`status=${statusNum}`);
  if (envNum !== undefined) queryParts.push(`environment=${envNum}`);
  const qs = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

  try {
    const res = await api<any>(
      ctx.server,
      `/api/admin/projects/${encodeURIComponent(ctx.project)}/apply-queue${qs}`,
      { token: ctx.token },
    );

    const items: any[] = res?.items ?? [];
    const pages: Record<string, ApplyPageDto> = res?.pages ?? {};
    const pageContexts: Record<string, PageContextDto> = res?.pageContexts ?? {};

    return items.map((item: any): QueueItem => {
      const pageRef = item?.element?.pageRef;
      const page: ApplyPageDto | undefined = pageRef ? pages[pageRef] : undefined;
      const pageContextId = item?.pageContextId;
      const pageContext: PageContextDto | undefined =
        pageContextId !== undefined && pageContextId !== null
          ? pageContexts[String(pageContextId)]
          : undefined;

      return {
        id: item.id,
        status: item.status,
        environment: item.environment,
        body: item.body ?? '',
        authorName: item.authorName ?? null,
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
            }))
          : [],
        isBugReport: Boolean(item.isBugReport),
        pageContextId: pageContextId ?? null,
        page,
        pageContext,
        // Server-stamped comment language (R4 translate) and admin-defined fields (R4-01) —
        // both must be copied through or buildApplyPrompt silently omits them.
        language: typeof item.language === 'string' && item.language ? item.language : null,
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
      };
    });
  } catch (err: any) {
    if (err instanceof ApiError && err.code === 403) {
      if (!warnedNonAdminFallback) {
        console.log('Note: predefined-action prompts need an admin key');
        warnedNonAdminFallback = true;
      }

      const summaryQuery = `view=summary${qs ? `&${qs.slice(1)}` : ''}`;
      const res = await api<any>(
        ctx.server,
        `/api/projects/${encodeURIComponent(ctx.project)}/comments?${summaryQuery}`,
        { token: ctx.token },
      );

      const items: any[] = res?.items ?? [];
      return items.map((item: any): QueueItem => ({
        id: item.id,
        status: item.status,
        environment: item.environment,
        body: item.body ?? '',
        authorName: item.authorName ?? null,
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
        aiRules: [],
        isBugReport: false,
        pageContextId: null,
        page: item.route ? { route: item.route } : undefined,
        pageContext: undefined,
      }));
    }
    throw err;
  }
}
