import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_INCLUDE_EXTENSIONS = ['.jsx', '.tsx', '.vue'];

/** Directories never worth walking — build output, dependencies, VCS internals. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', '.nuxt', 'coverage', '.pinsay']);

function gitRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return cwd;
  }
}

const toPosix = (p: string): string => p.split('\\').join('/');

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, out);
    } else if (DEFAULT_INCLUDE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `pinsay map --from-source` — rebuild .pinsay/manifest.json without running a build.
 *
 * The manifest is normally a by-product of the Vite plugin, which means it only exists where
 * someone has run a build. Two situations leave a developer without one and needing it now: a
 * fresh clone (it is gitignored — it is generated, and committing it would churn every diff), and
 * a rename that made every stamped hash stale. `apply` and `doctor` deliberately do NOT run a
 * build to fix that — a build is slow and has side effects nobody asked for — so this command runs
 * the same visitor over the same files, offline, and writes the same file.
 *
 * It reads sources only. Nothing is stamped on disk; the output is the map, not the markup.
 */
/**
 * Compares an existing manifest JSON string with the newly generated manifest content.
 * Returns true if both represent the same manifest entries, ignoring formatting
 * or key order differences.
 */
export function isSameManifest(currentRaw: string, nextRaw: string): boolean {
  if (currentRaw === nextRaw) return true;
  if (currentRaw.trim() === nextRaw.trim()) return true;
  try {
    const curr = JSON.parse(currentRaw);
    const next = JSON.parse(nextRaw);
    const currEntries = curr.entries ?? curr.components ?? curr;
    const nextEntries = next.entries ?? next.components ?? next;
    const currKeys = Object.keys(currEntries);
    const nextKeys = Object.keys(nextEntries);
    if (currKeys.length !== nextKeys.length) return false;
    for (const key of nextKeys) {
      const c = currEntries[key];
      const n = nextEntries[key];
      if (!c) return false;
      const cComp = c.component ?? c.componentName ?? c.export ?? null;
      const nComp = n.component ?? n.componentName ?? n.export ?? null;
      if (c.path !== n.path || cComp !== nComp) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuilds `.pinsay/manifest.json` from the source tree, without a build.
 *
 * Split out of `mapCommand` so `doctor` and `apply` can regenerate a missing or stale manifest
 * themselves instead of printing "run pinsay map --from-source" at a developer who then has to run
 * it — which was the plan's whole point and the part that never got wired up. It returns a result
 * rather than exiting, because a command that calls process.exit cannot be reused by anything.
 *
 * Rotation: when `.pinsay/manifest.json` already exists and the newly built manifest differs from
 * it, the existing manifest is rotated to `.pinsay/manifest.prev.json`. An unchanged rebuild
 * preserves `.pinsay/manifest.prev.json` so that stale hash history is not clobbered.
 */
export async function buildManifest(
  cwd: string,
  opts: { quiet?: boolean } = {},
): Promise<{ ok: boolean; count: number; scanned: number; failed: number; reason?: string }> {
  const root = gitRoot(cwd);
  const files = await walk(cwd);

  if (files.length === 0) {
    return { ok: false, count: 0, scanned: 0, failed: 0, reason: `no .jsx/.tsx/.vue files under ${cwd}` };
  }

  const { stampSource } = await import('../vite/transform.js');
  const { addToManifest } = await import('../vite/hash.js');

  const manifest: Record<string, { path: string; export: string }> = {};
  let scanned = 0;
  let failed = 0;

  for (const file of files) {
    const relPath = toPosix(relative(root, file));
    let code: string;
    try {
      code = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      // The attribute name is irrelevant here — nothing is written back. Only `components` is used.
      const result = await stampSource(code, relPath, 'data-component-source');
      for (const [hash, entry] of Object.entries(result.components)) {
        addToManifest(manifest, hash, entry);
      }
      scanned++;
    } catch (err: any) {
      // One unparseable file must not cost the developer the whole map — the other entries are
      // still correct and still useful. Say which file, so it can be looked at.
      failed++;
      if (!opts.quiet) console.error(`  skipped ${relPath}: ${err?.message ?? err}`);
    }
  }

  const target = resolve(root, '.pinsay/manifest.json');
  await fs.mkdir(join(root, '.pinsay'), { recursive: true });

  const entries = Object.fromEntries(
    Object.entries(manifest)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hash, entry]) => [hash, { path: entry.path, component: entry.export }]),
  );

  const nextContent = JSON.stringify({ version: 1, entries }, null, 2) + '\n';

  let currentContent: string | null = null;
  try {
    currentContent = await fs.readFile(target, 'utf8');
  } catch {
    currentContent = null;
  }

  // Rotate only when the manifest actually changes: manifest.prev.json is what resolves a stale
  // hash to the name it used to have (the whole value of this command after a rename). If the
  // manifest did not change, rotating would copy manifest.json over manifest.prev.json and
  // clobber history, turning stale hashes into unknown ones on subsequent runs.
  // Never merge the two — a merged file would answer for a component that no longer exists as
  // though it still did.
  const prev = target.replace(/\.json$/, '.prev.json');
  if (currentContent !== null && !isSameManifest(currentContent, nextContent)) {
    await fs.copyFile(target, prev);
  }

  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, nextContent, 'utf8');
  await fs.rename(tmp, target);

  const count = Object.keys(entries).length;
  if (!opts.quiet) {
    console.log(
      `Mapped ${count} component${count === 1 ? '' : 's'} from ${scanned} file${scanned === 1 ? '' : 's'} → .pinsay/manifest.json` +
        (failed ? ` (${failed} skipped)` : ''),
    );
  }
  return { ok: true, count, scanned, failed };
}

export async function mapCommand(
  cwd: string,
  parsed: Record<string, string | boolean>,
): Promise<void> {
  if (parsed['from-source'] !== true) {
    console.error('Usage: pinsay map --from-source');
    process.exit(2);
  }

  const result = await buildManifest(cwd);
  if (!result.ok) {
    console.error(result.reason ?? 'could not build the manifest');
    process.exit(2);
  }
  process.exit(0);
}
