import { api } from '../api.js';
import type { AiRuleApplyDto, ApplyClientContext } from './types.js';

/**
 * The rules a member's own agent follows, from the read-only endpoint every member has
 * (GET /api/ai-rules/project/{key}): the workspace's and project's admin rules and the rules of
 * the caller's role. Used when the admin apply-queue is refused (non-admin key). Personal rules
 * follow a comment's author, so they are not included here. Any error → no rules.
 */
export async function fetchMemberRules(ctx: Pick<ApplyClientContext, 'server' | 'project' | 'token'>): Promise<AiRuleApplyDto[]> {
  try {
    const res = await api<any>(ctx.server, `/api/ai-rules/project/${encodeURIComponent(ctx.project)}`, { token: ctx.token });
    const admin: AiRuleApplyDto[] = (Array.isArray(res?.adminRules) ? res.adminRules : [])
      .filter((r: any) => r?.isActive !== false)
      .map((r: any) => ({
        title: String(r.title ?? ''),
        prompt: String(r.prompt ?? ''),
        scope: r.projectId == null ? 'Workspace' : 'Project',
        priority: r.projectId == null ? 1 : 2,
        isPersonal: false,
      }));
    const role: AiRuleApplyDto[] = (Array.isArray(res?.roleRules) ? res.roleRules : [])
      .filter((r: any) => r?.isActive !== false)
      .map((r: any) => ({
        title: String(r.title ?? ''),
        prompt: String(r.prompt ?? ''),
        scope: 'Role',
        priority: 3,
        isPersonal: false,
        roleName: r.roleName ?? res.roleName ?? null,
      }));
    return [...admin, ...role];
  } catch {
    return [];
  }
}
