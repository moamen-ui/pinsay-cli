import { test } from 'node:test';
import * as assert from 'node:assert';
import { detectStack, detectAppUrl } from '../src/detect.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('detectStack detects Next.js', () => withTempDir(async (dir) => {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    dependencies: { next: '14.0.0' }
  }));
  const res = await detectStack(dir);
  assert.strictEqual(res.kind, 'next');
  
  const urlRes = await detectAppUrl(dir, res.kind, 'local');
  assert.strictEqual(urlRes.url, 'http://localhost:3000');
}));

test('detectStack detects Vite', () => withTempDir(async (dir) => {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    devDependencies: { vite: '5.0.0' },
    scripts: { dev: 'vite --port 4000' }
  }));
  const res = await detectStack(dir);
  assert.strictEqual(res.kind, 'vite');
  
  const urlRes = await detectAppUrl(dir, res.kind, 'local');
  assert.strictEqual(urlRes.url, 'http://localhost:4000');
}));

test('detectStack detects Vite config port', () => withTempDir(async (dir) => {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    devDependencies: { vite: '5.0.0' }
  }));
  await fs.writeFile(path.join(dir, 'vite.config.ts'), 'export default { server: { port: 4000 } }');
  const res = await detectStack(dir);
  assert.strictEqual(res.kind, 'vite');
  
  const urlRes = await detectAppUrl(dir, res.kind, 'local');
  assert.strictEqual(urlRes.url, 'http://localhost:4000');
}));

test('detectStack fallback to static', () => withTempDir(async (dir) => {
  await fs.writeFile(path.join(dir, 'index.html'), '<html></html>');
  const res = await detectStack(dir);
  assert.strictEqual(res.kind, 'static');
  
  const urlRes = await detectAppUrl(dir, res.kind, 'local');
  assert.strictEqual(urlRes.url, null);
}));

test('detectStack detects Angular', () => withTempDir(async (dir) => {
  await fs.writeFile(path.join(dir, 'angular.json'), JSON.stringify({
    projects: {
        app: {
            architect: {
                serve: {
                    options: {
                        port: 4201
                    }
                }
            }
        }
    }
  }));
  const res = await detectStack(dir);
  assert.strictEqual(res.kind, 'angular');
  
  const urlRes = await detectAppUrl(dir, res.kind, 'local');
  assert.strictEqual(urlRes.url, 'http://localhost:4201');
}));
