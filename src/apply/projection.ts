import type {
  AiCommentView,
  AiElementView,
  AiPickedActionView,
  AiReplyView,
} from './types.js';

/**
 * Whitelisted AI-facing comment projection.
 *
 * Security & Privacy Invariant:
 * Never prints raw CommentResponse. Drops forbidden fields (hasPayloadFlag, payloadFlags,
 * authorId, ownerId, pageContext internals, editedBy). Builds the object by naming each
 * field, never by spreading and deleting.
 */
export function toAiCommentView(raw: any, page?: any): AiCommentView {
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
    ? raw.replies.map((r: any): AiReplyView => {
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
        prompt: '',
        text: String(text ?? ''),
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
    environment: raw?.environment,
    id: raw?.id,
    isBugReport: Boolean(raw?.isBugReport),
    pickedActions,
    replies,
    status: raw?.status,
  };
}
