import { promises as fs, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Which AI tools a repo uses (SPEC B3). `detectRepoTools` reads only filesystem and env signals — no prompts, no
 * network — and never throws: an unreadable path is "not found". `decideTools` turns the detection plus flags and
 * the saved config into one decision, so `init` asks the multi-select only when it must.
 */

export const TOOL_CATALOGUE = ['claude-code', 'cursor', 'windsurf', 'opencode', 'antigravity', 'other'] as const;

export type RepoTool = (typeof TOOL_CATALOGUE)[number];

/** A folder signal is skipped when it is empty, or when every file inside it (≤4 levels deep) is PinSay's own. */
const MAX_WALK_DEPTH = 4;

interface ToolSignals {
  /** Directory signals in the repo root, subject to the PinSay-only rule. */
  folders: string[];
  /** Plain file signals in the repo root. */
  files: string[];
  env: (env: NodeJS.ProcessEnv) => boolean;
}

const SIGNALS: Record<Exclude<RepoTool, 'other'>, ToolSignals> = {
  'claude-code': {
    folders: ['.claude'],
    files: ['CLAUDE.md'],
    env: (env) => nonEmpty(env.CLAUDECODE) || nonEmpty(env.CLAUDE_CODE_ENTRYPOINT),
  },
  cursor: {
    folders: ['.cursor'],
    files: ['.cursorrules'],
    env: (env) => (env.TERM_PROGRAM ?? '').includes('Cursor'),
  },
  windsurf: {
    folders: ['.windsurf'],
    files: ['.windsurfrules'],
    env: (env) => nonEmpty(env.WINDSURF),
  },
  opencode: {
    folders: ['.opencode'],
    files: ['opencode.json'],
    env: (env) => nonEmpty(env.OPENCODE),
  },
  antigravity: {
    folders: ['.gemini'],
    files: ['GEMINI.md'],
    env: (env) => nonEmpty(env.ANTIGRAVITY_AGENT) || nonEmpty(env.GEMINI_CLI),
  },
};

function nonEmpty(value: string | undefined): boolean {
  return (value ?? '') !== '';
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Files inside `dir`, up to `MAX_WALK_DEPTH` levels deep. Symlink targets are ignored: an entry is counted at its
 * own path, and a symlinked directory is never followed.
 */
async function walkFiles(dir: string, level: number, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (level < MAX_WALK_DEPTH) await walkFiles(path, level + 1, out);
    } else {
      out.push(path);
    }
  }
}

/** True when the folder holds no files at all, or only files with a `pinsay-` path segment (PinSay's own skills). */
async function pinsayOnlyOrEmpty(dir: string): Promise<boolean> {
  const files: string[] = [];
  await walkFiles(dir, 1, files);
  if (files.length === 0) return true;
  return files.every(
    (file) =>
      relative(dir, file)
        .split(/[\\/]/)
        .some((segment) => segment.startsWith('pinsay-')),
  );
}

/** The AI tools this repo signals, in `TOOL_CATALOGUE` order. `other` only when nothing else was found. */
export async function detectRepoTools(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const found: string[] = [];
  for (const tool of TOOL_CATALOGUE) {
    if (tool === 'other') break;
    const signals = SIGNALS[tool];
    let hit = signals.env(env);
    for (const folder of signals.folders) {
      if (hit) break;
      const path = join(root, folder);
      hit = (await isDir(path)) && !(await pinsayOnlyOrEmpty(path));
    }
    for (const file of signals.files) {
      if (hit) break;
      hit = await isFile(join(root, file));
    }
    if (hit) found.push(tool);
  }
  if (
    found.length === 0 &&
    ((await isFile(join(root, 'AGENTS.md'))) ||
      ((await isDir(join(root, '.agents'))) && !(await pinsayOnlyOrEmpty(join(root, '.agents')))))
  ) {
    found.push('other');
  }
  return found;
}

/** The tool decision (SPEC B3): flag wins, then saved config, then one found tool, then ask or fall back. */
export function decideTools(
  found: string[],
  opts: { flagTool?: string; savedTool?: string; interactive: boolean },
): { tools: string[]; ask: boolean; preselected: string[] } {
  if (opts.flagTool) return { tools: [opts.flagTool], ask: false, preselected: [] };
  if (opts.savedTool) return { tools: [opts.savedTool], ask: false, preselected: [] };
  if (found.length === 1) return { tools: found, ask: false, preselected: [] };
  if (opts.interactive) {
    return { tools: [], ask: true, preselected: found.length > 0 ? found : ['claude-code'] };
  }
  return { tools: found.length > 0 ? found : ['other'], ask: false, preselected: [] };
}
