import { accent, dim, sym } from '../ui/style.js';

/**
 * The plan init prints and asks one confirm about (SPEC B4), plus its `--json`/`--dry-run --json` shape (B9).
 * Pure: `renderPlan`/`planToJson` write nothing, decide nothing, and only phrase what the caller already decided.
 */

export type InitPlan = {
  product: string;
  project: { key: string; name: string; create: boolean } | null; // null = not known yet (dry run)
  account:
    | {
        kind: 'signed-in';
        displayName: string;
        keySaved: 'repo' | 'global' | 'existing';
        existingSource?: 'env' | 'repo' | 'global';
        globalPath: string;
      }
    | { kind: 'pending' } // dry run, no key found
    | { kind: 'found'; source: 'env' | 'repo' | 'global' }; // dry run, key found but not checked
  widget:
    | { kind: 'extension' }
    | { kind: 'embed'; files: string[] } // files embed will change
    | { kind: 'embed-skill'; tool: string } // stack embed can't inject: the skill does it
    | { kind: 'already'; file: string }; // a <pinsay-feedback snippet is already in the code
  /** Per tool, the paths `installSkills` will write for it. */
  skills: Array<{ tool: string; paths: string[] }>;
  /** Every repo file this run writes, repo-relative. */
  files: string[];
  shared: { decided: boolean; share: boolean; saved: boolean; frontend: string[]; backend: string[]; aiTools: string[] };
  notes: string[];
};

const INDENT = ' '.repeat(12);

function label(name: string): string {
  return `  ${name.padEnd(10)}`;
}

/** The Account line's text, shared by the rendered plan and the JSON result. */
export function accountText(plan: InitPlan): string {
  const account = plan.account;
  if (account.kind === 'signed-in') {
    if (account.keySaved === 'repo') {
      return `${account.displayName} · key saved in this repo (.pinsay/credentials.env, hidden from git)`;
    }
    if (account.keySaved === 'global') {
      return `${account.displayName} · key saved on this machine (${account.globalPath})`;
    }
    if (account.existingSource === 'env') return `${account.displayName} · key from PINSAY_API_KEY`;
    if (account.existingSource === 'global') return `${account.displayName} · key already saved on this machine`;
    return `${account.displayName} · key already saved in this repo`;
  }
  if (account.kind === 'pending') return "you'll sign in in your browser";
  const where = account.source === 'env' ? 'PINSAY_API_KEY' : account.source === 'repo' ? 'this repo' : 'this machine';
  return `key found (${where}), not checked in a dry run`;
}

/** The Shared line's text, shared by the rendered plan and the JSON result. Separator `·` = `sym.dot`. */
export function sharedText(plan: InitPlan): string {
  const shared = plan.shared;
  let text: string;
  if (!shared.decided) {
    text = "you'll be asked (Yes is the default)";
  } else if (shared.share) {
    const names = [...shared.frontend, ...shared.backend].join(', ');
    const toolLabel = shared.aiTools.length === 1 ? 'AI tool' : 'AI tools';
    text = `framework names: ${names || 'none found'} ${sym.dot} ${toolLabel}: ${shared.aiTools.join(', ')} ${sym.dot} "setup done" signal`;
  } else {
    text = 'nothing about your project (only a "setup done" signal)';
  }
  return shared.saved ? `${text} (saved answer)` : text;
}

function widgetLines(plan: InitPlan): string[] {
  const widget = plan.widget;
  switch (widget.kind) {
    case 'extension':
      return [
        `${label('Widget')}Chrome extension, no changes to your app's code`,
        `${INDENT}${dim('To put it in your code instead: npx pinsay-cli embed')}`,
      ];
    case 'embed':
      return [`${label('Widget')}Embedded in your code: ${widget.files.join(', ')}`];
    case 'embed-skill':
      return [`${label('Widget')}Embedded by your AI tool: run /pinsay-init in ${widget.tool} after setup`];
    case 'already':
      return [`${label('Widget')}Already in your code (${widget.file})`];
  }
}

/**
 * The paths as the plan shows them: folder-capable tools list each `pinsay-init`/`pinsay-feedback` folder once
 * (the `/SKILL.md` suffix and its sub-file siblings collapse into the folder), flat tools list their files.
 */
function displayPaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (path.endsWith('/SKILL.md')) {
      const folder = path.slice(0, -'/SKILL.md'.length);
      if (!out.includes(folder)) out.push(folder);
    } else if (!out.some((shown) => path === shown || path.startsWith(`${shown}/`))) {
      out.push(path);
    }
  }
  return out;
}

function skillsLines(plan: InitPlan): string[] {
  const shown = plan.skills.map((entry) => `${entry.tool} ${sym.arrow} ${displayPaths(entry.paths).join(', ')}`);
  if (shown.length === 0) return [];
  return [`${label('Skills')}${shown[0]}`, ...shown.slice(1).map((text) => `${INDENT}${text}`)];
}

/** Greedy wrap at 80 columns: every line is the 12-column prefix + content; a wrapped line ends with its comma. */
function filesLines(plan: InitPlan): string[] {
  if (plan.files.length === 0) return [];
  const joinItems = (items: string[], wrapped: boolean) => `${items.join(', ')}${wrapped ? ',' : ''}`;
  const lines: string[] = [];
  let items: string[] = [];
  plan.files.forEach((file, index) => {
    if (items.length === 0) {
      items.push(file);
      return;
    }
    const isLast = index === plan.files.length - 1;
    const tentative = joinItems([...items, file], !isLast);
    if (INDENT.length + tentative.length <= 80) {
      items.push(file);
    } else {
      lines.push(joinItems(items, true));
      items = [file];
    }
  });
  lines.push(joinItems(items, false));
  return [`${label('Files')}${lines[0]}`, ...lines.slice(1).map((text) => `${INDENT}${text}`)];
}

/** The plan's human lines (no trailing blank line). Colour follows `colorEnabled()` at call time. */
export function renderPlan(plan: InitPlan): string[] {
  const lines: string[] = [`  ${accent("Here's the plan")}`];
  lines.push(
    plan.project
      ? `${label('Project')}${plan.project.name} (${plan.project.key})${plan.project.create ? ' (new)' : ''}`
      : `${label('Project')}you'll pick one after sign-in`,
  );
  lines.push(`${label('Account')}${accountText(plan)}`);
  lines.push(...widgetLines(plan));
  lines.push(...skillsLines(plan));
  lines.push(...filesLines(plan));
  lines.push(`${label('Shared')}${sharedText(plan)}`);
  for (const note of plan.notes) lines.push(dim(`  ${note}`));
  return lines;
}

/** The plan for `--json` / `--dry-run --json` (B9): the Account and Shared texts unstyled, the rest as data. */
export function planToJson(plan: InitPlan): {
  project: InitPlan['project'];
  account: string;
  keySaved: 'repo' | 'global' | 'existing' | null;
  delivery: 'extension' | 'embed';
  skills: InitPlan['skills'];
  files: string[];
  shared: string;
} {
  return {
    project: plan.project,
    account: accountText(plan),
    keySaved: plan.account.kind === 'signed-in' ? plan.account.keySaved : null,
    delivery: plan.widget.kind === 'extension' ? 'extension' : 'embed',
    skills: plan.skills,
    files: plan.files,
    shared: sharedText(plan),
  };
}
