/**
 * Multi-model AI attribution: every model that worked on a comment is recorded on its reply.
 * Mirrors the server's rules (Reply.AiModels): role ∈ planner|implementer|reviewer|null, ≤ 8
 * entries, model id 1–64 chars matching MODEL_RE. `=` and `,` are the flag separators — the model
 * regex forbids both, while `:` is legal inside an id, so it is never split on.
 */
export type AiModelRole = 'planner' | 'implementer' | 'reviewer';
export type AiModelEntry = { model: string; role: AiModelRole | null };

export const MODEL_ROLES: readonly AiModelRole[] = ['planner', 'implementer', 'reviewer'];
export const MAX_AI_MODELS = 8;
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

export class ModelsError extends Error {}

/** Validate + normalize one entry; throws ModelsError with a clear message. */
export function normalizeEntry(raw: { model?: unknown; role?: unknown }): AiModelEntry {
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model || model.length > 64 || !MODEL_RE.test(model)) {
    throw new ModelsError(
      `Invalid model id "${String(raw.model ?? '')}": use the exact model id (1-64 chars, letters/digits and . _ : / + -), e.g. "claude-opus-5-5".`,
    );
  }
  let role: AiModelRole | null = null;
  if (raw.role !== undefined && raw.role !== null && raw.role !== '') {
    const r = String(raw.role).trim().toLowerCase();
    if (!(MODEL_ROLES as readonly string[]).includes(r)) {
      throw new ModelsError(
        `Invalid role "${String(raw.role)}" for model "${model}": expected one of ${MODEL_ROLES.join(', ')}.`,
      );
    }
    role = r as AiModelRole;
  }
  return { model, role };
}

/** Parse `"<id>=<role>,<id>=<role>,..."` (`=role` optional). Empty/blank → []. */
export function parseModelsFlag(value: string): AiModelEntry[] {
  const out: AiModelEntry[] = [];
  for (const part of value.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    out.push(
      eq === -1
        ? normalizeEntry({ model: p })
        : normalizeEntry({ model: p.slice(0, eq), role: p.slice(eq + 1) }),
    );
  }
  return out;
}

/** Dedupe on (model case-insensitive, role), keeping first occurrence; enforce the ≤ 8 cap. */
export function dedupeModels(entries: AiModelEntry[]): AiModelEntry[] {
  const seen = new Set<string>();
  const out: AiModelEntry[] = [];
  for (const e of entries) {
    const key = `${e.model.toLowerCase()}|${e.role ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  if (out.length > MAX_AI_MODELS) {
    throw new ModelsError(`Too many models (${out.length}); at most ${MAX_AI_MODELS} entries are allowed.`);
  }
  return out;
}

/** Merge sources in order (`--models` first, then `--model`), validated + deduped. */
export function mergeModels(...sources: Array<AiModelEntry[] | undefined>): AiModelEntry[] {
  return dedupeModels(sources.flatMap((s) => s ?? []));
}

/** The legacy single `aiModel`: the implementer, else the first entry. */
export function primaryModel(entries: AiModelEntry[]): string | undefined {
  return (entries.find((e) => e.role === 'implementer') ?? entries[0])?.model;
}

/**
 * Resolve the models for a write from `--models` / `--model` (falling back to the
 * PINSAY_AI_MODELS / PINSAY_AI_MODEL env vars). Throws ModelsError on invalid input.
 */
export function resolveModels(
  flags: { models?: string; model?: string },
  env: NodeJS.ProcessEnv = process.env,
): AiModelEntry[] {
  // Explicit flags replace the env fallbacks entirely: a stale PINSAY_AI_MODEL left in someone's
  // shell must never be silently appended to the list the agent just passed.
  const explicit = !!(flags.models || flags.model);
  const modelsStr = explicit ? flags.models : env['PINSAY_AI_MODELS'];
  const modelStr = explicit ? flags.model : env['PINSAY_AI_MODEL'];
  return mergeModels(
    modelsStr ? parseModelsFlag(modelsStr) : undefined,
    modelStr ? [normalizeEntry({ model: modelStr })] : undefined,
  );
}

/** Validate MCP-style args (`models` array + legacy `model`) into entries. */
export function resolveModelsFromArgs(
  args: { models?: unknown; model?: unknown } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AiModelEntry[] {
  const hasArray = args?.models !== undefined && args.models !== null;
  const single = typeof args?.model === 'string' && args.model ? args.model : undefined;
  // Same rule as resolveModels: explicit args replace the env fallbacks entirely.
  if (!hasArray && !single) {
    return resolveModels({}, env);
  }
  let fromArray: AiModelEntry[] | undefined;
  if (hasArray) {
    if (!Array.isArray(args!.models)) throw new ModelsError('models must be an array of {model, role?}.');
    fromArray = args!.models.map((m) =>
      typeof m === 'string' ? normalizeEntry({ model: m }) : normalizeEntry((m ?? {}) as any),
    );
  }
  return mergeModels(fromArray, single ? [normalizeEntry({ model: single })] : undefined);
}

/** Request-body fields for a write: `aiModels` + legacy `aiModel`; both undefined when empty. */
export function modelsBody(entries: AiModelEntry[]): { aiModels?: AiModelEntry[]; aiModel?: string } {
  if (entries.length === 0) return {};
  return { aiModels: entries, aiModel: primaryModel(entries) };
}

export function distinctModelCount(entries: AiModelEntry[]): number {
  return new Set(entries.map((e) => e.model.toLowerCase())).size;
}

export const DELEGATION_WARNING =
  '⚠ Delegation is on for this project, but fewer than 2 distinct models were reported. ' +
  'Pass every model that worked on the item (planner, worker, reviewer) via ' +
  '--models "<planner>=planner,<worker>=implementer,<reviewer>=reviewer".';

/** The stderr warning to print for a --mark, or null. */
export function delegationWarning(delegation: 'auto' | 'off', entries: AiModelEntry[]): string | null {
  return delegation === 'auto' && distinctModelCount(entries) < 2 ? DELEGATION_WARNING : null;
}

export function describeModels(entries: AiModelEntry[]): string {
  return entries.length === 0 ? '(none)' : entries.map((e) => `${e.model}${e.role ? `=${e.role}` : ''}`).join(', ');
}
