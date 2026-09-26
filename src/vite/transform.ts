import { componentHash, type ManifestEntry } from './hash.js';

export interface StampResult {
  code: string;
  changed: boolean;
  components: Record<string, ManifestEntry>;
}

/**
 * Loads the Babel toolchain lazily.
 *
 * These are OPTIONAL PEERS, not dependencies. All three are transitive deps of @babel/core, which
 * every @vitejs/plugin-react project already has, so in practice nothing extra is installed — but
 * the CLI's own bundle must stay dependency-free, and a project that never uses the plugin must
 * never be asked to install a parser.
 */
async function loadBabel() {
  try {
    const [parser, traverseMod, generatorMod] = await Promise.all([
      import('@babel/parser'),
      // @ts-ignore optional peer — types are not installed for a dependency-free CLI bundle
      import('@babel/traverse'),
      // @ts-ignore optional peer — same
      import('@babel/generator'),
    ]);
    // CJS/ESM interop, and it bites twice.
    //
    // @babel/traverse and @babel/generator are CommonJS. Imported from an ESM bundle, the
    // namespace's `.default` is the whole `module.exports` OBJECT, whose own `.default` is the
    // callable. Taking `.default` alone yields that object — calling it throws "traverse is not a
    // function", which the caller catches and turns into a per-file warning. The build then
    // succeeds, every file fails to stamp, and the manifest is written EMPTY. Nothing looks
    // broken; the feature simply does nothing.
    //
    // Under tsx (the unit tests) the interop resolves differently and `.default` IS the function,
    // which is exactly why this survived a green test suite — see cli/test/vite-dist.test.ts,
    // which loads the BUILT bundle for this reason.
    const unwrap = (mod: any, name: string) => {
      const fn = mod?.default?.default ?? mod?.default ?? mod;
      if (typeof fn !== 'function') {
        throw new Error(
          `${name} did not resolve to a function (got ${typeof fn}) — CJS/ESM interop problem`,
        );
      }
      return fn;
    };

    return {
      parse: parser.parse,
      traverse: unwrap(traverseMod, '@babel/traverse'),
      generate: unwrap(generatorMod, '@babel/generator'),
    };
  } catch {
    throw new Error(
      'the Vite plugin needs @babel/parser, @babel/traverse and @babel/generator. ' +
        'They ship with @vitejs/plugin-react; install them if you use a different React setup.',
    );
  }
}

/** A lowercase tag is a host element (div, button); an uppercase one is another component. */
function isHostElement(node: any): boolean {
  const name = node?.openingElement?.name;
  return name?.type === 'JSXIdentifier' && /^[a-z]/.test(name.name);
}

function alreadyStamped(node: any, attribute: string): boolean {
  return (node.openingElement.attributes ?? []).some(
    (a: any) => a.type === 'JSXAttribute' && a.name?.name === attribute,
  );
}

/**
 * Collects the host elements that are a component's ROOTS.
 *
 * A fragment contributes all of its top-level host children; a conditional contributes both
 * branches; a bare component (`<Card/>`) contributes nothing — that component stamps its own root
 * and the widget's ancestor walk finds it. This is what keeps a stamp attached to the component
 * that actually owns the markup rather than to whatever happened to be outermost.
 */
function collectRoots(node: any, out: any[]): void {
  if (!node) return;
  switch (node.type) {
    case 'JSXElement':
      if (isHostElement(node)) out.push(node);
      return;
    case 'JSXFragment':
      for (const child of node.children ?? []) collectRoots(child, out);
      return;
    case 'ConditionalExpression':
      collectRoots(node.consequent, out);
      collectRoots(node.alternate, out);
      return;
    case 'LogicalExpression':
      collectRoots(node.right, out);
      return;
    case 'ParenthesizedExpression':
      collectRoots(node.expression, out);
      return;
    default:
      return;
  }
}

/** `function Foo`, `const Foo = …`, `export default function Foo`, `memo(Foo)` → "Foo". */
function componentNameFor(path: any): string | null {
  const node = path.node;
  if (node.id?.name) return node.id.name;

  const parent = path.parent;
  if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') return parent.id.name;
  if (parent?.type === 'CallExpression') {
    // An HOC wrapper: memo(PlanSelect) / forwardRef(PlanSelect). The INNER function is the
    // component, so keep walking out to find the name it was assigned to.
    const grand = path.parentPath?.parent;
    if (grand?.type === 'VariableDeclarator' && grand.id?.type === 'Identifier') return grand.id.name;
  }
  if (parent?.type === 'ExportDefaultDeclaration') return 'default';
  return null;
}

/**
 * Stamps each component's root host elements with `attribute="<hash>"`.
 *
 * The transform is inert by construction: it adds ONE static attribute to markup that is already
 * there. It never wraps, reorders, renames or evaluates anything, so it cannot change what the
 * application does — which is the only acceptable bar for something a customer runs in production.
 */
export async function stampSource(code: string, repoRelativePath: string, attribute: string): Promise<StampResult> {
  if (repoRelativePath.endsWith('.vue')) {
    return stampVue(code, repoRelativePath, attribute);
  }

  const { parse, traverse, generate } = await loadBabel();
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript', 'decorators-legacy', 'classProperties'],
  });

  const components: Record<string, ManifestEntry> = {};
  let changed = false;

  const visitComponent = (path: any) => {
    const name = componentNameFor(path);
    // A component's name is capitalised; a lowercase function is a helper, not a component.
    if (!name || !/^[A-Z]|^default$/.test(name)) return;

    const roots: any[] = [];
    const body = path.node.body;
    if (body?.type === 'BlockStatement') {
      for (const stmt of body.body) {
        if (stmt.type === 'ReturnStatement') collectRoots(stmt.argument, roots);
      }
    } else {
      collectRoots(body, roots); // concise arrow body
    }
    if (roots.length === 0) return;

    const hash = componentHash(repoRelativePath, name);
    components[hash] = { path: repoRelativePath, export: name };

    for (const el of roots) {
      if (alreadyStamped(el, attribute)) continue;
      el.openingElement.attributes.push({
        type: 'JSXAttribute',
        name: { type: 'JSXIdentifier', name: attribute },
        value: { type: 'StringLiteral', value: hash },
      });
      changed = true;
    }
  };

  traverse(ast, {
    FunctionDeclaration: visitComponent,
    FunctionExpression: visitComponent,
    ArrowFunctionExpression: visitComponent,
  });

  if (!changed) return { code, changed: false, components };
  return { code: generate(ast, { retainLines: true }, code).code, changed: true, components };
}

/**
 * Vue SFC: stamp each top-level element of <template>. Multi-root templates are supported, and the
 * component's name is the file's basename — a `.vue` file IS one component.
 */
function stampVue(code: string, repoRelativePath: string, attribute: string): StampResult {
  const name = repoRelativePath.split('/').pop()!.replace(/\.vue$/, '');
  const hash = componentHash(repoRelativePath, name);
  const components: Record<string, ManifestEntry> = { [hash]: { path: repoRelativePath, export: name } };

  const match = code.match(/<template>([\s\S]*?)<\/template>/);
  if (!match) return { code, changed: false, components };

  let changed = false;
  const stamped = match[1].replace(/<([a-z][\w-]*)((?:\s[^>]*?)?)(\/?)>/g, (whole, tag, attrs, selfClose) => {
    if (attrs.includes(attribute)) return whole;
    changed = true;
    return `<${tag}${attrs} ${attribute}="${hash}"${selfClose}>`;
  });

  if (!changed) return { code, changed: false, components };
  return { code: code.replace(match[1], stamped), changed: true, components };
}
