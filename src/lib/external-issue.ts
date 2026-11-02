/** `[GitHub #89]` or `[Jira WEB-123]` for a comment linked to an issue tracker, else ''. Values are re-checked
 *  (positive integer / Jira key pattern): they are printed into prompts, so nothing else from the server gets through. */
const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9}$/;

export function externalIssueTag(
  item: { externalIssue?: { provider?: unknown; number?: unknown; key?: unknown; state?: unknown } | null } | null | undefined,
): string {
  const ext = item?.externalIssue;
  if (!ext) return '';
  if (ext.provider === 'github') {
    const n = Number(ext.number);
    return Number.isInteger(n) && n > 0 ? `[GitHub #${n}]` : '';
  }
  if (ext.provider === 'jira' && typeof ext.key === 'string' && JIRA_KEY.test(ext.key)) {
    return `[Jira ${ext.key}]`;
  }
  return '';
}
