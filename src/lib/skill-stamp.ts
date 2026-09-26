import { promises as fs } from 'node:fs';

/**
 * Reads the `pinsay-skill-version` stamp the server writes into a served skill or script.
 *
 * Placement differs by file type:
 *
 *   .md — accepts two valid shapes:
 *         (a) frontmatter first: an HTML comment on the first line after the closing `---` of
 *             the YAML frontmatter block. AI tools parse frontmatter from line 1, so nothing may
 *             precede it in a file with frontmatter.
 *         (b) no frontmatter: the HTML stamp comment within the first 3 non-empty lines of the
 *             file (e.g. served sub-skills like apply.md, translate.md, advanced.md).
 *   .sh — a `#` comment on line 2, after the shebang.
 *
 * Returns null when the file has no stamp (an older installed copy), cannot be read, or is
 * neither type. Never throws: this runs inside `doctor`, which must survive a broken install.
 */
export async function readStamp(path: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n');

  if (path.endsWith('.md')) {
    if (lines[0]?.trim() === '---') {
      // Shape (a): Frontmatter first.
      // Scan for the closing delimiter rather than assuming a line number — the frontmatter grows.
      let close = -1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') { close = i; break; }
      }
      if (close === -1) return null;

      for (let i = close + 1; i < lines.length; i++) {
        const match = lines[i].match(/pinsay-skill-version:\s*([^\s>-][^>]*?)\s*(?:-->)?\s*$/);
        if (match) return match[1].trim();
        // Only the block immediately after the frontmatter is the stamp's home; stop at real
        // content so a mention further down the prose is never mistaken for it.
        if (lines[i].trim() !== '' && !lines[i].trim().startsWith('<!--')) break;
      }
      return null;
    }

    // Shape (b): No frontmatter (e.g. sub-skills like apply.md, translate.md, advanced.md).
    // The stamp comment must appear within the first 3 non-empty lines of the file.
    let nonEmptyCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === '') continue;

      nonEmptyCount++;
      if (nonEmptyCount > 3) break;

      if (trimmed.startsWith('<!--')) {
        const match = lines[i].match(/pinsay-skill-version:\s*([^\s>-][^>]*?)\s*(?:-->)?\s*$/);
        if (match) {
          // If a frontmatter block follows the stamp, reject: placing content before YAML
          // frontmatter breaks frontmatter parsing in AI tools.
          for (let j = i + 1; j < lines.length; j++) {
            const nextTrimmed = lines[j].trim();
            if (nextTrimmed === '') continue;
            if (nextTrimmed.startsWith('<!--')) continue;
            if (nextTrimmed === '---') return null;
            break;
          }
          return match[1].trim();
        }
      }
    }
    return null;
  }

  if (path.endsWith('.sh')) {
    const match = lines[1]?.match(/^#\s*pinsay-skill-version:\s*(.+?)\s*$/);
    return match ? match[1].trim() : null;
  }

  return null;
}
