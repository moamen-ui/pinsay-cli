import { normalizeMedia } from './media.js';
import { statusJson } from '../statuses.js';
import { formatEnvironment } from './prompt.js';
import { promptRef } from './shared.js';
import type {
  AiCommentView,
  AiSharedItemView,
  QueueItem,
  AiElementView,
  AiMediaView,
  AiPickedActionView,
  AiRuleView,
  AiReplyView,
  SavedCommentMedia,
  SavedMedia,
} from './types.js';

/**
 * Whitelisted AI-facing comment projection.
 *
 * Security & Privacy Invariant:
 * Never prints raw CommentResponse. Drops forbidden fields (hasPayloadFlag, payloadFlags,
 * authorId, ownerId, pageContext internals, editedBy). Builds the object by naming each
 * field, never by spreading and deleting.
 */
export function toAiCommentView(raw: any, page?: any, saved?: SavedCommentMedia | null): AiCommentView {
  function toMediaViews(rawMedia: unknown, savedMedia: SavedMedia[] | undefined): AiMediaView[] {
    return normalizeMedia(rawMedia).map((m, i): AiMediaView => {
      const s = savedMedia?.[i];
      return {
        kind: m.kind,
        ordinal: m.ordinal,
        path: s?.path ?? null,
        url: m.url,
        contentType: m.contentType,
        sizeBytes: m.sizeBytes,
        durationMs: m.durationMs ?? null,
        width: m.width ?? null,
        height: m.height ?? null,
        transcript: m.transcript ? { untrusted: true, value: m.transcript } : null,
        transcriptSource: m.transcriptSource ?? null,
        transcriptionStatus: m.transcriptionStatus ?? null,
        available: m.available,
        ...(s?.error ? { error: s.error } : {}),
      };
    });
  }

  const elementRaw = raw?.element || {};
  const element: AiElementView = {
    appliedCssRules: elementRaw.appliedCssRules ?? null,
    classes: elementRaw.classes ?? null,
    deviceType: elementRaw.deviceType ?? page?.device ?? null,
    pageTitle: elementRaw.pageTitle ?? page?.title ?? null,
    pageUrl: elementRaw.pageUrl ?? page?.url ?? null,
    parentInfo: elementRaw.parentInfo ?? elementRaw.parent ?? null,
    route: elementRaw.route ?? page?.route ?? null,
    selector: elementRaw.selector ?? null,
    snapshot: elementRaw.snapshot ?? null,
    sourcePath: elementRaw.sourcePath ?? null,
    screenshotUrl: elementRaw.screenshotUrl ?? null,
    screenshotPath: saved?.screenshot?.path ?? null,
    viewportHeight:
      typeof elementRaw.viewportHeight === 'number'
        ? elementRaw.viewportHeight
        : page?.viewport
        ? parseInt(String(page.viewport).split('x')[1], 10) || null
        : null,
    viewportWidth:
      typeof elementRaw.viewportWidth === 'number'
        ? elementRaw.viewportWidth
        : page?.viewport
        ? parseInt(String(page.viewport).split('x')[0], 10) || null
        : null,
  };

  const replies: AiReplyView[] = Array.isArray(raw?.replies)
    ? raw.replies.map((r: any, i: number): AiReplyView => {
        const bodyValue =
          typeof r?.body === 'object' && r?.body !== null
            ? String(r.body.value ?? '')
            : String(r?.body ?? '');
        return {
          authorName: r?.authorName ?? null,
          body: {
            untrusted: true,
            value: bodyValue,
          },
          isAi: Boolean(r?.isAi),
          media: toMediaViews(r?.media, saved?.replies.find((x) => x.position === i + 1)?.media),
        };
      })
    : [];

  const pickedActions: AiPickedActionView[] = Array.isArray(raw?.pickedActions)
    ? raw.pickedActions.map((p: any): AiPickedActionView => ({
        prompt: String(p?.prompt ?? ''),
        text: String(p?.text ?? ''),
      }))
    : Array.isArray(raw?.pickedActionTexts)
    ? raw.pickedActionTexts.map((text: any): AiPickedActionView => ({
        text: String(text ?? ''),
      }))
    : [];

  const aiRules: AiRuleView[] = Array.isArray(raw?.aiRules)
    ? raw.aiRules.map((r: any): AiRuleView => ({
        title: String(r?.title ?? ''),
        prompt: String(r?.prompt ?? ''),
        scope: String(r?.scope ?? ''),
        priority: Number(r?.priority ?? 0),
        isPersonal: Boolean(r?.isPersonal),
        ...(r?.roleName ? { roleName: String(r.roleName) } : {}),
      }))
    : [];

  const bodyValue =
    typeof raw?.body === 'object' && raw?.body !== null
      ? String(raw.body.value ?? '')
      : String(raw?.body ?? '');

  return {
    appliedAt: raw?.appliedAt ?? null,
    appliedByLabel: raw?.appliedByLabel ?? null,
    authorName: raw?.authorName ?? null,
    body: {
      untrusted: true,
      value: bodyValue,
    },
    commitUrl: raw?.commitUrl ?? null,
    createdAt: raw?.createdAt ?? '',
    element,
    environment: raw?.environment == null ? raw?.environment : formatEnvironment(raw.environment),
    number: raw?.number,
    internalId: raw?.id,
    isBugReport: Boolean(raw?.isBugReport),
    pickedActions,
    aiRules,
    replies,
    status: raw?.status,
    ...statusJson(raw ?? {}),
    media: toMediaViews(raw?.media, saved?.media),
    textSource: typeof raw?.textSource === 'string' ? raw.textSource : null,
  };
}

export function toSharedItemView(item: QueueItem, saved?: SavedCommentMedia | null): AiSharedItemView {
  const { aiRules: _rules, pickedActions: _actions, ...rest } = toAiCommentView(item, undefined, saved);
  return {
    ...rest,
    aiRuleRefs: item.aiRuleRefs ?? [],
    pickedActions: (item.pickedActions ?? []).map((pa) => ({ id: pa.id ?? promptRef(pa.text, pa.prompt), text: pa.text })),
  };
}
