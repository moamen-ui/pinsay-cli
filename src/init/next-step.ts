import { accent, dim, sym } from '../ui/style.js';

/** The one `Next` line a run ends with (SPEC B8): one case, one text, plus at most one dim hint line. */

export type NextCase =
  | { kind: 'extension'; storeUrl: string; otherStores?: Array<{ label: string; url: string }> }
  | { kind: 'embedded' }
  | { kind: 'skill'; tool: string }
  | { kind: 'join' };

export function nextStepText(c: NextCase, product: string): string {
  switch (c.kind) {
    case 'extension':
      if (c.storeUrl === '' && c.otherStores && c.otherStores.length > 0) {
        return `Next: install the ${product} browser extension, open your app and click the ${product} icon ${sym.arrow} ${c.otherStores[0].url}`;
      }
      if (c.storeUrl === '') {
        return `Next: ask your admin for the ${product} Chrome extension link (${product} ${sym.arrow} Settings ${sym.arrow} Extension).`;
      }
      return `Next: install the ${product} Chrome extension, open your app and click the ${product} icon ${sym.arrow} ${c.storeUrl}`;
    case 'embedded':
      return `Next: start your app and click the ${product} button.`;
    case 'skill':
      return `Next: in ${c.tool}, run /pinsay-init to add the widget.`;
    case 'join':
      return `Next: tell your AI agent: Apply the new ${product} comments`;
  }
}

/** The dim `Also for <label>: <url>` lines for stores not already named by the Next line's arrow URL. */
export function otherStoreLines(c: NextCase): string[] {
  if (c.kind !== 'extension' || !c.otherStores) return [];
  const used = c.storeUrl !== '' ? c.storeUrl : c.otherStores[0]?.url;
  return c.otherStores.filter((s) => s.url !== used).map((s) => `Also for ${s.label}: ${s.url}`);
}

export function renderNext(text: string, extra: string[] = []): string[] {
  const m = /^(.*?) ?(?:→|->) (https?:\/\/\S+)$/.exec(text);
  const head = m ? [accent(`${m[1]}:`), accent(`      ${m[2]}`)] : [accent(text)];
  return [...head, ...extra.map((line) => dim(`      ${line}`)), dim('Check any time: npx pinsay-cli status')];
}
