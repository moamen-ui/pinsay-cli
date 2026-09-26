import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** One app `init` can offer to set up as its own PinSay project, discovered in an Nx workspace. */
export interface DiscoveredApp {
  /** Display name — the Nx project's `name`, falling back to the directory name when absent. */
  name: string;
  /** Repo-relative directory, e.g. `apps/profile` — the `path` a `ProjectEntry` records. */
  dir: string;
  hasProjectJson: boolean;
  /** Set when the app was found by convention rather than by `project.json` — surfaced so the
   *  picker can flag it, since nothing has actually confirmed it is a PinSay-injectable app. */
  note?: string;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/** An Nx workspace is one with `nx.json` at its root. */
export async function isNxWorkspace(root: string): Promise<boolean> {
  return fileExists(join(root, 'nx.json'));
}

/**
 * Every app `apps/*` in an Nx workspace `init` can offer as its own PinSay project:
 * - a `project.json` with `projectType: "application"` (libraries are excluded), name from its
 *   `name` field or the directory name;
 * - OR, lacking a `project.json` entirely, a directory that still looks like a static app — it has
 *   `src/index.html` or `index.html` — reported with `note: 'no project.json'` since nothing here
 *   confirms it is meant to be one.
 *
 * Read-only: never writes anything. `root` is the repo root (where `nx.json` lives), not `cwd`.
 */
export async function discoverNxApps(root: string): Promise<DiscoveredApp[]> {
  const appsDir = join(root, 'apps');
  let entries;
  try {
    entries = await fs.readdir(appsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: DiscoveredApp[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirRel = `apps/${entry.name}`;
    const projectJson = await readJson(join(appsDir, entry.name, 'project.json'));

    if (projectJson) {
      if (projectJson.projectType === 'application') {
        results.push({ name: projectJson.name || entry.name, dir: dirRel, hasProjectJson: true });
      }
      // Any other projectType (library, …) is deliberately excluded.
      continue;
    }

    const hasIndexHtml =
      (await fileExists(join(appsDir, entry.name, 'src', 'index.html'))) ||
      (await fileExists(join(appsDir, entry.name, 'index.html')));
    if (hasIndexHtml) {
      results.push({ name: entry.name, dir: dirRel, hasProjectJson: false, note: 'no project.json' });
    }
  }

  return results;
}
