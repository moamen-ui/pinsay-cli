import { resolveServer } from '../server.js';
import { findRepoRoot, readConfig, resolveProject } from '../config.js';
import { openBrowser } from '../device-login.js';
import { isInteractive } from '../ui/interactive.js';

export function dashboardUrl(server: string, projectKey?: string): string {
  const base = server.replace(/\/+$/, '');
  return projectKey ? `${base}/comments?project=${encodeURIComponent(projectKey)}` : `${base}/`;
}

export async function openCommand(
  cwd: string,
  options: Record<string, string | boolean>,
): Promise<void> {
  const server = resolveServer();
  const root = await findRepoRoot(cwd);
  const config = await readConfig(root).catch(() => ({}));

  let projectKey: string | undefined;
  if (typeof options['project'] === 'string') {
    projectKey = options['project'];
  } else {
    const resolved = resolveProject(config, cwd, root);
    if (resolved.ok) {
      projectKey = resolved.project.key;
    }
  }

  const url = dashboardUrl(server, projectKey);
  console.log(url);

  if (!options['print'] && isInteractive(options)) {
    openBrowser(url);
  }

  process.exit(0);
}
