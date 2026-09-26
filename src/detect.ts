import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';

export type AppType = 'next' | 'vite' | 'angular' | 'cra' | 'monorepo' | 'static' | 'unknown';

export interface DetectionResult {
  kind: AppType;
  evidence: string[];
  htmlPath?: string;
  appUrl?: { url: string | null; source: string };
}

async function readFileSafe(path: string): Promise<string> {
  try { return await fs.readFile(path, 'utf8'); } catch { return ''; }
}

export async function detectAppUrl(cwd: string, kind: AppType, envName: string): Promise<{ url: string | null; source: string }> {
  if (envName !== 'local') return { url: null, source: 'environment not local' };
  
  if (kind === 'vite') {
    const exts = ['js', 'ts', 'mjs', 'mts'];
    for (const ext of exts) {
      const cfg = await readFileSafe(join(cwd, `vite.config.${ext}`));
      if (cfg) {
        let port = 5173;
        let isHttps = false;
        const portMatch = cfg.match(/port\s*:\s*(\d+)/);
        if (portMatch) port = parseInt(portMatch[1], 10);
        if (cfg.match(/https\s*:\s*(true|{)/)) isHttps = true;
        
        if (portMatch || isHttps) {
          return { url: `http${isHttps ? 's' : ''}://localhost:${port}`, source: `vite.config.${ext}:server` };
        }
      }
    }
    const pkgStr = await readFileSafe(join(cwd, 'package.json'));
    if (pkgStr) {
      try {
        const pkg = JSON.parse(pkgStr);
        if (pkg.scripts && pkg.scripts.dev) {
          const pm = pkg.scripts.dev.match(/--port\s+(\d+)/);
          if (pm) return { url: `http://localhost:${pm[1]}`, source: 'package.json:scripts.dev' };
        }
      } catch {}
    }
    return { url: 'http://localhost:5173', source: 'vite default' };
  }
  
  if (kind === 'next') {
    const pkgStr = await readFileSafe(join(cwd, 'package.json'));
    if (pkgStr) {
      try {
        const pkg = JSON.parse(pkgStr);
        if (pkg.scripts && pkg.scripts.dev) {
          const pm = pkg.scripts.dev.match(/(?:-p|--port)\s+(\d+)/);
          if (pm) return { url: `http://localhost:${pm[1]}`, source: 'package.json:scripts.dev' };
        }
      } catch {}
    }
    const envs = ['.env', '.env.local', '.env.development'];
    for (const e of envs) {
      const env = await readFileSafe(join(cwd, e));
      const m = env.match(/^PORT=(\d+)/m);
      if (m) return { url: `http://localhost:${m[1]}`, source: `${e}:PORT` };
    }
    return { url: 'http://localhost:3000', source: 'next default' };
  }
  
  if (kind === 'angular') {
    const angularJsonStr = await readFileSafe(join(cwd, 'angular.json'));
    if (angularJsonStr) {
      try {
        const angularJson = JSON.parse(angularJsonStr);
        const projects = angularJson.projects || {};
        for (const proj of Object.values<any>(projects)) {
          if (proj.architect?.serve?.options) {
            const opts = proj.architect.serve.options;
            const port = opts.port || 4200;
            const isSsl = opts.ssl === true;
            return { url: `http${isSsl ? 's' : ''}://localhost:${port}`, source: 'angular.json:serve.options' };
          }
        }
      } catch {}
    }
    const pkgStr = await readFileSafe(join(cwd, 'package.json'));
    if (pkgStr) {
      try {
        const pkg = JSON.parse(pkgStr);
        if (pkg.scripts && pkg.scripts.start) {
          const pm = pkg.scripts.start.match(/--port\s+(\d+)/);
          if (pm) return { url: `http://localhost:${pm[1]}`, source: 'package.json:scripts.start' };
        }
      } catch {}
    }
    return { url: 'http://localhost:4200', source: 'angular default' };
  }
  
  if (kind === 'cra') {
    const pkgStr = await readFileSafe(join(cwd, 'package.json'));
    if (pkgStr) {
      try {
        const pkg = JSON.parse(pkgStr);
        if (pkg.scripts && pkg.scripts.start) {
          const pm = pkg.scripts.start.match(/PORT=(\d+)/);
          if (pm) return { url: `http://localhost:${pm[1]}`, source: 'package.json:scripts.start' };
        }
      } catch {}
    }
    const envs = ['.env', '.env.local', '.env.development'];
    for (const e of envs) {
      const env = await readFileSafe(join(cwd, e));
      const m = env.match(/^PORT=(\d+)/m);
      if (m) return { url: `http://localhost:${m[1]}`, source: `${e}:PORT` };
    }
    return { url: 'http://localhost:3000', source: 'cra default' };
  }
  
  return { url: null, source: 'no default for stack' };
}

export async function detectStack(cwd: string): Promise<{ kind: AppType, evidence: string[], htmlPath?: string }> {
  const pkgStr = await readFileSafe(join(cwd, 'package.json'));
  let pkg: any = {};
  if (pkgStr) {
    try { pkg = JSON.parse(pkgStr); } catch {}
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasIndexHtml = existsSync(join(cwd, 'index.html'));
  // Fallbacks beyond the root `index.html`, for a standalone app laid out the way every app in an
  // Nx (or Nx-style) workspace is: `src/index.html` (Vite/webpack's convention) or
  // `public/index.html` (CRA). Checked in this order; the first that exists wins. Kept separate
  // from `hasIndexHtml` above, which is specifically "does cwd itself look like a monorepo ROOT"
  // and must stay keyed on the root file only.
  const htmlFallback = ['index.html', 'src/index.html', 'public/index.html']
    .map((rel) => ({ rel, abs: join(cwd, rel) }))
    .find(({ abs }) => existsSync(abs));

  const evidence: string[] = [];

  if (deps.vite) {
    evidence.push('package.json (vite)');
    for (const ext of ['js', 'ts', 'mjs', 'mts']) {
      if (existsSync(join(cwd, `vite.config.${ext}`))) evidence.push(`vite.config.${ext}`);
    }
    if (htmlFallback) evidence.push(htmlFallback.rel);
    return { kind: 'vite', evidence, htmlPath: htmlFallback?.abs };
  }
  
  if (deps.next) {
    evidence.push('package.json (next)');
    for (const ext of ['js', 'mjs', 'ts']) {
      if (existsSync(join(cwd, `next.config.${ext}`))) evidence.push(`next.config.${ext}`);
    }
    if (existsSync(join(cwd, 'app'))) evidence.push('app/');
    return { kind: 'next', evidence };
  }
  
  if (existsSync(join(cwd, 'angular.json'))) {
    evidence.push('angular.json');
    return { kind: 'angular', evidence };
  }
  
  if (deps['react-scripts']) {
    evidence.push('package.json (react-scripts)');
    return { kind: 'cra', evidence };
  }
  
  for (const wcfg of ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json']) {
    if (existsSync(join(cwd, wcfg))) {
      evidence.push(wcfg);
      if (!hasIndexHtml) return { kind: 'monorepo', evidence };
    }
  }
  
  if (pkg.workspaces && !hasIndexHtml) {
    evidence.push('package.json (workspaces)');
    return { kind: 'monorepo', evidence };
  }
  
  if (htmlFallback && !pkgStr) {
    evidence.push(htmlFallback.rel);
    return { kind: 'static', evidence, htmlPath: htmlFallback.abs };
  }

  return { kind: 'unknown', evidence };
}

export function extractTokens(pkg: any): { frontend: string[], backend: string[] } {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const frontend: string[] = [];
  const backend: string[] = [];
  
  if (deps.react) frontend.push('react');
  if (deps.vue) frontend.push('vue');
  if (deps.svelte) frontend.push('svelte');
  if (deps['solid-js']) frontend.push('solid');
  if (deps['@angular/core']) frontend.push('angular');
  if (deps.next) frontend.push('next');
  if (deps.tailwindcss) frontend.push('tailwind');
  if (deps.vite) frontend.push('vite');
  
  if (deps.express || deps.fastify || deps.nest) backend.push('node');
  
  return { frontend, backend };
}
