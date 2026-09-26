import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { injectStatic } from './static.js';

export async function injectVite(
    cwd: string,
    cfg: {
        server: string;
        key: string;
        environment: string;
        /** Forwarded to the injector — see injectStatic's `pin`. */
        pin?: { version: string; integrity: string } | null;
        /**
         * `--environment` was given, so the install is deliberately pinned to one environment and
         * VITE_PINSAY_ENV is written for the snippet's `environment` attribute. Otherwise the
         * environment is resolved by the server from the page origin, nothing in the app carries
         * it, and any VITE_PINSAY_ENV left by an older init is removed.
         */
        environmentPinned?: boolean;
    },
    htmlPath?: string,
): Promise<string[]> {
    const modified = [];

    // Inject HTML
    const p = await injectStatic(cwd, htmlPath, { ...cfg, envGuarded: true });
    modified.push('index.html');

    // Upsert the development-scoped env file — never the shared `.env` (pinsay-init.md Scope rule
    // 2: a plain `.env` is loaded for every configuration including production, so putting the
    // widget's keys there enables it in production builds without ever touching a file with "prod"
    // in its name). Re-running on an install that already has one of these continues upserting it;
    // a brand-new install gets `.env.development`. Same pattern as injectSourceMap (source-map.ts).
    const envName = (await firstExisting(cwd, ['.env.development', '.env.local'])) ?? '.env.development';
    const envPath = join(cwd, envName);
    let envContent = await fs.readFile(envPath, 'utf8').catch(() => '');
    
    // No VITE_PINSAY_ENABLED: the snippet mounts when VITE_PINSAY_SERVER is a URL and not
    // otherwise, so leaving it empty in a build is the off switch. Same for the environment (see
    // `environmentPinned`). Stale lines from older inits are removed below.
    const envVars: Record<string, string> = {
        VITE_PINSAY_SERVER: cfg.server,
        VITE_PINSAY_PROJECT: cfg.key,
    };
    if (cfg.environmentPinned) envVars.VITE_PINSAY_ENV = cfg.environment;
    
    for (const [k, v] of Object.entries(envVars)) {
        const re = new RegExp(`^${k}=.*$`, 'm');
        if (re.test(envContent)) {
            envContent = envContent.replace(re, `${k}=${v}`);
        } else {
            envContent += `${envContent.endsWith('\n') || envContent === '' ? '' : '\n'}${k}=${v}\n`;
        }
    }
    envContent = dropStaleLines(envContent, cfg.environmentPinned);
    await fs.writeFile(envPath, envContent, 'utf8');
    modified.push(envName);

    // An install from before this was fixed may have these same keys sitting in the shared `.env`
    // (loaded in every configuration, production included). Writing the new file is not enough to
    // fix that install — the stale keys there would keep shipping to production — so strip them
    // out of `.env` too, if present.
    const legacyCleaned = await cleanLegacyPointerKeys(cwd);
    if (legacyCleaned) modified.push(legacyCleaned);

    // Upsert .env.example if exists
    for (const example of ['.env.example', '.env.sample']) {
        const exPath = join(cwd, example);
        let exContent = await fs.readFile(exPath, 'utf8').catch(() => null);
        if (exContent !== null) {
            const exVars: Record<string, string> = {};
            for (const k of Object.keys(envVars)) exVars[k] = '';
            for (const [k, v] of Object.entries(exVars)) {
                const re = new RegExp(`^${k}=.*$`, 'm');
                if (re.test(exContent)) {
                    exContent = exContent.replace(re, `${k}=${v}`);
                } else {
                    exContent += `${exContent.endsWith('\n') || exContent === '' ? '' : '\n'}${k}=${v}\n`;
                }
            }
            exContent = dropStaleLines(exContent, cfg.environmentPinned);
            await fs.writeFile(exPath, exContent, 'utf8');
            modified.push(example);
        }
    }
    
    return modified;
}

/**
 * Removes lines an older init wrote that nothing reads any more: `VITE_PINSAY_ENABLED` (the
 * snippet keys off VITE_PINSAY_SERVER now) and, unless the install is pinned, `VITE_PINSAY_ENV`.
 */
function dropStaleLines(content: string, environmentPinned?: boolean): string {
    let out = content.replace(/^VITE_PINSAY_ENABLED=.*\n?/m, '');
    if (!environmentPinned) out = out.replace(/^VITE_PINSAY_ENV=.*\n?/m, '');
    return out;
}

/** Same helper as source-map.ts's — first of these filenames that already exists in `cwd`. */
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

/** Every key an init before this fix could have written into the shared `.env`. */
const LEGACY_SHARED_ENV_KEYS = [
    'VITE_PINSAY_SERVER',
    'VITE_PINSAY_PROJECT',
    'VITE_PINSAY_ENABLED',
    'VITE_PINSAY_ENV',
];

/**
 * Removes the widget's keys from the shared `.env`, if any are there — the exact file this used to
 * write to, before this was fixed. `.env` is loaded for every Vite mode including production, so an
 * install that predates the fix keeps shipping the widget to production until these lines are gone,
 * regardless of where the current keys now live. A no-op (and no `.env` touch at all) when `.env`
 * either does not exist or already has none of these keys.
 */
async function cleanLegacyPointerKeys(cwd: string): Promise<string | null> {
    const legacyPath = join(cwd, '.env');
    const before = await fs.readFile(legacyPath, 'utf8').catch(() => null);
    if (before === null) return null;

    let after = before;
    for (const k of LEGACY_SHARED_ENV_KEYS) {
        after = after.replace(new RegExp(`^${k}=.*\\n?`, 'm'), '');
    }
    if (after === before) return null;

    await fs.writeFile(legacyPath, after, 'utf8');
    return '.env';
}
