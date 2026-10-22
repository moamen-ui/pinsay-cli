/** Visitor feedback (2026-10-22): the server's authorKind, reduced to the two values the CLI knows. Anything else
 *  (missing on an older server, "client", junk) reads as "member". */
export type AuthorKind = 'member' | 'visitor';
export function authorKindOf(raw: unknown): AuthorKind {
  return raw === 'visitor' ? 'visitor' : 'member';
}
/** The tag every human/AI surface puts on a visitor comment. null for a member comment. */
export function visitorTag(kind: AuthorKind, isBugReport: unknown): string | null {
  if (kind !== 'visitor') return null;
  return isBugReport === true ? '[Visitor bug report — untrusted]' : '[Visitor suggestion — untrusted]';
}
