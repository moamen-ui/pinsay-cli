import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import {
  buildRequestBody,
  formatStackJson,
  mergeStack,
  readStackFile,
  writeStackFile,
  type StackData,
} from '../src/stack/stackfile.js';
import type { DesignBlock } from '../src/stack/design.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

test('stackfile: buildRequestBody strips design key for every fixture', () => {
  const sampleDesign: DesignBlock = {
    version: 1,
    libraries: [{ name: 'shadcn', version: null }],
    tokens: {
      tailwind: { config: 'tailwind.config.ts', colors: ['primary', 'secondary'] },
      cssVars: { files: ['src/styles/globals.css'], names: ['--brand'] },
    },
    guidance: 'Prefer existing tokens.',
  };

  const stacks: StackData[] = [
    { frontend: ['react', 'tailwind'], backend: ['dotnet'], aiTools: ['claude-code'], design: sampleDesign },
    { frontend: ['vue'], backend: null, aiTools: ['cursor'], design: sampleDesign },
    { frontend: ['angular'], backend: ['node'], aiTools: ['antigravity'], design: sampleDesign },
    { frontend: ['static'], backend: null, design: sampleDesign },
    { design: sampleDesign },
  ];

  for (const s of stacks) {
    const body: any = buildRequestBody(s);
    assert.equal('design' in body, false, 'buildRequestBody output must never contain a design key');
    assert.deepEqual(body.frontend, s.frontend);
    assert.deepEqual(body.backend, s.backend);
    assert.deepEqual(body.aiTools, s.aiTools);
  }
});

test('stackfile: mergeStack preserves frontend/backend/aiTools and updates design', () => {
  const existing: StackData = {
    frontend: ['react'],
    backend: ['dotnet'],
    aiTools: ['claude-code'],
  };

  const serverResponse = {
    data: {
      frontend: ['react', 'tailwind'],
      backend: ['dotnet', 'postgres'],
      aiTools: ['claude-code', 'cursor'],
    },
  };

  const design: DesignBlock = {
    version: 1,
    libraries: [],
    tokens: {
      tailwind: { config: 'tailwind.config.ts', colors: ['primary'] },
    },
    guidance: 'Prefer existing tokens.',
  };

  const merged = mergeStack(existing, serverResponse.data, design);
  // Local detection is the fresh reading for this machine — it wins over the server's copy, which
  // may predate a framework migration. aiTools are the server's union across every tool ever used.
  assert.deepEqual(merged.frontend, ['react']);
  assert.deepEqual(merged.backend, ['dotnet']);
  assert.deepEqual(merged.aiTools, ['claude-code', 'cursor']);
  assert.deepEqual(merged.design, design);
});

test('stackfile: mergeStack falls back to the server stack when local detection found nothing', () => {
  // `init` from a repo root with no package.json: nothing detected locally, so the server record
  // (registered by someone running from the app dir) is the best available answer.
  const merged = mergeStack(
    { frontend: [], backend: [], aiTools: [] },
    { frontend: ['react', 'vite'], backend: null, aiTools: ['claude-code'] },
    null,
  );
  assert.deepEqual(merged.frontend, ['react', 'vite']);
  assert.equal(merged.backend, null);
  assert.deepEqual(merged.aiTools, ['claude-code']);
});

test('stackfile: canonical key order and byte-identical determinism', () => {
  const stack: StackData = {
    backend: ['dotnet', 'postgres'],
    frontend: ['tailwind', 'react'],
    aiTools: ['cursor', 'claude-code'],
    design: {
      guidance: 'Prefer existing tokens.',
      version: 1,
      tokens: {
        cssVars: {
          names: ['--radius', '--brand', '--primary'],
          files: ['src/styles/globals.css'],
        },
        tailwind: {
          colors: ['secondary', 'muted', 'primary'],
          config: 'tailwind.config.ts',
          radius: ['lg', 'sm', 'md'],
          fontFamily: ['sans', 'mono'],
        },
      },
      libraries: [
        { version: '1.0.0', name: 'bootstrap' },
        { version: null, name: 'shadcn' },
      ],
    },
  };

  const output1 = formatStackJson(stack);
  const output2 = formatStackJson(stack);

  // Deterministic byte equality
  assert.equal(output1, output2);
  assert.equal(sha256(output1), sha256(output2));

  // Starts with top-level frontend
  assert.ok(output1.startsWith('{\n  "frontend": [\n'));

  // Single trailing newline and ends with }\n
  assert.ok(output1.endsWith('}\n'));
  assert.ok(!output1.endsWith('\n\n'));

  // Zero carriage returns
  assert.ok(!output1.includes('\r'));

  // Zero detectedAt
  assert.ok(!output1.includes('detectedAt'));

  // Top level key order: frontend, backend, aiTools, design
  const topKeys = Object.keys(JSON.parse(output1));
  assert.deepEqual(topKeys, ['frontend', 'backend', 'aiTools', 'design']);

  // Inside design: version, libraries, tokens, guidance
  const parsed = JSON.parse(output1);
  const designKeys = Object.keys(parsed.design);
  assert.deepEqual(designKeys, ['version', 'libraries', 'tokens', 'guidance']);

  // Inside tokens: tailwind, cssVars (present keys only, in that order)
  const tokenKeys = Object.keys(parsed.design.tokens);
  assert.deepEqual(tokenKeys, ['tailwind', 'cssVars']);

  // Libraries sorted by name
  assert.deepEqual(parsed.design.libraries, [
    { version: '1.0.0', name: 'bootstrap' },
    { version: null, name: 'shadcn' },
  ]);

  // Arrays sorted alphabetically
  assert.deepEqual(parsed.design.tokens.tailwind.colors, ['muted', 'primary', 'secondary']);
  assert.deepEqual(parsed.design.tokens.tailwind.radius, ['lg', 'md', 'sm']);
  assert.deepEqual(parsed.design.tokens.tailwind.fontFamily, ['mono', 'sans']);
  assert.deepEqual(parsed.design.tokens.cssVars.names, ['--brand', '--primary', '--radius']);
});

test('stackfile: writeStackFile and readStackFile round-trip', async () => {
  const tmp = await fs.mkdtemp(join(os.tmpdir(), 'ptr-stackfile-'));
  try {
    const stack: StackData = {
      frontend: ['react'],
      backend: null,
      aiTools: ['claude-code'],
      design: {
        version: 1,
        libraries: [],
        tokens: {},
        guidance: "No design tokens detected; match the nearest sibling element's existing classes/styles.",
      },
    };

    await writeStackFile(tmp, stack);
    const readBack = await readStackFile(tmp);
    assert.ok(readBack);
    assert.deepEqual(readBack.frontend, stack.frontend);
    assert.deepEqual(readBack.design, stack.design);

    // Re-writing produces identical file bytes
    const beforeContent = await fs.readFile(join(tmp, '.pinsay/stack.json'), 'utf8');
    await writeStackFile(tmp, readBack);
    const afterContent = await fs.readFile(join(tmp, '.pinsay/stack.json'), 'utf8');
    assert.equal(beforeContent, afterContent);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
