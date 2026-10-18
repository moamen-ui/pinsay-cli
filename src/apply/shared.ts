import { createHash } from 'node:crypto';
import type { AiRuleApplyDto } from './types.js';

export type SharedRule = {
  id: string;
  title: string;
  prompt: string;
  scope: string;
  priority: number;
  roleName: string | null;
  appliesTo: 'all' | 'author';
};
export type SharedPrompt = { id: string; text: string; prompt: string };
export type SharedBlock = { aiRules: SharedRule[]; prompts: SharedPrompt[] };
export type SharedParts = { shared: SharedBlock; refs: Array<{ aiRuleRefs: string[]; actionIds: string[] }> };

/** The API's `CommentService.PromptRef`: `p_` + first 10 hex of sha256(text NUL prompt). */
export function promptRef(text: string, prompt: string): string {
  return 'p_' + createHash('sha256').update(`${text}\u0000${prompt}`).digest('hex').slice(0, 10);
}

export function sortRules(rules: AiRuleApplyDto[]): AiRuleApplyDto[] {
  const scopeOrder: Record<string, number> = {
    workspace: 1,
    project: 2,
    role: 3,
    personal: 4,
  };

  return [...rules]
    .map((r, i): [AiRuleApplyDto, number] => [r, i])
    .sort(([a, ia], [b, ib]) => {
      const pA = a.priority ?? scopeOrder[a.scope.toLowerCase()] ?? 2;
      const pB = b.priority ?? scopeOrder[b.scope.toLowerCase()] ?? 2;
      if (pA !== pB) return pA - pB;
      return ia - ib;
    })
    .map(([r]) => r);
}

function ruleKey(r: AiRuleApplyDto): string {
  return JSON.stringify([r.scope, r.title, r.prompt, r.roleName ?? null]);
}

function toSharedRule(id: string, r: AiRuleApplyDto): SharedRule {
  return {
    id,
    title: r.title,
    prompt: r.prompt,
    scope: r.scope,
    priority: r.priority,
    roleName: r.roleName ?? null,
    appliesTo: r.isPersonal ? 'author' : 'all',
  };
}

export function sharedFromParts(
  perItem: Array<{ aiRules: AiRuleApplyDto[]; pickedActions: { text: string; prompt: string }[] }>,
  extraRules: AiRuleApplyDto[] = [],
): SharedParts {
  const common = new Map<string, AiRuleApplyDto>();
  for (const r of [...extraRules, ...perItem.flatMap((i) => i.aiRules)]) {
    if (!r.isPersonal && !common.has(ruleKey(r))) common.set(ruleKey(r), r);
  }
  const ids = new Map<string, string>();
  const rules: SharedRule[] = [];
  for (const r of sortRules(Array.from(common.values()))) {
    const id = `r${rules.length + 1}`;
    ids.set(ruleKey(r), id);
    rules.push(toSharedRule(id, r));
  }
  for (const item of perItem) {
    for (const r of item.aiRules) {
      if (!r.isPersonal || ids.has(ruleKey(r))) continue;
      const id = `r${rules.length + 1}`;
      ids.set(ruleKey(r), id);
      rules.push(toSharedRule(id, r));
    }
  }

  const prompts = new Map<string, SharedPrompt>();
  const refs = perItem.map((item) => ({
    aiRuleRefs: item.aiRules.filter((r) => r.isPersonal).map((r) => ids.get(ruleKey(r)) as string),
    actionIds: item.pickedActions.map((pa) => {
      const id = promptRef(pa.text, pa.prompt);
      if (!prompts.has(id)) prompts.set(id, { id, text: pa.text, prompt: pa.prompt });
      return id;
    }),
  }));
  return { shared: { aiRules: rules, prompts: Array.from(prompts.values()) }, refs };
}

export function sharedFromApi(res: any, itemCount: number): SharedParts | null {
  const dict = res?.aiRules;
  if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) return null;
  const num = (id: string): number => Number(id.replace(/^r/, ''));
  const aiRules = Object.entries<any>(dict)
    .sort(([a], [b]) => num(a) - num(b))
    .map(([id, r]) =>
      toSharedRule(id, {
        title: String(r?.title ?? ''),
        prompt: String(r?.prompt ?? ''),
        scope: String(r?.scope ?? 'Workspace'),
        priority: typeof r?.priority === 'number' ? r.priority : 1,
        isPersonal: Boolean(r?.isPersonal),
        roleName: r?.roleName ? String(r.roleName) : null,
      }),
    );
  const prompts = Object.entries<any>(res.prompts ?? {}).map(([id, p]) => ({
    id,
    text: String(p?.text ?? ''),
    prompt: String(p?.prompt ?? ''),
  }));
  const refs = Array.from({ length: itemCount }, (_, i) => {
    const item = res?.items?.[i];
    const actions: any[] = Array.isArray(item?.pickedActions) ? item.pickedActions : [];
    return {
      aiRuleRefs: Array.isArray(item?.aiRuleRefs) ? item.aiRuleRefs.map(String) : [],
      actionIds: actions.map((pa) =>
        typeof pa?.ref === 'string' ? pa.ref : promptRef(String(pa?.text ?? ''), String(pa?.prompt ?? '')),
      ),
    };
  });
  return { shared: { aiRules, prompts }, refs };
}

export function withExtraRules(shared: SharedBlock, extra: AiRuleApplyDto[] = []): SharedBlock {
  const known = new Set(shared.aiRules.map((r) => ruleKey({ ...r, isPersonal: false })));
  const aiRules = [...shared.aiRules];
  for (const r of extra) {
    if (known.has(ruleKey(r))) continue;
    known.add(ruleKey(r));
    aiRules.push(toSharedRule(`r${aiRules.length + 1}`, r));
  }
  return { aiRules, prompts: shared.prompts };
}
