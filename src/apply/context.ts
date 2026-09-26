import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { api } from '../api.js';
import { getBranding } from '../branding.js';
import { readConfig, isMultiProject } from '../config.js';
import { stackFileRelPath } from '../stack/stackfile.js';
import type { ApplyClientContext, ApplyProjectContext, ProjectStack } from './types.js';

export async function loadProjectContext(
  ctx: ApplyClientContext,
): Promise<ApplyProjectContext> {
  // White-label invariant: productName must come from GET /api/branding.
  // Unreachable branding or missing productName triggers a hard exit 1 in getBranding.
  const branding = await getBranding(ctx.server);

  // Stack resolution: read the committable stack file — `.pinsay/stack.json` for a
  // single-project repo, `.pinsay/projects/<key>.stack.json` for one app in a multi-project
  // repo (`ctx.cwd` here is always the repo root, never an app subdirectory).
  let stack: ProjectStack = { frontend: [], backend: null, aiTools: [] };
  let delegation: 'auto' | 'off' = 'auto';
  try {
    const config = await readConfig(ctx.cwd);
    if (config.delegation === 'off') delegation = 'off';
    const relPath = isMultiProject(config) ? stackFileRelPath(ctx.project) : stackFileRelPath();
    const stackRaw = await fs.readFile(join(ctx.cwd, relPath), 'utf8');
    stack = JSON.parse(stackRaw);
  } catch {
    // missing or unreadable stack file is treated as unknown
  }

  // Project name and commitStyle resolution
  let projectName = ctx.project;
  let commitStyle: 'Single' | 'Separate' = 'Single';

  // 1. Try reading capture-config for commitStyle (and fallback name)
  try {
    const captureConfig = await api<any>(
      ctx.server,
      `/api/projects/${encodeURIComponent(ctx.project)}/capture-config`,
      { token: ctx.token },
    );
    if (captureConfig?.name) {
      projectName = captureConfig.name;
    }
    const cs = captureConfig?.commitStyle;
    if (cs === 2 || cs === 'Separate') {
      commitStyle = 'Separate';
    } else {
      commitStyle = 'Single';
    }
  } catch {
    // Capture config might fail for non-auth or missing project
  }

  // 2. Try admin projects list to find official project name
  if (ctx.token) {
    try {
      const projects = await api<any[]>(ctx.server, '/api/admin/projects', {
        token: ctx.token,
      });
      if (Array.isArray(projects)) {
        const match = projects.find((p) => p.key === ctx.project);
        if (match?.name) {
          projectName = match.name;
        }
      }
    } catch {
      // Non-admin token returns 403; preserve projectName from capture-config or key
    }
  }

  return {
    productName: branding.productName,
    projectName,
    projectKey: ctx.project,
    commitStyle,
    delegation,
    stack,
  };
}
