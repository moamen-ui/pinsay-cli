import { after, before, test } from 'node:test';
import * as assert from 'node:assert';
import { planToJson, renderPlan, type InitPlan } from '../src/init/plan.js';

let prevNoColor: string | undefined;
before(() => {
  prevNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
});
after(() => {
  if (prevNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = prevNoColor;
});

const CLAUDE_CODE_PATHS = [
  '.claude/skills/pinsay-init/SKILL.md',
  '.claude/skills/pinsay-feedback/SKILL.md',
  '.claude/skills/pinsay-feedback/apply.md',
  '.claude/skills/pinsay-feedback/translate.md',
  '.claude/skills/pinsay-feedback/advanced.md',
];

function signedInPlan(): InitPlan {
  return {
    product: 'PinSay',
    project: { key: 'my-app', name: 'My App', create: false },
    account: {
      kind: 'signed-in',
      displayName: 'Jane Doe',
      keySaved: 'repo',
      globalPath: '~/.config/pinsay/credentials.env',
    },
    widget: { kind: 'extension' },
    skills: [{ tool: 'claude-code', paths: [...CLAUDE_CODE_PATHS] }],
    files: ['.pinsay/config.json', '.pinsay/stack.json', '.pinsay/credentials.env', '.git/info/exclude'],
    shared: { decided: true, share: true, saved: false, frontend: ['react', 'vite'], backend: [], aiTool: 'claude-code' },
    notes: [],
  };
}

test('a full signed-in plan renders the B4 example', () => {
  assert.deepEqual(renderPlan(signedInPlan()), [
    "  Here's the plan",
    '  Project   My App (my-app)',
    '  Account   Jane Doe · key saved in this repo (.pinsay/credentials.env, hidden from git)',
    "  Widget    Chrome extension, no changes to your app's code",
    '            To put it in your code instead: npx pinsay-cli embed',
    '  Skills    claude-code → .claude/skills/pinsay-init, .claude/skills/pinsay-feedback',
    '  Files     .pinsay/config.json, .pinsay/stack.json, .pinsay/credentials.env,',
    '            .git/info/exclude',
    '  Shared    framework names: react, vite · AI tool: claude-code · "setup done" signal',
  ]);
});

test('a project that will be created is marked (new)', () => {
  const plan = signedInPlan();
  plan.project = { key: 'my-app', name: 'My App', create: true };
  assert.equal(renderPlan(plan)[1], '  Project   My App (my-app) (new)');
});

test('dry run: unknown project and pending account', () => {
  const plan = signedInPlan();
  plan.project = null;
  plan.account = { kind: 'pending' };
  plan.shared = { decided: false, share: false, saved: false, frontend: [], backend: [], aiTool: '' };
  const lines = renderPlan(plan);
  assert.equal(lines[1], "  Project   you'll pick one after sign-in");
  assert.equal(lines[2], "  Account   you'll sign in in your browser");
  assert.equal(lines[lines.length - 1], "  Shared    you'll be asked (Yes is the default)");
});

test('dry run: a found key names its source and says it was not checked', () => {
  const plan = signedInPlan();
  plan.project = null;
  plan.shared = { decided: false, share: false, saved: false, frontend: [], backend: [], aiTool: '' };
  plan.account = { kind: 'found', source: 'env' };
  assert.equal(renderPlan(plan)[2], '  Account   key found (PINSAY_API_KEY), not checked in a dry run');
  plan.account = { kind: 'found', source: 'repo' };
  assert.equal(renderPlan(plan)[2], '  Account   key found (this repo), not checked in a dry run');
  plan.account = { kind: 'found', source: 'global' };
  assert.equal(renderPlan(plan)[2], '  Account   key found (this machine), not checked in a dry run');
});

test('an undecided share with a saved answer says so', () => {
  const plan = signedInPlan();
  plan.shared = { decided: false, share: false, saved: true, frontend: [], backend: [], aiTool: '' };
  const lines = renderPlan(plan);
  assert.equal(lines[lines.length - 1], "  Shared    you'll be asked (Yes is the default) (saved answer)");
});

test('wrapped Files lines stay within 80 columns', () => {
  const plan = signedInPlan();
  plan.files = [
    '.pinsay/config.json',
    '.pinsay/stack.json',
    '.pinsay/credentials.env',
    '.git/info/exclude',
    'src/vite.config.ts',
    'index.html',
    '.env.development',
    '.env.production',
    'public/widget-loader.js',
    'docs/install-notes.md',
    'src/main.tsx',
    'src/App.tsx',
  ];
  const lines = renderPlan(plan);
  const filesIndex = lines.findIndex((line) => line.startsWith('  Files'));
  assert.ok(filesIndex > 0);
  assert.ok(lines[filesIndex + 1].startsWith('            '));
  for (const line of lines) {
    if (line.startsWith('  Files') || line.startsWith('            ')) {
      assert.ok(line.length <= 80, `line longer than 80 columns: ${line}`);
    }
  }
});

test('planToJson carries the machine-readable fields', () => {
  const plan = signedInPlan();
  assert.deepEqual(planToJson(plan), {
    project: { key: 'my-app', name: 'My App', create: false },
    account: 'Jane Doe · key saved in this repo (.pinsay/credentials.env, hidden from git)',
    keySaved: 'repo',
    delivery: 'extension',
    skills: plan.skills,
    files: plan.files,
    shared: 'framework names: react, vite · AI tool: claude-code · "setup done" signal',
  });
  plan.project = null;
  plan.account = { kind: 'pending' };
  plan.widget = { kind: 'embed', files: ['index.html'] };
  const dry = planToJson(plan);
  assert.equal(dry.project, null);
  assert.equal(dry.keySaved, null);
  assert.equal(dry.account, "you'll sign in in your browser");
  assert.equal(dry.delivery, 'embed');
});
