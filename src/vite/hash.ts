import { createHash } from 'node:crypto';

/**
 * The stable identity of one component: `sha1(repoRelativePath#exportName)`, first 8 hex chars.
 *
 * Deliberately derived from PATH AND NAME ONLY — never from file contents or line numbers. A hash
 * that moved when the file changed would invalidate every stamped element on every edit, and the
 * manifest exists precisely so a comment captured months ago still resolves. It changes only when
 * the file moves or the component is renamed, which is exactly when the old identity stopped being
 * true.
 *
 * The path is POSIX-separated and relative to the GIT ROOT, so a Windows checkout and a Linux CI
 * runner produce the same hash for the same component.
 */
export function componentHash(repoRelativePath: string, exportName: string): string {
  const normalised = repoRelativePath.split('\\').join('/').replace(/^\.\//, '');
  return createHash('sha1').update(`${normalised}#${exportName}`).digest('hex').slice(0, 8);
}

export interface ManifestEntry {
  path: string;
  export: string;
}

export type Manifest = Record<string, ManifestEntry>;

/**
 * Adds an entry, refusing a collision rather than silently overwriting.
 *
 * 8 hex chars is 32 bits, so a collision is vanishingly unlikely — but "vanishingly unlikely" and
 * "handled" are different things. A silent overwrite would point every comment on one component at
 * a different file, which is worse than a build error telling the developer to rename something.
 */
export function addToManifest(manifest: Manifest, hash: string, entry: ManifestEntry): void {
  const existing = manifest[hash];
  if (existing && (existing.path !== entry.path || existing.export !== entry.export)) {
    throw new Error(
      `pinsay: hash collision on ${hash} between ` +
        `${existing.path}#${existing.export} and ${entry.path}#${entry.export}. ` +
        `Rename one of the two components.`,
    );
  }
  manifest[hash] = entry;
}
