import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ResolvedSource =
  | { kind: 'manifest'; path: string; component: string | null }
  /**
   * The hash is not in the current manifest but WAS in the previous one — the component was
   * renamed or moved since the comment was captured. Carrying the old name as a search hint is
   * the difference between a dead end and a one-grep lead, so this is deliberately not folded
   * into `unknown`.
   */
  | { kind: 'stale'; hash: string; hint: string }
  | { kind: 'unknown'; path: null; component: null };

/** One manifest entry, in any shape a checkout might still hold. */
function entryOf(json: any, hash: string): { path?: string; component?: string; export?: string; componentName?: string } | undefined {
  if (!json || typeof json !== 'object') return undefined;
  // `entries` is the documented shape. `components` and the bare hash→entry map are older forms
  // that may still be on disk; a resolver that only knew the newest would report "unknown" for a
  // manifest that is merely from a previous CLI.
  return json.entries?.[hash] ?? json.components?.[hash] ?? json[hash];
}

function normalise(entry: any): { path: string; component: string } | null {
  if (!entry || typeof entry.path !== 'string') return null;
  return {
    path: entry.path,
    // The plugin wrote `export`, the spec says `component`, and an older resolver read
    // `componentName`. Accept all three rather than return a null name for a manifest we wrote.
    component: entry.component ?? entry.componentName ?? entry.export ?? null,
  };
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A corrupt manifest is not worth failing a read-only command over — the caller degrades to
    // `unknown`, which is what it would do without a manifest at all.
    return null;
  }
}

/**
 * Turns a comment's `sourcePath` hash into the file and component that produced it.
 *
 * The hash is stamped into the DOM at build time and captured with the comment, so it is often the
 * only durable link between "the thing the stakeholder clicked" and a source file — production
 * builds strip the framework metadata that would otherwise answer this.
 *
 * Three outcomes, deliberately distinct:
 *   manifest — resolved against the current build.
 *   stale    — not in the current manifest but present in manifest.prev.json, i.e. the component
 *              was renamed or moved since. The old name is still the best lead a developer has,
 *              and saying "unknown" would throw it away.
 *   unknown  — no manifest, or a hash neither file knows.
 */
export function resolveSource(cwd: string, hash: string | null | undefined): ResolvedSource {
  const miss: ResolvedSource = { kind: 'unknown', path: null, component: null };
  if (!hash || !/^[0-9a-f]{8}$/.test(hash)) return miss;

  const manifestPath = join(cwd, '.pinsay', 'manifest.json');
  const current = normalise(entryOf(readJson(manifestPath), hash));
  if (current) return { kind: 'manifest', path: current.path, component: current.component };


  const prevPath = join(cwd, '.pinsay', 'manifest.prev.json');
  const previous = normalise(entryOf(readJson(prevPath), hash));
  if (previous) {
    return {
      kind: 'stale',
      hash,
      hint: `search for ${JSON.stringify(previous.component ?? previous.path)}`,
    };
  }

  return miss;
}
