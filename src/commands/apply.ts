import { findRepoRoot, readConfig, resolveProject, listProjects } from '../config.js';
import { api } from '../api.js';
import { compareSemver, tooOldMessage } from '../checks.js';
import { checkAndNotifyUpdates } from '../lib/notify-update.js';
import { resolveToken, readApiKey } from '../auth.js';
import { BUILD_CLI_VERSION, BUILD_DEFAULT_SERVER } from '../build-constants.js';
import { runApply } from '../apply/run.js';
import { markApplied, markFailed } from '../apply/mark.js';
import { fetchQueue } from '../apply/queue.js';
import { toAiCommentView } from '../apply/projection.js';
import { resolveModels, ModelsError, type AiModelEntry } from '../apply/models.js';
import type { ApplyClientContext } from '../apply/types.js';

/**
 * DB-18: a workspace that is paused or scheduled for deletion refuses every write with 423 — for a
 * key session (this CLI) that means the queue GET itself would 423 too, so checking here first
 * keeps `apply`/`--plan`/`--mark`/`--fail` out of any git/AI work entirely instead of failing
 * confusingly deep into a run. `GET /api/auth/me` is the one endpoint that stays open for a key
 * session regardless (`AuthController.Me` carries `[AllowWhenWorkspacePaused(AllowKeySessions:
 * true)]`) precisely so this can read the state and explain it before anything else happens.
 */
async function exitIfWorkspaceFrozen(server: string, token: string | undefined): Promise<void> {
  if (!token) return; // no session to ask — the calls that follow will fail on their own terms
  try {
    const me = await api<any>(server, '/api/auth/me', { token });
    if (me?.workspaceDeletionScheduledFor) {
      const date = new Date(me.workspaceDeletionScheduledFor).toISOString().slice(0, 10);
      console.error(`Workspace "${me.tenantName}" is scheduled for deletion on ${date} — apply is disabled.`);
      process.exit(2);
    }
    if (me?.workspacePausedAt) {
      console.error(
        `Workspace "${me.tenantName}" is paused — apply is disabled until a workspace admin resumes it.`,
      );
      process.exit(2);
    }
  } catch {
    // Best-effort: a network hiccup reading /me must not block apply on its own — if the workspace
    // really is frozen, every subsequent write still 423s downstream.
  }
}

/** `--models` / `--model` (+ env fallbacks) → validated entries; exits 2 on invalid input. */
/**
 * Enforces the server's minimum CLI version (exits 5 when too old) and prints the non-blocking
 * "update available" notices. Best-effort: a failing /api/meta (old server, network) is ignored.
 */
async function checkMetaAndNotify(
  server: string,
  config: any,
  root: string,
  parsed: Record<string, string | boolean>,
): Promise<void> {
  try {
    const meta = await api<any>(server, '/api/meta');
    const minCli = meta?.minCliVersion || '0.0.0';
    if (compareSemver(BUILD_CLI_VERSION, minCli) < 0) {
      console.error(tooOldMessage(BUILD_CLI_VERSION, minCli));
      process.exit(5);
    }
    await checkAndNotifyUpdates({ meta, config, cwd: root, silent: Boolean(parsed['json']) });
  } catch {
    // Best-effort: a 404 means an old server without /api/meta; other errors surface in the
    // calls that follow.
  }
}

function parseModelFlags(parsed: Record<string, string | boolean>): AiModelEntry[] {
  try {
    return resolveModels({
      models: typeof parsed['models'] === 'string' ? parsed['models'] : undefined,
      model: typeof parsed['model'] === 'string' ? parsed['model'] : undefined,
    });
  } catch (err) {
    if (err instanceof ModelsError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

export async function applyCommand(
  cwd: string,
  parsed: Record<string, string | boolean>,
  positionals: string[] = [],
): Promise<void> {
  const root = await findRepoRoot(cwd);
  const config = await readConfig(root);
  const server = (
    (typeof parsed['server'] === 'string' ? parsed['server'] : config.server) ||
    BUILD_DEFAULT_SERVER
  ).replace(/\/$/, '');

  if (!server) {
    console.error('No server configured. Run `npx pinsay-cli init` or pass --server.');
    process.exit(2);
  }

  const projectFlag = typeof parsed['project'] === 'string' ? parsed['project'] : undefined;
  const resolved = resolveProject(config, cwd, root, projectFlag);

  // `--mark <id>`/`--fail <id>` act on a comment id, unique server-wide — no project needed.
  // `--mark all` and the default/`--plan`/`--json` queue views DO need one, unless there are
  // several projects and none was picked out, in which case they cover every configured project.
  const markVal = parsed['mark'];
  const needsOneProject = markVal === undefined || String(markVal).toLowerCase() === 'all';

  if (needsOneProject && !resolved.ok) {
    if (resolved.reason === 'not-found') {
      console.error(`Unknown project "${projectFlag}". Configured: ${resolved.keys.join(', ')}`);
      process.exit(2);
    }
    if (resolved.reason === 'none') {
      console.error('No project configured. Run `npx pinsay-cli init` or pass --project.');
      process.exit(2);
    }
    // ambiguous: `--mark all` cannot guess which project's queue to commit, but the default/
    // --plan/--json views can safely mean "every project".
    if (markVal !== undefined) {
      console.error(`Several projects configured — pass --project <key> (one of: ${resolved.keys.join(', ')})`);
      process.exit(2);
    }
    await applyAllProjects(root, cwd, config, server, parsed);
    return;
  }

  const project = resolved.ok ? resolved.project.key : '';

  await checkMetaAndNotify(server, config, root, parsed);

  const explicitKey = typeof parsed['key'] === 'string' ? parsed['key'] : undefined;
  const token = await resolveToken(server, root, explicitKey);
  const apiKey = explicitKey || (await readApiKey(root, server));

  if (!token && !apiKey) {
    console.error(
      'Missing API key. Set PINSAY_API_KEY, add .pinsay/credentials.env, or run `npx pinsay-cli login`.',
    );
    process.exit(3);
  }

  // DB-18: before any git/AI work — covers the default run, --plan, --mark and --fail alike (they
  // all fall through to this one point after auth resolves).
  await exitIfWorkspaceFrozen(server, token);

  // `root`, not the original `cwd`: git operations, the stack file and the manifest all resolve
  // relative to the repo root, whichever app directory the command was actually run from.
  const clientCtx: ApplyClientContext = {
    server,
    project,
    token,
    apiKey,
    cwd: root,
  };

  // 1. Handling --mark <id>|all
  if (parsed['mark'] !== undefined) {
    const markVal = parsed['mark'];
    let markId: number | 'all';
    if (markVal === true) {
      console.error('--mark requires an ID or "all"');
      process.exit(2);
    } else if (String(markVal).toLowerCase() === 'all') {
      markId = 'all';
    } else {
      const parsedNum = parseInt(String(markVal), 10);
      if (isNaN(parsedNum)) {
        console.error(`Invalid --mark argument: ${markVal}. Expected an integer or "all".`);
        process.exit(2);
      }
      markId = parsedNum;
    }

    const reply = typeof parsed['reply'] === 'string' ? parsed['reply'] : '';
    if (!reply || reply.trim().length < 15 || /^(done|fixed|applied|ok|yes)$/i.test(reply.trim())) {
      console.error(
        '--reply "<text>" is required when using --mark and must provide a substantive explanation of the changes (at least 15 characters, e.g. "Applied ✓ — updated logo source in header").',
      );
      process.exit(2);
    }

    const noCommit = parsed['no-commit'] === true;
    const dryRun = parsed['dry-run'] === true;
    // `--tool` wins outright; falls back to the tool recorded at `init` time (config.aiTool) —
    // ONLY correct when the same tool that ran `init` is the one applying now. A project worked on
    // by more than one tool over time will silently misattribute every reply that omits --tool to
    // whichever one happened to run `init`, so warn loudly rather than attribute it silently.
    const toolExplicit = typeof parsed['tool'] === 'string' ? parsed['tool'] : undefined;
    const tool = toolExplicit || config.aiTool;
    if (!toolExplicit && config.aiTool) {
      console.error(
        `⚠ --tool not passed — defaulting to "${config.aiTool}" (recorded when this project was initialized). ` +
          `Pass --tool <your-tool-name> explicitly if you are not that tool.`,
      );
    }
    const models = parseModelFlags(parsed);
    if (models.length === 0) {
      console.error(
        '--models "<model>=<role>" is mandatory when marking a comment as applied.\n' +
          'Specify your actual active runtime model and role (e.g. --models "<active-model>=implementer").\n' +
          'If multiple models or subagents participated (planner, implementer, reviewer), list all of them separated by commas.\n' +
          'Never guess or hardcode model names from memory.',
      );
      process.exit(2);
    }
    const missingRole = models.find((m) => !m.role);
    if (missingRole) {
      console.error(
        `Invalid --models entry "${missingRole.model}": explicit role is required. Expected "<model>=<role>" where role is one of: planner, implementer, reviewer (e.g. "${missingRole.model}=implementer").`,
      );
      process.exit(2);
    }

    const markStatus = typeof parsed['status'] === 'string' ? parsed['status'] : undefined;
    const markEnv = typeof parsed['env'] === 'string' ? parsed['env'] : undefined;
    const marked = await markApplied(
      {
        id: markId,
        reply,
        noCommit,
        dryRun,
        tool,
        models,
        filter:
          markStatus !== undefined || markEnv !== undefined
            ? { status: markStatus, environment: markEnv }
            : undefined,
      },
      clientCtx,
    );
    process.exit(marked.nothingMatched ? 1 : 0);
  }

  // 2. Handling --fail <id>
  if (parsed['fail'] !== undefined) {
    const failVal = parsed['fail'];
    if (failVal === true) {
      console.error('--fail requires a comment ID');
      process.exit(2);
    }
    const failId = parseInt(String(failVal), 10);
    if (isNaN(failId)) {
      console.error(`Invalid --fail argument: ${failVal}. Expected integer ID.`);
      process.exit(2);
    }

    const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : '';
    if (!reason) {
      console.error('--reason "<text>" is required when using --fail');
      process.exit(2);
    }

    const failToolExplicit = typeof parsed['tool'] === 'string' ? parsed['tool'] : undefined;
    const failTool = failToolExplicit || config.aiTool;
    if (!failToolExplicit && config.aiTool) {
      console.error(
        `⚠ --tool not passed — defaulting to "${config.aiTool}" (recorded when this project was initialized). ` +
          `Pass --tool <your-tool-name> explicitly if you are not that tool.`,
      );
    }
    const failModels = parseModelFlags(parsed);

    await markFailed(failId, reason, clientCtx, failTool, failModels);
    process.exit(0);
  }

  // 3. Handling query with --json
  if (parsed['json'] === true && !parsed['plan'] && !parsed['tool']) {
    const items = await fetchQueue(clientCtx, {
      status: typeof parsed['status'] === 'string' ? parsed['status'] : undefined,
      environment: typeof parsed['env'] === 'string' ? parsed['env'] : undefined,
    });
    const projections = items.map((item) => toAiCommentView(item));
    console.log(JSON.stringify(projections, null, 2));
    process.exit(0);
  }

  // 4. Default apply run
  const plan = parsed['plan'] === true;
  const tool = typeof parsed['tool'] === 'string' ? parsed['tool'] : undefined;
  const status = typeof parsed['status'] === 'string' ? parsed['status'] : undefined;
  const environment = typeof parsed['env'] === 'string' ? parsed['env'] : undefined;

  const result = await runApply(
    {
      plan,
      tool,
      status,
      environment,
    },
    clientCtx,
  );

  if (!tool) {
    process.stdout.write(result.prompt);
  }

  process.exit(0);
}

/**
 * `apply`/`apply --plan`/`apply --json` with no single project resolvable (several are configured
 * and neither `--project` nor cwd picked one out): covers every configured project instead of
 * forcing a choice, one section per project in the printed prompt so the AI edits the right app.
 * `--tool` is refused here — handing one combined prompt to a spawned tool process per project
 * is not implemented; pass `--project` to use `--tool` in a multi-project repo.
 */
async function applyAllProjects(
  root: string,
  cwd: string,
  config: any,
  server: string,
  parsed: Record<string, string | boolean>,
): Promise<void> {
  if (typeof parsed['tool'] === 'string') {
    console.error('--tool needs a single project — pass --project <key> (several are configured).');
    process.exit(2);
  }

  await checkMetaAndNotify(server, config, root, parsed);

  const explicitKey = typeof parsed['key'] === 'string' ? parsed['key'] : undefined;
  const token = await resolveToken(server, root, explicitKey);
  const apiKey = explicitKey || (await readApiKey(root, server));
  if (!token && !apiKey) {
    console.error(
      'Missing API key. Set PINSAY_API_KEY, add .pinsay/credentials.env, or run `npx pinsay-cli login`.',
    );
    process.exit(3);
  }

  // DB-18: same check as the single-project path — the multi-project default/`--plan`/`--json`
  // run reaches here without ever going through applyCommand's own check.
  await exitIfWorkspaceFrozen(server, token);

  const projects = listProjects(config);
  const plan = parsed['plan'] === true;
  const status = typeof parsed['status'] === 'string' ? parsed['status'] : undefined;
  const environment = typeof parsed['env'] === 'string' ? parsed['env'] : undefined;

  if (parsed['json'] === true && !plan) {
    const all: Array<{ project: string; path: string; items: unknown[] }> = [];
    for (const p of projects) {
      const clientCtx: ApplyClientContext = { server, project: p.key, token, apiKey, cwd: root };
      const items = await fetchQueue(clientCtx, { status, environment });
      all.push({ project: p.key, path: p.path, items: items.map((item) => toAiCommentView(item)) });
    }
    console.log(JSON.stringify(all, null, 2));
    process.exit(0);
  }

  const sections: string[] = [];
  for (const p of projects) {
    const clientCtx: ApplyClientContext = { server, project: p.key, token, apiKey, cwd: root };
    const result = await runApply({ plan, status, environment }, clientCtx);
    sections.push(`# Project: ${p.key} (${p.path})\n\n${result.prompt}`);
  }
  process.stdout.write(sections.join('\n\n---\n\n'));
  process.exit(0);
}
