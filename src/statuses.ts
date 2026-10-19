import { api } from './api.js';

/** One entry of `GET /api/statuses`. Old servers omit `key`/`isCustom`. */
export type StatusCatalogItem = {
  value?: number;
  name?: string;
  label?: string;
  color?: string;
  order?: number;
  key?: string;
  isCustom?: boolean;
  customStatusId?: number | null;
  countsAs?: number | string | null;
  selectable?: boolean;
};

export type ResolvedStatus = { key: string; status: number; label: string };

/** The four built-in statuses: key → number. The only status map in the CLI. */
export const BUILTIN_KEYS: Record<string, number> = { open: 1, ready: 2, applied: 3, archived: 4 };
const BUILTIN_ALIASES: Record<string, string> = { readytoapply: 'ready', completed: 'applied' };
const BUILTIN_NAMES: Record<number, string> = { 1: 'Open', 2: 'ReadyToApply', 3: 'Applied', 4: 'Archived' };
const BUILTIN_LABELS: Record<number, string> = { 1: 'Open', 2: 'Ready', 3: 'Applied', 4: 'Archived' };
const CUSTOM_STATUS = 5;

const cache = new Map<string, Promise<StatusCatalogItem[]>>();

/** The workspace's status catalog, cached per process. An old or unreachable server yields an empty catalog. */
export function fetchStatuses(client: { server: string; token?: string }): Promise<StatusCatalogItem[]> {
  const id = `${client.server}|${client.token ?? ''}`;
  let hit = cache.get(id);
  if (!hit) {
    hit = api<unknown>(client.server, '/api/statuses', { token: client.token })
      .then((res) => (Array.isArray(res) ? (res as StatusCatalogItem[]) : []))
      .catch(() => []);
    cache.set(id, hit);
  }
  return hit;
}

export function resetStatusCache(): void {
  cache.clear();
}

function builtinKeyFor(norm: string): string | undefined {
  if (norm in BUILTIN_KEYS) return norm;
  if (norm in BUILTIN_ALIASES) return BUILTIN_ALIASES[norm];
  for (const [k, n] of Object.entries(BUILTIN_KEYS)) if (String(n) === norm) return k;
  return undefined;
}

/** Built-in key/alias/number first, then a catalog key, then a catalog label (case-insensitive). */
export function resolveStatus(input: string | number | undefined, catalog: StatusCatalogItem[] = []): ResolvedStatus | undefined {
  const norm = String(input ?? '').trim().toLowerCase();
  if (!norm) return undefined;
  const builtin = builtinKeyFor(norm);
  if (builtin) {
    const status = BUILTIN_KEYS[builtin];
    return { key: builtin, status, label: BUILTIN_LABELS[status] };
  }
  const custom = catalog.filter((c) => c.isCustom !== false && typeof c.key === 'string' && !(c.key in BUILTIN_KEYS));
  const hit =
    custom.find((c) => c.key!.toLowerCase() === norm) ??
    custom.find((c) => typeof c.label === 'string' && c.label.trim().toLowerCase() === norm);
  if (!hit) return undefined;
  return { key: hit.key!, status: CUSTOM_STATUS, label: hit.label ?? hit.key! };
}

type StatusFields = { status?: number | string; statusKey?: string | null; customStatus?: { label?: string } | null };

export function statusLabel(comment: StatusFields, catalog: StatusCatalogItem[] = []): string {
  if (comment.customStatus?.label) return comment.customStatus.label;
  if (comment.statusKey) {
    const hit = catalog.find((c) => c.key === comment.statusKey && c.label);
    if (hit) return hit.label!;
  }
  const n = Number(comment.status);
  if (BUILTIN_NAMES[n]) return BUILTIN_NAMES[n];
  if (n === CUSTOM_STATUS) return 'custom';
  return String(comment.status);
}

export function unknownStatusError(input: string, catalog: StatusCatalogItem[] = []): string {
  const names = Object.keys(BUILTIN_KEYS);
  for (const c of catalog) {
    if (c.isCustom && c.key) names.push(`"${c.label ?? c.key}" (${c.key})`);
  }
  return `Unknown status "${input}". This workspace's statuses: ${names.join(', ')}`;
}

/** `--json` fields added next to `status`. */
export function statusJson(comment: StatusFields, catalog?: StatusCatalogItem[]): { statusKey: string | null; statusLabel: string } {
  const n = Number(comment.status);
  const key = comment.statusKey ?? Object.entries(BUILTIN_KEYS).find(([, v]) => v === n)?.[0] ?? null;
  return { statusKey: key, statusLabel: statusLabel(comment, catalog) };
}
