import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { readConfig, upsertGitignore, isMultiProject, listProjects } from '../config.js';
import { runInitChecks, type CheckResult } from '../checks.js';
import { installSkills } from '../skills.js';
import { detectStack } from '../detect.js';
import { api } from '../api.js';
import { postEvent } from '../events.js';
import { detectDesignTokens } from '../stack/design.js';
import { readStackFile, mergeStack, writeStackFile, stackFileRelPath } from '../stack/stackfile.js';
import { resolveApiKey } from '../credentials.js';

const ICON = { ok: '✔', warn: '⚠', error: '✘' } as const;

export type DoctorOptions = {
  server?: string;
  project?: string;
  json?: boolean;
  fix?: boolean;
  refreshStack?: boolean;
};

/**
 * Exit-code precedence, exactly as specified — the order matters because a caller (a CI job, or an
 * AI agent running `doctor --json` as its first step) branches on the code, not the text:
 *
 *   5  the CLI is older than the server requires. Reported alone: the remaining checks were
 *      deliberately skipped, because their answers against a newer server are not trustworthy.
 *   3  the API key is missing or rejected. Distinct from a generic failure because it is the one
 *      the user fixes in a completely different place (their profile, not their repo).
 *   1  any other failing check.
 *   0  everything passed, warnings included.
 */
export function exitCodeFor(checks: CheckResult[]): number {
  const failed = checks.filter((c) => c.status === 'error');
  if (failed.some((c) => c.id === 'meta')) return 5;
  if (failed.some((c) => c.id === 'key')) return 3;
  return failed.length > 0 ? 1 : 0;
}

export async function doctorCommand(cwd: string, options: DoctorOptions, cliVersion: string): Promise<number> {
  if (options.refreshStack) {
    const config = await readConfig(cwd);
    const multi = isMultiProject(config);
    // In multi-project mode, `--project` (or the only configured project) picks which app's stack
    // file to refresh — there is no single `.pinsay/stack.json` to fall back to.
    const projectKey = multi ? options.project || listProjects(config)[0]?.key : undefined;
    const appCwd = multi && projectKey ? join(cwd, config.projects?.[projectKey]?.path ?? '.') : cwd;

    const start = Date.now();
    const designBlock = await detectDesignTokens(appCwd, { root: cwd });
    const detectMs = Date.now() - start;
    const existing = await readStackFile(cwd, projectKey);
    const merged = mergeStack(existing, null, designBlock);
    await writeStackFile(cwd, merged, projectKey);

    const relPath = stackFileRelPath(projectKey);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, detectMs, design: merged.design, path: relPath }, null, 2));
    } else {
      console.log(`✔ Refreshed design tokens in ${relPath} (detectMs=${detectMs})`);
    }
    return 0;
  }

  let checks = await runInitChecks(cwd, { server: options.server, project: options.project }, cliVersion);

  if (options.fix) {
    // Re-run afterwards so the reported state is the state AFTER repair, not before it — a doctor
    // that fixes something and still prints the complaint is worse than one that does neither.
    const repaired = await applyFixes(cwd, checks);
    if (repaired.length > 0) {
      checks = await runInitChecks(cwd, { server: options.server, project: options.project }, cliVersion);
    }
  }

  const code = exitCodeFor(checks);
  const ok = code === 0;

  if (options.json) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
  } else {
    for (const check of checks) {
      console.log(`${ICON[check.status]} ${check.id.padEnd(14)} ${check.message}`);
      if (check.hint && check.status !== 'ok') console.log(`  ${' '.repeat(14)} → ${check.hint}`);
    }
    const failed = checks.filter((c) => c.status === 'error').length;
    const warned = checks.filter((c) => c.status === 'warn').length;
    console.log(
      ok
        ? `\nAll good${warned ? ` (${warned} warning${warned === 1 ? '' : 's'})` : ''}.`
        : `\n${failed} problem${failed === 1 ? '' : 's'} found.`,
    );
  }

  await reportRun(cwd, options, checks, ok);
  return code;
}

/**
 * Telemetry is best-effort and only when the key verified — an unauthenticated POST would just be
 * rejected, and doctor must never fail because reporting failed.
 */
async function reportRun(cwd: string, options: DoctorOptions, checks: CheckResult[], ok: boolean): Promise<void> {
  const keyCheck = checks.find((c) => c.id === 'key');
  if (keyCheck?.status !== 'ok') return;

  try {
    const config = await readConfig(cwd);
    const server = (options.server || config.server || '').replace(/\/$/, '');
    if (!server) return;

    const { key: apiKey } = await resolveApiKey(cwd, server);
    if (!apiKey) return;

    const login = await api<{ token?: string }>(server, '/api/auth/login-with-key', { method: 'POST', body: { apiKey } });
    if (!login?.token) return;

    await postEvent(server, login.token, {
      type: 'doctor_run',
      projectKey: options.project || config.project,
      meta: { ok, failed: checks.filter((c) => c.status === 'error').map((c) => c.id) },
    });
  } catch {
    // Deliberately silent.
  }
}

/** Applies only the idempotent repairs. Returns the ids actually repaired. */
async function applyFixes(cwd: string, checks: CheckResult[]): Promise<string[]> {
  const repaired: string[] = [];
  const config = await readConfig(cwd);
  const server = (config.server || '').replace(/\/$/, '');

  // Only the `stack` repair needs auth, so this is resolved lazily and its failure is not fatal to
  // the other repairs.
  let token: string | undefined;
  const tokenFor = async (): Promise<string | undefined> => {
    if (token) return token;
    try {
      const { key: apiKey } = await resolveApiKey(cwd, server);
      if (!apiKey || !server) return undefined;
      const login = await api<{ token?: string }>(server, '/api/auth/login-with-key', { method: 'POST', body: { apiKey } });
      token = login?.token;
    } catch {
      token = undefined;
    }
    return token;
  };

  const failing = new Set(checks.filter((c) => c.fixable && c.status !== 'ok').map((c) => c.id));

  for (const check of checks.filter((c) => c.fixable && c.status !== 'ok')) {
    if (check.id === 'stack') continue; // handled once below — see the note there
    try {
      if (check.id === 'gitignore') {
        const path = join(cwd, '.gitignore');
        const before = await fs.readFile(path, 'utf8').catch(() => '');
        // Reuse the canonical block (and its migration logic) rather than hand-rolling a second,
        // narrower copy here — this is the same repair `init` applies on every run, just invoked
        // directly instead of waiting for the next `init`/`update`.
        await upsertGitignore(cwd, 'Feedback tool', config.skillsDir);
        const after = await fs.readFile(path, 'utf8').catch(() => '');
        if (after !== before) repaired.push(check.id);
      } else if (check.id === 'source-map') {
        // Rebuild it rather than telling the developer to run `pinsay map --from-source`
        // themselves: the CLI is standing right here with everything it needs.
        const { buildManifest } = await import('./map.js');
        const built = await buildManifest(cwd, { quiet: true });
        if (built.ok) repaired.push(check.id);
      } else if (check.id === 'skills' && server && config.aiTool) {
        await installSkills(server, config.aiTool, cwd, config.skillsDir);
        repaired.push(check.id);
      }
    } catch {
      // A failed repair is not fatal: the re-run reports the check as still failing, which is the
      // honest outcome.
    }
  }

  // `stack`: there is one CheckResult per project in multi-project mode (see checks.ts), but the
  // repair is the same shape for each — re-detect and re-POST — so it runs once here, over every
  // configured project, rather than once per failing CheckResult instance.
  if (failing.has('stack') && server) {
    const multi = isMultiProject(config);
    const targets = multi ? listProjects(config) : config.project ? [{ key: config.project, path: '.' }] : [];
    let any = false;
    for (const t of targets) {
      try {
        const appCwd = multi ? join(cwd, t.path) : cwd;
        const detection = await detectStack(appCwd);
        const stackToken = await tokenFor();
        const stack = stackToken
          ? await api<any>(server, `/api/projects/${t.key}/stack`, {
              method: 'POST',
              token: stackToken,
              body: { kind: detection.kind, evidence: detection.evidence },
            }).catch(() => null)
          : null;
        if (stack) {
          await fs.writeFile(join(cwd, stackFileRelPath(multi ? t.key : undefined)), JSON.stringify(stack, null, 2) + '\n', 'utf8');
          any = true;
        }
      } catch {
        // Same as every other repair: a failure here just leaves that project's check failing.
      }
    }
    if (any) repaired.push('stack');
  }

  return repaired;
}
