import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentHash, addToManifest, type Manifest } from '../src/vite/hash.js';
import { stampSource } from '../src/vite/transform.js';

const ATTR = 'data-component-source';
const stamp = (code: string, path = 'src/C.tsx') => stampSource(code, path, ATTR);

test('the hash depends on path and export name only', () => {
  const a = componentHash('src/components/PlanSelect.tsx', 'PlanSelect');

  // Stable across calls, and independent of file CONTENTS — a hash that moved on every edit would
  // invalidate every stamped element and defeat the manifest's whole purpose.
  assert.equal(a, componentHash('src/components/PlanSelect.tsx', 'PlanSelect'));
  assert.equal(a.length, 8);
  assert.match(a, /^[0-9a-f]{8}$/);

  // Moving or renaming DOES change it — that is when the old identity stopped being true.
  assert.notEqual(a, componentHash('src/other/PlanSelect.tsx', 'PlanSelect'));
  assert.notEqual(a, componentHash('src/components/PlanSelect.tsx', 'PlanPicker'));
});

test('the hash is identical on Windows and POSIX checkouts', () => {
  assert.equal(
    componentHash('src\\components\\PlanSelect.tsx', 'PlanSelect'),
    componentHash('src/components/PlanSelect.tsx', 'PlanSelect'),
  );
});

test('a manifest collision is an error, never a silent overwrite', () => {
  const m: Manifest = {};
  addToManifest(m, 'abc12345', { path: 'a.tsx', export: 'A' });

  // Re-adding the same entry is fine (a file is transformed more than once in watch mode).
  addToManifest(m, 'abc12345', { path: 'a.tsx', export: 'A' });

  // A different component on the same hash would point every comment at the wrong file.
  assert.throws(() => addToManifest(m, 'abc12345', { path: 'b.tsx', export: 'B' }), /collision/i);
});

test('stamps the root host element of a component', async () => {
  const out = await stamp(`export function Card() { return <div className="x">hi</div>; }`);
  const hash = componentHash('src/C.tsx', 'Card');

  assert.ok(out.changed);
  assert.ok(out.code.includes(`${ATTR}="${hash}"`));
  assert.deepEqual(out.components[hash], { path: 'src/C.tsx', export: 'Card' });
});

test('stamps every top-level child of a fragment', async () => {
  const out = await stamp(`export function Two() { return <><header/><main/></>; }`);
  const hash = componentHash('src/C.tsx', 'Two');

  assert.equal(out.code.split(`${ATTR}="${hash}"`).length - 1, 2);
});

test('stamps both branches of a conditional root', async () => {
  const out = await stamp(`export function Maybe({ok}) { return ok ? <div/> : <span/>; }`);
  const hash = componentHash('src/C.tsx', 'Maybe');

  assert.equal(out.code.split(`${ATTR}="${hash}"`).length - 1, 2);
});

test('does NOT stamp when the root is another component', async () => {
  // Card stamps its own root; the widget's ancestor walk finds it. Stamping here would attach
  // Wrapper's identity to markup Card owns.
  const out = await stamp(`export function Wrapper() { return <Card/>; }`);

  assert.equal(out.changed, false);
  assert.ok(!out.code.includes(ATTR));
});

test('leaves an element that is already stamped alone', async () => {
  const code = `export function Card() { return <div ${ATTR}="deadbeef">hi</div>; }`;
  const out = await stamp(code);

  assert.equal(out.changed, false);
  assert.equal(out.code.split('deadbeef').length - 1, 1);
});

test('ignores helpers — only capitalised components are stamped', async () => {
  const out = await stamp(`function renderRow() { return <tr/>; }`);

  assert.equal(out.changed, false);
  assert.deepEqual(out.components, {});
});

test('names an HOC-wrapped component by its assigned name', async () => {
  const out = await stamp(`export const PlanSelect = memo(function PlanSelect() { return <div/>; });`);
  const hash = componentHash('src/C.tsx', 'PlanSelect');

  assert.ok(out.code.includes(`${ATTR}="${hash}"`));
  assert.equal(out.components[hash].export, 'PlanSelect');
});

test('handles a concise arrow body', async () => {
  const out = await stamp(`export const Chip = () => <span/>;`);
  const hash = componentHash('src/C.tsx', 'Chip');

  assert.ok(out.code.includes(`${ATTR}="${hash}"`));
});

test('stamps every top-level element of a Vue template', async () => {
  const out = await stampSource(
    `<template>\n  <header/>\n  <main class="a">x</main>\n</template>\n<script setup>const a = 1;</script>`,
    'src/Panel.vue',
    ATTR,
  );
  const hash = componentHash('src/Panel.vue', 'Panel');

  assert.ok(out.changed);
  assert.equal(out.code.split(`${ATTR}="${hash}"`).length - 1, 2);
  // The script block is untouched — the transform only ever adds a markup attribute.
  assert.ok(out.code.includes('const a = 1;'));
});

test('the transform adds an attribute and changes nothing else', async () => {
  const code = `export function Card({n}) {\n  const doubled = n * 2;\n  return <div onClick={() => save(doubled)}>{doubled}</div>;\n}`;
  const out = await stamp(code);

  // Every piece of behaviour survives verbatim; only the attribute is new.
  assert.ok(out.code.includes('const doubled = n * 2;'));
  assert.ok(out.code.includes('onClick'));
  assert.ok(out.code.includes('save(doubled)'));
  assert.ok(out.code.includes(ATTR));
});
