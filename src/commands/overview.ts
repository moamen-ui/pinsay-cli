import { findRepoRoot, readConfig, listProjects } from '../config.js';
import { resolveServer } from '../server.js';
import { resolveApiKey, type ApiKeySource } from '../credentials.js';
import { resolveToken } from '../auth.js';
import { api } from '../api.js';
import { fetchQueue } from '../apply/queue.js';
import { exitWithError, isOutage } from '../errors.js';
import { sym } from '../ui/style.js';

export async function overviewCommand(
  cwd: string,
  options: Record<string, string | boolean>,
): Promise<void> {
  const json = options['json'] === true;
  const root = await findRepoRoot(cwd);
  const config = await readConfig(root).catch(() => ({}));
  const server = resolveServer();

  const { key, source } = await resolveApiKey(root, server);
  if (!key) {
    exitWithError(3, `Not signed in ${sym.arrow} npx pinsay-cli login`, json);
  }

  const token = await resolveToken(server, root, key);
  if (!token) {
    exitWithError(
      3,
      'Your saved key no longer works (expired or revoked). Sign in again: npx pinsay-cli login',
      json,
    );
  }

  const me = await api<any>(server, '/api/auth/me', { token });
  const displayName = me?.displayName || me?.email || 'User';
  const email = me?.email || '';

  const projects = listProjects(config);

  let projectNames: Record<string, string> = {};
  if (projects.length > 0) {
    try {
      const rows = await api<any[]>(server, '/api/admin/projects', { token });
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row?.key) {
            projectNames[row.key] = String(row.name ?? row.key);
          }
        }
      }
    } catch (err) {
      if (isOutage(err)) throw err;
      // Fall back to key if GET /api/admin/projects fails
    }
  }

  const projectsWithPending = [];
  for (const p of projects) {
    const name = projectNames[p.key] || p.key;
    const items = await fetchQueue(
      { server, project: p.key, token, apiKey: key, cwd: root },
      {},
    );
    projectsWithPending.push({
      key: p.key,
      name,
      pending: items.length,
    });
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          server,
          account: { displayName, email },
          keySource: source,
          projects: projectsWithPending,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  let sourceDesc = 'key from this repo';
  if (source === 'env') {
    sourceDesc = 'key from PINSAY_API_KEY';
  } else if (source === 'global') {
    sourceDesc = 'key from this machine';
  }

  console.log(`  Signed in   ${displayName} (${email}) ${sym.dot} ${sourceDesc}`);

  if (projectsWithPending.length === 0) {
    console.log(`  Project     none in this folder ${sym.arrow} npx pinsay-cli init`);
  } else if (projectsWithPending.length === 1) {
    const p = projectsWithPending[0];
    console.log(`  Project     ${p.name} (${p.key})`);
    if (p.pending === 0) {
      console.log('  Pending     nothing to apply');
    } else {
      const label = p.pending === 1 ? 'comment' : 'comments';
      console.log(`  Pending     ${p.pending} ${label} to apply ${sym.arrow} npx pinsay-cli apply`);
    }
  } else {
    for (let i = 0; i < projectsWithPending.length; i++) {
      const p = projectsWithPending[i];
      if (i === 0) {
        console.log(`  Project     ${p.name} (${p.key})`);
      } else {
        console.log(`              ${p.name} (${p.key})`);
      }
    }
    for (const p of projectsWithPending) {
      if (p.pending === 0) {
        console.log(`  Pending     ${p.key}: nothing to apply`);
      } else {
        const label = p.pending === 1 ? 'comment' : 'comments';
        console.log(
          `  Pending     ${p.key}: ${p.pending} ${label} to apply ${sym.arrow} npx pinsay-cli apply --project ${p.key}`,
        );
      }
    }
  }

  process.exit(0);
}
