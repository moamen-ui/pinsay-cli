import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import type { DesignBlock, DesignTokens, LibraryInfo } from './design.js';

export type StackData = {
  frontend?: string[];
  backend?: string[] | null;
  aiTools?: string[];
  aiTool?: string;
  design?: DesignBlock;
  [key: string]: any;
};

export type StackRequestBody = {
  frontend?: string[];
  backend?: string[] | null;
  aiTools?: string[];
  aiTool?: string;
};

/**
 * Strips the local-only `design` block (and any other non-server fields)
 * so that it is NEVER sent in POST /api/projects/{key}/stack.
 */
export function buildRequestBody(stack: StackData): StackRequestBody {
  const body: StackRequestBody = {};
  if (stack.frontend !== undefined) body.frontend = stack.frontend;
  if (stack.backend !== undefined) body.backend = stack.backend;
  if (stack.aiTools !== undefined) body.aiTools = stack.aiTools;
  if (stack.aiTool !== undefined) body.aiTool = stack.aiTool;
  return body;
}

/**
 * Where a project's stack file lives, relative to the repo root: `.pinsay/stack.json` for a
 * single-project repo, `.pinsay/projects/<key>.stack.json` for one app inside a multi-project
 * repo. Exported so callers (doctor's per-project checks, in particular) can name the right file
 * without duplicating this rule.
 */
export function stackFileRelPath(projectKey?: string): string {
  return projectKey ? join('.pinsay', 'projects', `${projectKey}.stack.json`) : join('.pinsay', 'stack.json');
}

/**
 * Reads a project's stack file if present. Returns null if missing or unparseable.
 *
 * `projectKey` names the app in a multi-project repo (see `stackFileRelPath`); omitted, this reads
 * the single-project `.pinsay/stack.json` exactly as before.
 */
export async function readStackFile(cwd: string, projectKey?: string): Promise<StackData | null> {
  try {
    const raw = await fs.readFile(join(cwd, stackFileRelPath(projectKey)), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Merges server response (or existing frontend/backend/aiTools) with local design block.
 *
 * frontend/backend: what THIS machine just detected wins whenever it found anything — the server's
 * copy may be a stale record from before a framework migration (or from a teammate's checkout), and
 * `init` is the one place with a fresh, local reading. The server value is only the fallback for a
 * run that detected nothing (repo root without a package.json). aiTools always come from the server,
 * which is the union across every tool that has ever touched the project.
 */
export function mergeStack(
  existing: StackData | null,
  serverResponse: any,
  designBlock?: DesignBlock | null,
): StackData {
  const base = serverResponse || existing || {};
  const localFrontend = Array.isArray(existing?.frontend) && existing!.frontend!.length > 0 ? existing!.frontend! : null;
  const localBackend = Array.isArray(existing?.backend) && existing!.backend!.length > 0 ? existing!.backend! : null;
  const frontend = localFrontend ?? serverResponse?.frontend ?? existing?.frontend ?? [];
  const backend = localBackend ?? (serverResponse?.backend !== undefined ? serverResponse.backend : (existing?.backend ?? null));

  // aiTools merge
  let aiTools: string[] = [];
  if (Array.isArray(serverResponse?.aiTools)) {
    aiTools = [...serverResponse.aiTools];
  } else if (Array.isArray(existing?.aiTools)) {
    aiTools = [...existing.aiTools];
  } else if (base.aiTool) {
    aiTools = [base.aiTool];
  }

  const result: StackData = {
    frontend: Array.isArray(frontend) ? [...frontend] : frontend,
    backend: Array.isArray(backend) ? [...backend] : backend,
    aiTools: Array.from(new Set(aiTools)),
  };

  if (designBlock !== undefined) {
    if (designBlock !== null) {
      result.design = designBlock;
    }
  } else if (existing?.design) {
    result.design = existing.design;
  }

  return result;
}

/**
 * Formats stack.json according to the canonical form:
 * - fixed key order: frontend, backend, aiTools, design
 * - inside design: version, libraries, tokens, guidance
 * - inside tokens: tailwind, cssVars, scss, theme, angularMaterial (present keys only, in order)
 * - arrays sorted alphabetically unless semantic (libraries by name)
 * - 2-space indent, \n line endings, single trailing newline.
 */
export function formatStackJson(stack: StackData): string {
  const canonical: Record<string, any> = {};

  if (stack.frontend !== undefined) {
    canonical.frontend = Array.isArray(stack.frontend) ? [...stack.frontend].sort() : stack.frontend;
  }
  if (stack.backend !== undefined) {
    canonical.backend = Array.isArray(stack.backend) ? [...stack.backend].sort() : stack.backend;
  }
  if (stack.aiTools !== undefined) {
    canonical.aiTools = Array.isArray(stack.aiTools) ? [...stack.aiTools].sort() : stack.aiTools;
  }

  if (stack.design !== undefined) {
    const d = stack.design;
    const sortedLibraries: LibraryInfo[] = [...(d.libraries ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    const tokens: DesignTokens = d.tokens ?? {};
    const canonicalTokens: Record<string, any> = {};

    if (tokens.tailwind) {
      const tw = tokens.tailwind;
      const twObj: Record<string, any> = { config: tw.config };
      if (tw.colors && tw.colors.length > 0) twObj.colors = [...tw.colors].sort();
      if (tw.radius && tw.radius.length > 0) twObj.radius = [...tw.radius].sort();
      if (tw.fontFamily && tw.fontFamily.length > 0) twObj.fontFamily = [...tw.fontFamily].sort();
      if (tw.spacingCount !== undefined) twObj.spacingCount = tw.spacingCount;
      canonicalTokens.tailwind = twObj;
    }

    if (tokens.cssVars) {
      const cv = tokens.cssVars;
      canonicalTokens.cssVars = {
        files: [...(cv.files ?? [])].sort(),
        names: [...(cv.names ?? [])].sort(),
      };
    }

    if (tokens.scss) {
      const scss = tokens.scss;
      canonicalTokens.scss = {
        files: [...(scss.files ?? [])].sort(),
        names: [...(scss.names ?? [])].sort(),
      };
    }

    if (tokens.theme) {
      const th = tokens.theme;
      const thObj: Record<string, any> = {};
      if (th.files) thObj.files = [...th.files].sort();
      if (th.colors) thObj.colors = [...th.colors].sort();
      canonicalTokens.theme = thObj;
    }

    if (tokens.angularMaterial) {
      const am = tokens.angularMaterial;
      canonicalTokens.angularMaterial = {
        palettes: [...(am.palettes ?? [])].sort(),
      };
    }

    canonical.design = {
      version: d.version ?? 1,
      libraries: sortedLibraries,
      tokens: canonicalTokens,
      guidance: d.guidance ?? '',
    };
  }

  return JSON.stringify(canonical, null, 2) + '\n';
}

/**
 * Writes a project's stack file atomically. See `stackFileRelPath` for which file `projectKey`
 * selects.
 */
export async function writeStackFile(cwd: string, stack: StackData, projectKey?: string): Promise<void> {
  const relPath = stackFileRelPath(projectKey);
  const dir = join(cwd, dirname(relPath));
  await fs.mkdir(dir, { recursive: true });

  const targetPath = join(cwd, relPath);
  const tempPath = join(dir, `${projectKey ?? 'stack'}.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);

  const content = formatStackJson(stack);
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, targetPath);
}
