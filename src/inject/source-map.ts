import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** Config filenames Vite honours, in the order Vite itself resolves them. */
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'];

export type SourceMapResult =
    | { ok: true; files: string[]; alreadyPresent: boolean }
    | { ok: false; reason: string };

/**
 * Wires the source-stamping Vite plugin into a project.
 *
 * The plugin has shipped since R3-01, but nothing turned it on: a developer had to find it, import
 * it, add it to `plugins`, and invent an env flag — which the served init skill did not even
 * mention, because it still described building your own Babel plugin. This is the one command that
 * closes that gap.
 *
 * Deliberately conservative. Editing someone's build config is the most intrusive thing this CLI
 * does, so anything it cannot do by unambiguous textual insertion it refuses and explains, rather
 * than reformatting a config it only partly understood.
 */
export async function injectSourceMap(cwd: string): Promise<SourceMapResult> {
    const configName = await firstExisting(cwd, VITE_CONFIGS);
    if (!configName) {
        return {
            ok: false,
            reason:
                `no vite.config.* found in ${cwd}. The source-map plugin is Vite-only — ` +
                `Angular, Next and server-rendered stacks have no equivalent yet.`,
        };
    }

    const configPath = join(cwd, configName);
    const original = await fs.readFile(configPath, 'utf8');
    const files: string[] = [];

    // Already wired: say so and change nothing. Re-running init must not append a second plugin.
    const alreadyPresent = original.includes('pinsay/vite');
    let next = original;

    if (!alreadyPresent) {
        const pluginsMatch = next.match(/plugins\s*:\s*\[/);
        if (!pluginsMatch || pluginsMatch.index === undefined) {
            return {
                ok: false,
                reason:
                    `could not find a \`plugins: [\` array in ${configName}. Add it by hand:\n` +
                    `  import pinsaySource from 'pinsay/vite';\n` +
                    `  plugins: [pinsaySource({ enabled: process.env.VITE_PINSAY_SOURCE === 'true' })]`,
            };
        }

        // Inserted as the FIRST plugin so it sees JSX before a framework plugin compiles it away.
        //
        // Matched to the array's existing shape: a single-line `plugins: [react()]` stays on one
        // line, a multi-line array gets its own indented line. Editing someone's config is
        // intrusive enough without also reformatting it.
        const at = pluginsMatch.index + pluginsMatch[0].length;
        const call = `pinsaySource({ enabled: process.env.VITE_PINSAY_SOURCE === 'true' })`;
        const rest = next.slice(at);
        const multiline = /^\s*\n/.test(rest);
        const indent = multiline ? (rest.match(/^\s*\n(\s*)/)?.[1] ?? '    ') : '';
        next = multiline
            ? next.slice(0, at) + `\n${indent}${call},` + rest.replace(/^\s*\n/, '\n')
            : next.slice(0, at) + `${call}, ` + rest;

        // Import goes above the first existing import, or at the very top when there are none.
        const firstImport = next.search(/^import\s/m);
        const importLine = `import pinsaySource from 'pinsay/vite';\n`;
        next = firstImport === -1 ? importLine + next : next.slice(0, firstImport) + importLine + next.slice(firstImport);

        await fs.writeFile(configPath, next, 'utf8');
        files.push(configName);
    }

    // The flag lives in the DEVELOPMENT env file, never the shared `.env`: a plain `.env` is loaded
    // for every configuration including production, and stamping component paths into a production
    // build is exactly what the hash design exists to avoid.
    const envName = (await firstExisting(cwd, ['.env.development', '.env.local'])) ?? '.env.development';
    const envPath = join(cwd, envName);
    const envBefore = await fs.readFile(envPath, 'utf8').catch(() => '');
    if (!/^VITE_PINSAY_SOURCE=/m.test(envBefore)) {
        const sep = envBefore && !envBefore.endsWith('\n') ? '\n' : '';
        await fs.writeFile(
            envPath,
            `${envBefore}${sep}# Stamps component source hashes for PinSay. Development only.\nVITE_PINSAY_SOURCE=true\n`,
            'utf8',
        );
        files.push(envName);
    }

    return { ok: true, files, alreadyPresent };
}

async function firstExisting(cwd: string, names: string[]): Promise<string | null> {
    for (const name of names) {
        try {
            await fs.access(join(cwd, name));
            return name;
        } catch {
            /* keep looking */
        }
    }
    return null;
}
