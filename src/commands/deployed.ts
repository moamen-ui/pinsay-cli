import { execFileSync } from 'node:child_process';
import { api, ApiError } from '../api.js';
import { getClient } from './comments.js';
import { findRepoRoot, readConfig, resolveProject, listProjects } from '../config.js';

/**
 * Is `ancestor` contained in `sha`?
 *
 * This is the question the server cannot answer — it has no clone. Answering it where the
 * repository actually is, and sending the server a plain list of shas, keeps the server ignorant
 * of git entirely.
 */
function contains(cwd: string, ancestor: string, sha: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, sha], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    // Non-zero means "not an ancestor", but also "unknown object" — a commit that was rebased away
    // or never fetched. Both are correctly "not in this build".
    return false;
  }
}

function resolveSha(cwd: string, requested?: string): string | null {
  try {
    const target = requested && requested.trim() ? requested.trim() : 'HEAD';
    // stderr piped, not inherited: git's own "ambiguous argument" text is noise next to the
    // message below, and seeing both makes the CLI look like it failed twice.
    return execFileSync('git', ['rev-parse', target], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * `pinsay status --deployed [sha]` — tell the server which comments this build carries live.
 *
 * Why the CLI owns this rather than the widget: pinsay-init.md recommends shipping production
 * WITHOUT the widget, so the widget's beacon is absent exactly where "is it live yet?" matters
 * most. The CLI has the repository, so it can answer for any deployed sha, from CI or by hand.
 */
async function reportBuildFor(
  server: string,
  token: string | undefined,
  cwd: string,
  project: string,
  sha: string,
): Promise<number> {
  // Applied but not yet deployed. Anything already deployed is skipped: DeployedAt is write-once
  // server-side, so re-sending it would be noise rather than a correction.
  let applied: any[] = [];
  try {
    const res = await api<any>(server, `/api/projects/${project}/comments?status=3&pageSize=200`, { token });
    applied = res?.items ?? res ?? [];
  } catch (err: any) {
    // DB-18: `deployed` runs unattended in customers' CI — a paused/scheduled-for-deletion
    // workspace must never fail their build, so this is a warning, not an error (exit 2 is
    // reserved for `apply`/`apply --plan`/`apply --mark`; the caller still exits 0).
    if (err instanceof ApiError && err.code === 423) {
      // DB-18 NIT: print the server's own message — it distinguishes "paused" from "scheduled for
      // deletion", which a hard-coded "paused" string here would flatten into a misleading label.
      console.warn(`PinSay: ${err.message || 'workspace is paused'} — build not reported.`);
      return 0;
    }
    console.error(`[${project}] Could not read applied comments: ${err?.message ?? err}`);
    return 0;
  }

  const candidates = applied.filter((c) => c?.commitSha && !c?.deployedAt);
  const containedShas = candidates
    .filter((c) => contains(cwd, c.commitSha, sha))
    .map((c) => c.commitSha as string);

  // Reported even when nothing matched: the build itself is a fact worth recording, and a repeat
  // report is explicitly cheap (FirstSeen false, no ids).
  const unique = [...new Set(containedShas)];

  try {
    const result = await api<any>(server, `/api/projects/${project}/builds`, {
      method: 'POST',
      body: { sha, containsCommitShas: unique },
      token,
    });
    return result?.deployedCommentIds?.length ?? 0;
  } catch (err: any) {
    if (err instanceof ApiError && err.code === 423) {
      console.warn(`PinSay: ${err.message || 'workspace is paused'} — build not reported.`);
      return 0;
    }
    console.error(`[${project}] Could not report the build: ${err?.message ?? err}`);
    return 0;
  }
}

/**
 * `pinsay status --deployed [sha]` — tell the server which comments this build carries live.
 *
 * Why the CLI owns this rather than the widget: pinsay-init.md recommends shipping production
 * WITHOUT the widget, so the widget's beacon is absent exactly where "is it live yet?" matters
 * most. The CLI has the repository, so it can answer for any deployed sha, from CI or by hand.
 *
 * In a multi-project repo, `--project` (or cwd) picks one app; without either, every configured
 * project is reported against the same build sha — one deploy usually ships every app at once.
 */
export async function deployedCommand(
  cwd: string,
  parsed: Record<string, string | boolean>,
): Promise<void> {
  const root = await findRepoRoot(cwd);
  const config = await readConfig(root);
  const flag = typeof parsed['project'] === 'string' ? parsed['project'] : undefined;
  const resolved = resolveProject(config, cwd, root, flag);

  const requested = typeof parsed['deployed'] === 'string' ? parsed['deployed'] : undefined;
  const sha = resolveSha(cwd, requested);
  if (!sha) {
    console.error(
      requested
        ? `${requested} is not a commit in this repository.`
        : 'Could not read HEAD — run this inside the deployed repository.',
    );
    process.exit(2);
  }

  if (resolved.ok) {
    const { server, token } = await getClient(cwd, parsed, { requireProject: true });
    const marked = await reportBuildFor(server, token, cwd, resolved.project.key, sha);
    console.log(`${marked} comment${marked === 1 ? '' : 's'} marked deployed in ${sha.slice(0, 7)}`);
    process.exit(0);
  }

  if (resolved.reason === 'not-found') {
    console.error(`Unknown project "${flag}". Configured: ${resolved.keys.join(', ')}`);
    process.exit(2);
  }
  if (resolved.reason === 'none') {
    console.error('No project configured. Run `pinsay init` or pass --project.');
    process.exit(2);
  }

  // Ambiguous: report the build against every configured project.
  const { server, token } = await getClient(cwd, parsed, { requireProject: false });
  let total = 0;
  for (const p of listProjects(config)) {
    const marked = await reportBuildFor(server, token, cwd, p.key, sha);
    console.log(`[${p.key}] ${marked} comment${marked === 1 ? '' : 's'} marked deployed in ${sha.slice(0, 7)}`);
    total += marked;
  }
  process.exit(0);
}
