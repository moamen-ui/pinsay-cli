import { promises as fs, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export type LibraryInfo = {
  name: string;
  version: string | null;
};

export type TailwindTokens = {
  config: string;
  colors?: string[];
  radius?: string[];
  fontFamily?: string[];
  spacingCount?: number;
};

export type CssVarsTokens = {
  files: string[];
  names: string[];
};

export type ScssTokens = {
  files: string[];
  names: string[];
};

export type ThemeTokens = {
  files?: string[];
  colors?: string[];
};

export type AngularMaterialTokens = {
  palettes?: string[];
};

export type DesignTokens = {
  tailwind?: TailwindTokens;
  cssVars?: CssVarsTokens;
  scss?: ScssTokens;
  theme?: ThemeTokens;
  angularMaterial?: AngularMaterialTokens;
};

export type DesignBlock = {
  version: number;
  libraries: LibraryInfo[];
  tokens: DesignTokens;
  guidance: string;
};

export type ScanOptions = {
  maxFiles?: number;
  timeoutMs?: number;
  readFile?: (filePath: string) => Promise<string>;
  listFiles?: () => Promise<string[]>;
  /**
   * Repo root, when it differs from `cwd` — the app being scanned may sit several directories
   * below it (a monorepo app), and its `package.json` (if it even has one), any shared
   * tailwind/postcss config, and any shared `styles/` directory can live up there instead. Defaults
   * to `cwd`, which reproduces the old single-project-only behaviour exactly.
   */
  root?: string;
};

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.git',
  '.pinsay',
  'coverage',
  '.cache',
  '.turbo',
  '.output',
]);

/**
 * Finds files under cwd up to maxFiles or timeoutMs, excluding common artifact/cache directories.
 */
export async function collectFiles(cwd: string, options?: ScanOptions): Promise<string[]> {
  if (options?.listFiles) {
    return await options.listFiles();
  }

  const maxFiles = options?.maxFiles ?? 500;
  const timeoutMs = options?.timeoutMs ?? 2000;
  const start = Date.now();
  const collected: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (collected.length >= maxFiles || Date.now() - start >= timeoutMs) return;

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    // Files in this directory FIRST, subdirectories after. readdir order is alphabetical, so with a
    // depth-first walk `src/` (hundreds of files) was consumed before `tailwind.config.js` at the app
    // root and the 500-file cap was hit with the config never listed — Tailwind detection then found
    // nothing in a real Nx app. Breadth-first keeps every top-level config file inside the cap.
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (collected.length >= maxFiles || Date.now() - start >= timeoutMs) return;
      if (IGNORED_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        subdirs.push(fullPath);
      } else if (stat.isFile()) {
        collected.push(relative(cwd, fullPath));
      }
    }
    for (const sub of subdirs) {
      if (collected.length >= maxFiles || Date.now() - start >= timeoutMs) return;
      await walk(sub);
    }
  }

  await walk(cwd);
  return collected;
}

/**
 * Helper to slice a balanced block starting from opening delimiter '{' or '['.
 */
function extractBalancedBlock(content: string, startIndex: number): { block: string; endIndex: number } | null {
  const openChar = content[startIndex];
  const closeChar = openChar === '{' ? '}' : openChar === '[' ? ']' : null;
  if (!closeChar) return null;

  let depth = 0;
  let inString: string | null = null;
  let isEscaped = false;

  for (let i = startIndex; i < content.length; i++) {
    const char = content[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }

    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return {
          block: content.slice(startIndex + 1, i),
          endIndex: i,
        };
      }
    }
  }

  return null;
}

/**
 * Parses keys from an object literal block text, flattening nested objects one level.
 */
function parseObjectKeys(blockText: string): string[] {
  const keys: string[] = [];
  let idx = 0;

  while (idx < blockText.length) {
    // Match key pattern: identifier, 'quoted', or "quoted"
    const match = blockText.slice(idx).match(/(?:^|[,{\s])([a-zA-Z0-9_-]+|'[^']+'|"[^"]+")\s*:/);
    if (!match || match.index === undefined) break;

    const keyRaw = match[1];
    const key = keyRaw.replace(/^['"]|['"]$/g, '');
    const afterColon = idx + match.index + match[0].length;

    // Skip whitespace to see what comes next
    let valStart = afterColon;
    while (valStart < blockText.length && /\s/.test(blockText[valStart])) valStart++;

    if (valStart < blockText.length && blockText[valStart] === '{') {
      const sub = extractBalancedBlock(blockText, valStart);
      if (sub) {
        // Flatten one level
        const subKeys = parseObjectKeys(sub.block);
        for (const sk of subKeys) {
          keys.push(`${key}.${sk}`);
        }
        idx = sub.endIndex + 1;
        continue;
      }
    }

    keys.push(key);
    idx = valStart + 1;
  }

  return keys;
}

/**
 * Parses string items from an array or keys from an object.
 */
function parseArrayOrObjectKeys(content: string, matchIndex: number): string[] {
  let idx = matchIndex;
  while (idx < content.length && /\s/.test(content[idx])) idx++;

  if (idx < content.length && content[idx] === '[') {
    const balanced = extractBalancedBlock(content, idx);
    if (!balanced) return [];
    const items = [...balanced.block.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    return items;
  }

  if (idx < content.length && content[idx] === '{') {
    const balanced = extractBalancedBlock(content, idx);
    if (!balanced) return [];
    return parseObjectKeys(balanced.block);
  }

  return [];
}

/**
 * Merges `package.json` dependencies + devDependencies from every directory on the path from
 * `root` down to `cwd`, inclusive of both. Read shallow (root) to deep (cwd/app) so that
 * `Object.assign` lets a deeper, app-level entry win over a same-named root-level one — an app
 * pinning its own version of something the root also declares should be read as ITS version.
 *
 * A monorepo app frequently has no `package.json` of its own at all (deps live solely at the
 * workspace root); this still finds them, because the chain includes root even when cwd yields
 * nothing.
 */
async function collectDependencyChain(
  cwd: string,
  root: string,
  readFile: (p: string) => Promise<string>,
): Promise<Record<string, string>> {
  const cwdAbs = resolve(cwd);
  const rootAbs = resolve(root);

  const dirs: string[] = [];
  let dir = cwdAbs;
  while (true) {
    dirs.push(dir);
    if (dir === rootAbs) break;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root without finding `root` — stop rather than loop forever
    dir = parent;
  }
  dirs.reverse(); // root (or as close to it as we got) first, cwd last

  const merged: Record<string, string> = {};
  for (const d of dirs) {
    try {
      const pkg = JSON.parse(await readFile(join(d, 'package.json')));
      Object.assign(merged, pkg.dependencies, pkg.devDependencies);
    } catch {
      // no package.json at this level, or unreadable/unparsable — just skip it
    }
  }
  return merged;
}

/**
 * Root-level shared style locations used as a fallback when the app dir itself has none:
 * `styles/`, `src/styles/`, and `libs/**\/styles/` (any depth) relative to the repo root.
 */
function isRootSharedStylePath(f: string): boolean {
  if (f.startsWith('styles/') || f.startsWith('src/styles/')) return true;
  if (f.startsWith('libs/') && f.includes('/styles/')) return true;
  return false;
}

/**
 * Detects Tailwind configuration or v4 @theme declarations. A config found directly in `cwd` is
 * always this app's own, even when `tailwindcss` itself is only declared as a dependency at
 * `root` (an app dir need not have its own package.json at all). When `cwd` has no config of its
 * own, a config at `root` is accepted as a fallback — a monorepo may share one Tailwind config
 * across every app rather than duplicating it per app.
 */
export async function detectTailwind(
  cwd: string,
  files: string[],
  readFile: (p: string) => Promise<string>,
  root: string = cwd,
): Promise<TailwindTokens | null> {
  const configNames = [
    'tailwind.config.ts',
    'tailwind.config.js',
    'tailwind.config.cjs',
    'tailwind.config.mjs',
  ];

  let foundConfigFile: string | null = null;
  let configAbsPath: string | null = null;
  for (const name of configNames) {
    // Existence check rather than `files.includes`: the listing is capped and time-boxed, so a
    // config file must never depend on having made it into that list.
    let exists = files.includes(name);
    if (!exists) {
      try { await readFile(join(cwd, name)); exists = true; } catch { exists = false; }
    }
    if (exists) {
      foundConfigFile = name;
      configAbsPath = join(cwd, name);
      break;
    }
  }

  if (!foundConfigFile && resolve(root) !== resolve(cwd)) {
    for (const name of configNames) {
      const candidate = join(root, name);
      try {
        await readFile(candidate);
        foundConfigFile = relative(cwd, candidate);
        configAbsPath = candidate;
        break;
      } catch {
        // not at root either — try the next name
      }
    }
  }

  if (foundConfigFile && configAbsPath) {
    let content = '';
    try {
      content = await readFile(configAbsPath);
    } catch {
      return null;
    }

    const colorsSet = new Set<string>();
    const radiusSet = new Set<string>();
    const fontSet = new Set<string>();

    // 1. Extract colors from extend.colors or theme.colors
    const colorMatches = [...content.matchAll(/\bcolors\s*:\s*\{/g)];
    for (const cm of colorMatches) {
      if (cm.index !== undefined) {
        const start = cm.index + cm[0].length - 1; // pointing at '{'
        const balanced = extractBalancedBlock(content, start);
        if (balanced) {
          const keys = parseObjectKeys(balanced.block);
          for (const k of keys) colorsSet.add(k);
        }
      }
    }

    // 2. Extract borderRadius
    const radiusMatches = [...content.matchAll(/\bborderRadius\s*:\s*/g)];
    for (const rm of radiusMatches) {
      if (rm.index !== undefined) {
        const keys = parseArrayOrObjectKeys(content, rm.index + rm[0].length);
        for (const k of keys) radiusSet.add(k);
      }
    }

    // 3. Extract fontFamily
    const fontMatches = [...content.matchAll(/\bfontFamily\s*:\s*/g)];
    for (const fm of fontMatches) {
      if (fm.index !== undefined) {
        const keys = parseArrayOrObjectKeys(content, fm.index + fm[0].length);
        for (const k of keys) fontSet.add(k);
      }
    }

    // 4. Spacing keys count if present
    let spacingCount: number | undefined;
    const spacingMatch = content.match(/\bspacing\s*:\s*\{/);
    if (spacingMatch && spacingMatch.index !== undefined) {
      const balanced = extractBalancedBlock(content, spacingMatch.index + spacingMatch[0].length - 1);
      if (balanced) {
        const keys = parseObjectKeys(balanced.block);
        spacingCount = keys.length;
      }
    }

    const result: TailwindTokens = {
      config: foundConfigFile,
    };

    if (colorsSet.size > 0) result.colors = Array.from(colorsSet).sort();
    if (radiusSet.size > 0) result.radius = Array.from(radiusSet).sort();
    if (fontSet.size > 0) result.fontFamily = Array.from(fontSet).sort();
    if (spacingCount !== undefined) result.spacingCount = spacingCount;

    return result;
  }

  // Check for Tailwind v4 (@import "tailwindcss" / @theme in any css under src/)
  const cssFiles = files.filter((f) => f.startsWith('src/') && f.endsWith('.css'));
  for (const file of cssFiles) {
    let content = '';
    try {
      content = await readFile(join(cwd, file));
    } catch {
      continue;
    }

    const isTailwindV4 = content.includes('@import "tailwindcss"') ||
      content.includes("@import 'tailwindcss'") ||
      content.includes('@theme');

    if (isTailwindV4) {
      const colorsSet = new Set<string>();
      const radiusSet = new Set<string>();
      const fontSet = new Set<string>();

      const themeBlocks = [...content.matchAll(/@theme\s*\{/g)];
      for (const tm of themeBlocks) {
        if (tm.index !== undefined) {
          const balanced = extractBalancedBlock(content, tm.index + tm[0].length - 1);
          if (balanced) {
            // Match custom property declarations
            const varMatches = [...balanced.block.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)];
            for (const vm of varMatches) {
              const name = vm[1];
              if (name.startsWith('--color-')) {
                colorsSet.add(name);
              } else if (name.startsWith('--radius-')) {
                radiusSet.add(name);
              } else if (name.startsWith('--font-')) {
                fontSet.add(name);
              }
            }
          }
        }
      }

      const result: TailwindTokens = {
        config: file,
      };

      if (colorsSet.size > 0) result.colors = Array.from(colorsSet).sort();
      if (radiusSet.size > 0) result.radius = Array.from(radiusSet).sort();
      if (fontSet.size > 0) result.fontFamily = Array.from(fontSet).sort();

      return result;
    }
  }

  return null;
}

/**
 * Core CSS-custom-property scan, shared by `detectCssVars` (scoped to the app dir's own files) and
 * `detectDesignTokens`'s root-level fallback (scoped to shared style locations at the repo root)
 * — same 20-smallest/<=200KB caps either way, just against a different `baseDir` + candidate list.
 */
async function scanCssVars(
  baseDir: string,
  candidatePaths: string[],
  readFile: (p: string) => Promise<string>,
): Promise<CssVarsTokens | null> {
  const candidateFiles: { path: string; size: number }[] = [];

  for (const f of candidatePaths) {
    try {
      const fullPath = join(baseDir, f);
      const stat = statSync(fullPath);
      if (stat.size <= 204800) {
        candidateFiles.push({ path: f, size: stat.size });
      }
    } catch {
      // Fallback for mocked files: size 1
      candidateFiles.push({ path: f, size: 1 });
    }
  }

  // Sort by size ascending, then path ascending
  candidateFiles.sort((a, b) => {
    if (a.size !== b.size) return a.size - b.size;
    return a.path.localeCompare(b.path);
  });

  const selectedFiles = candidateFiles.slice(0, 20);
  const matchedFiles = new Set<string>();
  const propertyNames = new Set<string>();

  for (const item of selectedFiles) {
    let content = '';
    try {
      content = await readFile(join(baseDir, item.path));
    } catch {
      continue;
    }

    const rootMatches = [...content.matchAll(/(?::root|html)\s*\{/g)];
    let fileHadProperty = false;

    for (const rm of rootMatches) {
      if (rm.index !== undefined) {
        const balanced = extractBalancedBlock(content, rm.index + rm[0].length - 1);
        if (balanced) {
          const varDecls = [...balanced.block.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)];
          for (const vd of varDecls) {
            propertyNames.add(vd[1]);
            fileHadProperty = true;
          }
        }
      }
    }

    if (fileHadProperty) {
      matchedFiles.add(item.path);
    }
  }

  if (propertyNames.size === 0) return null;

  const names = Array.from(propertyNames).sort().slice(0, 60);
  const filesList = Array.from(matchedFiles).sort();

  return {
    files: filesList,
    names,
  };
}

/**
 * Detects CSS custom properties from the 20 smallest files under src, <= 200 KB.
 */
export async function detectCssVars(
  cwd: string,
  files: string[],
  readFile: (p: string) => Promise<string>,
): Promise<CssVarsTokens | null> {
  const candidates = files.filter(
    (f) => (f.startsWith('src/') || f.includes('/src/')) && (f.endsWith('.css') || f.endsWith('.scss')),
  );
  return scanCssVars(cwd, candidates, readFile);
}

/**
 * Core SCSS-variable scan, shared by `detectScss` and `detectDesignTokens`'s root-level fallback.
 */
async function scanScss(
  baseDir: string,
  candidatePaths: string[],
  readFile: (p: string) => Promise<string>,
): Promise<ScssTokens | null> {
  const matchedFiles = new Set<string>();
  const varNames = new Set<string>();

  for (const f of candidatePaths) {
    let content = '';
    try {
      content = await readFile(join(baseDir, f));
    } catch {
      continue;
    }

    const decls = [...content.matchAll(/(\$[a-zA-Z0-9_-]+)\s*:/g)];
    if (decls.length > 0) {
      matchedFiles.add(f);
      for (const d of decls) {
        varNames.add(d[1]);
      }
    }
  }

  if (varNames.size === 0) return null;

  return {
    files: Array.from(matchedFiles).sort(),
    names: Array.from(varNames).sort().slice(0, 60),
  };
}

/**
 * Detects SCSS variables in src/** /_variables.scss, src/** /variables.scss, src/styles/** /*.scss.
 */
export async function detectScss(
  cwd: string,
  files: string[],
  readFile: (p: string) => Promise<string>,
): Promise<ScssTokens | null> {
  const scssFiles = files.filter((f) => {
    if (!f.endsWith('.scss')) return false;
    return (
      f.includes('_variables.scss') ||
      f.includes('variables.scss') ||
      (f.startsWith('src/styles/') || f.includes('/src/styles/'))
    );
  });

  if (scssFiles.length === 0) return null;

  return scanScss(cwd, scssFiles, readFile);
}

/**
 * Parses only the top-level keys of an object literal block.
 */
function parseTopLevelKeys(blockText: string): string[] {
  const keys: string[] = [];
  let idx = 0;

  while (idx < blockText.length) {
    const match = blockText.slice(idx).match(/(?:^|[,{\s])([a-zA-Z0-9_-]+|'[^']+'|"[^"]+")\s*:/);
    if (!match || match.index === undefined) break;

    const keyRaw = match[1];
    const key = keyRaw.replace(/^['"]|['"]$/g, '');
    keys.push(key);

    const afterColon = idx + match.index + match[0].length;
    let valStart = afterColon;
    while (valStart < blockText.length && /\s/.test(blockText[valStart])) valStart++;

    if (valStart < blockText.length && (blockText[valStart] === '{' || blockText[valStart] === '[')) {
      const sub = extractBalancedBlock(blockText, valStart);
      if (sub) {
        idx = sub.endIndex + 1;
        continue;
      }
    }

    idx = valStart + 1;
  }

  return keys;
}

/**
 * Detects CSS-in-JS theme exporting colors / palette.
 */
export async function detectTheme(
  cwd: string,
  files: string[],
  readFile: (p: string) => Promise<string>,
): Promise<ThemeTokens | null> {
  const themeFiles = files.filter((f) => {
    const base = f.split('/').pop();
    return base === 'theme.ts' || base === 'theme.js';
  });

  if (themeFiles.length === 0) return null;

  const matchedFiles = new Set<string>();
  const colorsSet = new Set<string>();

  for (const f of themeFiles) {
    let content = '';
    try {
      content = await readFile(join(cwd, f));
    } catch {
      continue;
    }

    const matches = [...content.matchAll(/\b(?:colors|palette)\s*:\s*\{/g)];
    for (const m of matches) {
      if (m.index !== undefined) {
        const balanced = extractBalancedBlock(content, m.index + m[0].length - 1);
        if (balanced) {
          const keys = parseTopLevelKeys(balanced.block);
          for (const k of keys) colorsSet.add(k);
          matchedFiles.add(f);
        }
      }
    }
  }

  if (colorsSet.size === 0) return null;

  return {
    files: Array.from(matchedFiles).sort(),
    colors: Array.from(colorsSet).sort(),
  };
}

/**
 * Detects Angular Material theme/palette declarations.
 */
export async function detectAngularMaterial(
  cwd: string,
  files: string[],
  readFile: (p: string) => Promise<string>,
): Promise<AngularMaterialTokens | null> {
  const scssFiles = files.filter((f) => f.endsWith('.scss') || f.endsWith('.sass'));
  const palettes = new Set<string>();

  for (const f of scssFiles) {
    let content = '';
    try {
      content = await readFile(join(cwd, f));
    } catch {
      continue;
    }

    if (!content.includes('@angular/material')) continue;

    const definePalettes = [...content.matchAll(/define-palette\(\s*([^,)\s]+)/g)];
    for (const dp of definePalettes) {
      const pal = dp[1].replace(/^[$mat.]+/g, '').replace(/['"]/g, '');
      if (pal) palettes.add(pal);
    }
  }

  if (palettes.size === 0) return null;

  return {
    palettes: Array.from(palettes).sort(),
  };
}

/**
 * Detects component libraries from package.json (walking from `root` down to `cwd`, so a
 * monorepo app with no `package.json` of its own still sees what's declared at the workspace
 * root) and from `components.json` (shadcn, checked only in the app dir itself).
 */
export async function detectLibraries(
  cwd: string,
  files: string[],
  readFile: (p: string) => Promise<string>,
  root: string = cwd,
): Promise<LibraryInfo[]> {
  const libs: LibraryInfo[] = [];

  const deps = await collectDependencyChain(cwd, root, readFile);

  const tracked = [
    '@mui/material',
    '@chakra-ui/react',
    'antd',
    '@angular/material',
    'bootstrap',
    'vuetify',
    'element-plus',
    'primeng',
    'primevue',
  ];
  // In single-project mode (root === cwd, the default) this stays the original, narrower list:
  // `tokens.tailwind` already reports Tailwind for that case, and doubling it into `libraries` for
  // every existing install would just be noise. In a monorepo, though, the app dir commonly has NO
  // package.json at all — detectTailwind's own signal (a config file) may be the only thing that
  // shows this app uses Tailwind, so it's worth surfacing here too, alongside the component
  // libraries above.
  if (resolve(root) !== resolve(cwd)) {
    tracked.push('tailwindcss');
  }

  for (const [depName, depVer] of Object.entries(deps)) {
    if (tracked.includes(depName) || depName.startsWith('@radix-ui/')) {
      libs.push({
        name: depName,
        version: typeof depVer === 'string' ? depVer : null,
      });
    }
  }

  // shadcn via components.json — scoped to the app dir only, since its rules (aliases, paths) are
  // per-app even when the dependency declaring them lives at the root.
  if (files.includes('components.json')) {
    libs.push({
      name: 'shadcn',
      version: null,
    });
  }

  return libs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Generates guidance based on detected token sources.
 */
export function renderGuidance(tokens: DesignTokens): string {
  const phrases: string[] = [];

  if (tokens.tailwind) {
    phrases.push('Tailwind classes (text-primary, rounded-md)');
  }
  if (tokens.cssVars) {
    phrases.push('CSS vars (var(--primary))');
  }
  if (tokens.scss) {
    phrases.push('SCSS variables ($primary)');
  }
  if (tokens.theme) {
    phrases.push('theme tokens (theme.colors)');
  }
  if (tokens.angularMaterial) {
    phrases.push('Angular Material palettes');
  }

  if (phrases.length === 0) {
    return "No design tokens detected; match the nearest sibling element's existing classes/styles.";
  }

  let joined = '';
  if (phrases.length === 1) {
    joined = phrases[0];
  } else if (phrases.length === 2) {
    joined = `${phrases[0]} or ${phrases[1]}`;
  } else {
    joined = `${phrases.slice(0, -1).join(', ')}, or ${phrases[phrases.length - 1]}`;
  }

  return `Prefer existing tokens: ${joined}. Do not introduce raw hex colors or px radii when a token exists.`;
}

/**
 * Builds the canonical design block from detected tokens and libraries.
 */
export function buildDesignBlock(
  libraries: LibraryInfo[],
  tokens: DesignTokens,
): DesignBlock {
  return {
    version: 1,
    libraries,
    tokens,
    guidance: renderGuidance(tokens),
  };
}

/**
 * Main detection entry point.
 */
export async function detectDesignTokens(
  cwd: string,
  options?: ScanOptions,
): Promise<DesignBlock> {
  const readFile = options?.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  const root = options?.root ?? cwd;
  const files = await collectFiles(cwd, options);

  const libraries = await detectLibraries(cwd, files, readFile, root);
  const tailwind = await detectTailwind(cwd, files, readFile, root);
  let cssVars = await detectCssVars(cwd, files, readFile);
  let scss = await detectScss(cwd, files, readFile);
  const theme = await detectTheme(cwd, files, readFile);
  const angularMaterial = await detectAngularMaterial(cwd, files, readFile);

  // Neither found anything in the app dir itself — fall back to shared style locations at the
  // repo root (styles/, src/styles/, libs/**/styles/) before giving up. Only in a monorepo (root
  // differs from cwd): single-project mode already scanned everything there is to scan above.
  if ((!cssVars || !scss) && resolve(root) !== resolve(cwd)) {
    const rootFiles = await collectFiles(root, options);
    const sharedStyleFiles = rootFiles.filter(isRootSharedStylePath);
    if (!cssVars) {
      const cssCandidates = sharedStyleFiles.filter((f) => f.endsWith('.css') || f.endsWith('.scss'));
      cssVars = await scanCssVars(root, cssCandidates, readFile);
    }
    if (!scss) {
      const scssCandidates = sharedStyleFiles.filter((f) => f.endsWith('.scss'));
      scss = await scanScss(root, scssCandidates, readFile);
    }
  }

  const tokens: DesignTokens = {};
  if (tailwind) tokens.tailwind = tailwind;
  if (cssVars) tokens.cssVars = cssVars;
  if (scss) tokens.scss = scss;
  if (theme) tokens.theme = theme;
  if (angularMaterial) tokens.angularMaterial = angularMaterial;

  return buildDesignBlock(libraries, tokens);
}

/**
 * Human-readable token summary for init command output.
 */
export function summarizeDesignTokens(tokens: DesignTokens, libraries: LibraryInfo[]): string {
  const parts: string[] = [];

  if (tokens.tailwind) {
    const count = tokens.tailwind.colors?.length ?? 0;
    parts.push(`tailwind (${count} color${count === 1 ? '' : 's'})`);
  }
  if (tokens.cssVars) {
    const count = tokens.cssVars.names?.length ?? 0;
    parts.push(`css vars (${count})`);
  }
  if (tokens.scss) {
    const count = tokens.scss.names?.length ?? 0;
    parts.push(`scss (${count})`);
  }
  if (tokens.theme) {
    const count = tokens.theme.colors?.length ?? 0;
    parts.push(`theme (${count})`);
  }
  if (tokens.angularMaterial) {
    const count = tokens.angularMaterial.palettes?.length ?? 0;
    parts.push(`angular material (${count})`);
  }
  if (libraries.length > 0 && parts.length === 0) {
    parts.push(`${libraries.length} librar${libraries.length === 1 ? 'y' : 'ies'}`);
  }

  if (parts.length === 0) {
    return 'none';
  }

  return parts.join(', ');
}
