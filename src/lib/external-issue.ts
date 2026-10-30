/** `[GitHub #89]` for a comment linked to a GitHub issue (integrations release 2), else ''. The number is
 *  re-checked as a positive integer: it is printed into prompts, so nothing else from the server gets through. */
export function externalIssueTag(item: { externalIssue?: { provider?: unknown; number?: unknown } | null } | null | undefined): string {
  const ext = item?.externalIssue;
  if (!ext || ext.provider !== 'github') return '';
  const n = Number(ext.number);
  return Number.isInteger(n) && n > 0 ? `[GitHub #${n}]` : '';
}
