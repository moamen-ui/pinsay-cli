import { accent, dim, sym } from '../ui/style.js';

/** The one `Next` line a run ends with (SPEC B8): one case, one text, plus at most one dim hint line. */

export type NextCase =
  | { kind: 'extension'; storeUrl: string }
  | { kind: 'embedded' }
  | { kind: 'skill'; tool: string }
  | { kind: 'join' };

export function nextStepText(c: NextCase, product: string): string {
  switch (c.kind) {
    case 'extension':
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

export function renderNext(text: string): string[] {
  return [accent(text), dim('Check any time: npx pinsay-cli status')];
}
