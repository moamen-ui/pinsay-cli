import { api } from '../api.js';
import { postEvent } from '../events.js';
import { isStaged, commitAll, headSha, getRemoteUrl, commitUrlFor, getUserEmail } from './git.js';
import { fetchQueue, type QueueFilter } from './queue.js';
import { loadProjectContext } from './context.js';
import type { ApplyClientContext } from './types.js';

export type MarkAppliedOptions = {
  id: number | 'all';
  reply: string;
  noCommit?: boolean;
  dryRun?: boolean;
  tool?: string;
  /** The model id the tool reported running as (e.g. "claude-sonnet-5"), for structured AI
   *  attribution on the reply — see Reply.AiTool/AiModel server-side. */
  model?: string;
  /** `--mark all` only: the same `--status` / `--env` filter the plan was built with. Omitted →
   *  the queue default (status Ready). */
  filter?: QueueFilter;
};

export type MarkAppliedResult = {
  committed: boolean;
  /** `--mark all` matched no comment: nothing was committed or marked (the staged changes are
   *  left untouched) and the caller must exit non-zero. */
  nothingMatched?: boolean;
  sha?: string;
  commitUrl?: string | null;
  patchedIds: number[];
};

export async function markApplied(
  options: MarkAppliedOptions,
  ctx: ApplyClientContext,
): Promise<MarkAppliedResult> {
  // Precondition: the AI must have staged its changes into git index
  if (!options.noCommit && !isStaged(ctx.cwd)) {
    if (options.id === 'all') {
      console.error('Nothing staged');
    } else {
      console.error(`Nothing staged for #${options.id}`);
    }
    process.exit(1);
  }

  const projectCtx = await loadProjectContext(ctx);
  const email = getUserEmail(ctx.cwd);
  const appliedByLabel = options.tool ? `${email} via ${options.tool}` : email;

  if (options.dryRun) {
    console.log(`[dry-run] Would mark comment ${options.id} as applied`);
    console.log(`[dry-run] Reply: ${options.reply}`);
    console.log(`[dry-run] AppliedBy: ${appliedByLabel}`);
    return {
      committed: false,
      patchedIds: typeof options.id === 'number' ? [options.id] : [],
    };
  }

  let commitUrl: string | null = null;
  let sha: string | undefined;
  const patchedIds: number[] = [];

  if (options.id === 'all') {
    // Single commit style: fetch the comments this run is marking — the same filter the plan used
    // (default: status Ready). Fetched BEFORE committing so an empty match can refuse cleanly.
    const pending = await fetchQueue(ctx, options.filter ?? { status: 2 });
    const count = pending.length;
    if (count === 0) {
      // Committing here would record the staged diff as "Apply 0 pending … comments" while marking
      // nothing server-side — the comments stay open and the commit message lies.
      console.error(
        'No comments matched --mark all (queue filter: ' +
          describeFilter(options.filter) +
          '). Nothing was committed or marked; your staged changes are untouched. ' +
          'Re-run with the same --status/--env you used for --plan, or mark each comment by id.',
      );
      return { committed: false, nothingMatched: true, patchedIds: [] };
    }
    const commitMsg = `Apply ${count} pending ${projectCtx.productName} comments`;

    if (!options.noCommit) {
      const commitRes = commitAll(commitMsg, ctx.cwd);
      if (!commitRes.success) {
        console.error(`Commit failed: ${commitRes.error}`);
        process.exit(1);
      }
      sha = headSha(ctx.cwd);
      const remote = getRemoteUrl(ctx.cwd);
      commitUrl = commitUrlFor(sha, remote);
    }

    for (const item of pending) {
      await api(ctx.server, `/api/comments/${item.id}`, {
        method: 'PATCH',
        body: {
          status: 3,
          reply: options.reply,
          appliedByLabel,
          commitUrl,
          // The raw sha alongside the display URL. Deploy detection tests ancestry against a
          // deployed build, which only a sha can answer — without it a comment stays "applied"
          // forever, even once the fix is live.
          commitSha: sha || null,
          // Structured AI attribution on the reply itself (Reply.AiTool/AiModel), distinct from the
          // free-text appliedByLabel above — see CommentService.Normalize server-side.
          aiTool: options.tool || undefined,
          aiModel: options.model || undefined,
        },
        token: ctx.token,
      });
      patchedIds.push(item.id);
      await postEvent(ctx.server, ctx.token, {
        type: 'first_apply',
        projectKey: ctx.project,
        meta: { commentId: item.id },
      });
    }
  } else {
    // Separate commit style: commit single comment
    const id = options.id;
    let commentBody = '';
    try {
      const commentRes = await api<any>(ctx.server, `/api/comments/${id}`, {
        token: ctx.token,
      });
      commentBody = commentRes?.body ?? '';
    } catch {
      // If fetching comment details fails, use empty string
    }

    const shortBody = commentBody.slice(0, 60);
    const commitMsg = `Apply ${projectCtx.productName} comment #${id} — ${shortBody}`;

    if (!options.noCommit) {
      const commitRes = commitAll(commitMsg, ctx.cwd);
      if (!commitRes.success) {
        console.error(`Commit failed: ${commitRes.error}`);
        process.exit(1);
      }
      sha = headSha(ctx.cwd);
      const remote = getRemoteUrl(ctx.cwd);
      commitUrl = commitUrlFor(sha, remote);
    }

    await api(ctx.server, `/api/comments/${id}`, {
      method: 'PATCH',
      body: {
        status: 3,
        reply: options.reply,
        appliedByLabel,
        commitUrl,
        // Same reason as the single-commit path above: only a sha can be tested for ancestry
        // against a deployed build.
        commitSha: sha || null,
        aiTool: options.tool || undefined,
        aiModel: options.model || undefined,
      },
      token: ctx.token,
    });
    patchedIds.push(id);
    await postEvent(ctx.server, ctx.token, {
      type: 'first_apply',
      projectKey: ctx.project,
      meta: { commentId: id },
    });
  }

  return {
    committed: !options.noCommit,
    sha,
    commitUrl,
    patchedIds,
  };
}

export async function markFailed(
  id: number,
  reason: string,
  ctx: ApplyClientContext,
  tool?: string,
  model?: string,
): Promise<void> {
  const replyBody = `Could not apply: ${reason}`;
  await api(ctx.server, `/api/comments/${id}/replies`, {
    method: 'POST',
    body: { body: replyBody, aiTool: tool || undefined, aiModel: model || undefined },
    token: ctx.token,
  });

  await postEvent(ctx.server, ctx.token, {
    type: 'apply_failed',
    projectKey: ctx.project,
    meta: { commentId: id, reason },
  });
}

function describeFilter(filter?: QueueFilter): string {
  const status = filter?.status ?? 'ready';
  return filter?.environment !== undefined
    ? `status ${status}, env ${filter.environment}`
    : `status ${status}`;
}
