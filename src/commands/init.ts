import { ask, select, multiSelect, closePrompts } from '../prompt.js';
import { BUILD_CLI_VERSION } from '../build-constants.js';
import {
    readConfig,
    writeConfig,
    writeConfigFull,
    writeCredentials,
    isMultiProject,
    listProjects,
    removeLegacyRepoFiles,
    type ProjectEntry,
    type PinSayConfig,
} from '../config.js';
import { detectStack, detectAppUrl, extractTokens } from '../detect.js';
import { discoverNxApps, isNxWorkspace, type DiscoveredApp } from '../monorepo.js';
import { injectVite, injectStatic } from '../inject/index.js';
import { injectSourceMap } from '../inject/source-map.js';
import { installSkills, formatSkillWarnings, type SkillWarning } from '../skills.js';
import { hidePinsayFiles, formatHideWarnings, skillsDirExtra } from '../lib/git-exclude.js';
import { getBranding } from '../branding.js';
import { api, ApiError } from '../api.js';
import { postEvent } from '../events.js';
import { runInitChecks, compareSemver, tooOldMessage } from '../checks.js';
import { promises as fs, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute, sep } from 'node:path';
import { detectDesignTokens, summarizeDesignTokens, type DesignBlock } from '../stack/design.js';
import { buildRequestBody, mergeStack, writeStackFile, stackFileRelPath } from '../stack/stackfile.js';
import { resolveApiKey, saveGlobalCredential, type ApiKeySource } from '../credentials.js';
import { runDeviceLogin } from '../device-login.js';
import { askKeyScope } from '../key-scope.js';
import { resolveServer } from '../server.js';

export async function initCommand(cwd: string, options: Record<string, string | boolean> = {}) {
    const isYes = options['yes'] || options['json'];
    const isJson = options['json'];

    // Every mode (install, join, --path, multi-join) starts from here, so this is the one place
    // that reaches every one of them: a repo installed by an older CLI may still have files that
    // version wrote and this one no longer does — see `removeLegacyRepoFiles`.
    const removedLegacyFiles = await removeLegacyRepoFiles(cwd);
    if (!isJson) {
        for (const f of removedLegacyFiles) console.log(`\x1b[2mremoved legacy ${f}\x1b[0m`);
    }

    const deliveryFlag = options['delivery'] as string | undefined;
    if (deliveryFlag !== undefined && deliveryFlag !== 'embed' && deliveryFlag !== 'extension') {
        console.error(`Invalid --delivery "${deliveryFlag}". Valid values: embed, extension.`);
        process.exit(2);
    }

    const config: any = await readConfig(cwd).catch(() => ({}));

    // `--path apps/x`: this run adds (or updates) ONE app inside a multi-project (monorepo) config
    // instead of setting up "the" project at the repo root. See the `projects` map in config.ts.
    const pathFlag = typeof options['path'] === 'string'
        ? String(options['path']).replace(/^\.\/+/, '').replace(/\/+$/, '')
        : undefined;
    const isAddProject = Boolean(pathFlag);
    const configIsMulti = isMultiProject(config);

    // A "join": .pinsay/config.json already names a project (or, in a multi-project
    // repo, at least one app under `projects`). Whoever ran `init` the first time already made
    // every decision this command would otherwise ask about — project(s), environments,
    // delivery — and committed it. A second developer cloning the repo (or the same developer on a
    // second machine) only needs their own API key: everything else here is read back from the
    // committed config instead of asked again, and nothing is injected, since the embed snippet
    // (or the extension) is already in the app's committed source. Never true for `--path`: adding
    // a new app to an already-configured repo is "add a project", not "join the existing one".
    const isJoin = !isAddProject && (Boolean(config.project) || configIsMulti);
    const mode: 'join' | 'install' = isJoin ? 'join' : 'install';

    const server = resolveServer();

    // Resolve a key from the same three sources every other command uses — env var, this repo's
    // `.pinsay/credentials.env`, or the global per-machine store `login` writes to — BEFORE the
    // `--yes` gate below. A join (or any run) that already has a working key on this machine must
    // never be told `--key` is "required": that is the whole point of `login`/the global store.
    // `--key` still wins outright when passed.
    // `--scope global|repo` decides where a freshly validated key is stored; `--local-credentials`
    // is the older alias for `--scope repo`. Anything else is a usage error.
    const scopeFlag = typeof options['scope'] === 'string' ? String(options['scope']).toLowerCase() : undefined;
    if (scopeFlag !== undefined && scopeFlag !== 'global' && scopeFlag !== 'repo') {
        console.error(`Invalid --scope "${options['scope']}". Valid values: global, repo.`);
        process.exit(2);
    }
    const localCredentialsFlag = Boolean(options['local-credentials']) || scopeFlag === 'repo';
    let key = options['key'] as string;
    let keySource: ApiKeySource = null;
    if (!key) {
        const resolved = await resolveApiKey(cwd, server as string);
        if (resolved.key) {
            key = resolved.key;
            keySource = resolved.source;
        }
    }

    if (isYes) {
        if (!key) {
            console.error("Missing flag: --key is required with --yes");
            process.exit(2);
        }
        // A join already knows the project; --project/--create would be redundant, and requiring
        // them here would make `--yes` unusable for the one case it exists to make trivial: cloning
        // a repo that already has PinSay set up.
        if (!isJoin && !options['project'] && !options['create']) {
            console.error("Missing flag: --project or --create is required with --yes");
            process.exit(2);
        }
    }

    // Refuse to run against a server that requires a newer CLI — same gate `apply`, `mcp` and
    // `doctor` already apply, and exit 5 as cli.ts documents.
    //
    // init needs it MOST, not least: it is the first command anyone runs, and it is the one that
    // writes files. An init that proceeds against a contract the server no longer accepts leaves
    // a config, an injected snippet and a stack file on disk that all look fine, and the mismatch
    // surfaces much later at apply time, a long way from its cause.
    try {
      const meta = await api<any>(server as string, '/api/meta');
      const minCli = meta?.minCliVersion || '0.0.0';
      if (compareSemver(BUILD_CLI_VERSION, minCli) < 0) {
        console.error(tooOldMessage(BUILD_CLI_VERSION, minCli));
        process.exit(5);
      }
    } catch (err: any) {
      // A server too old to have /api/meta cannot be declaring a minimum, so there is nothing to
      // enforce. Any other transient failure is reported by the calls that follow — this check
      // must not be the thing that stops an install over a blip.
      if (!(err instanceof ApiError && err.code === 404)) {
        // best-effort
      }
    }

    const branding = await getBranding(server as string);
    // No `|| 'PinSay'`: getBranding already guarantees a name or exits. A literal fallback here
    // would print the wrong brand to anyone who rebranded, silently.
    const product = branding.productName;

    let me: any = null;
    let token: string | undefined;

    // A key that already resolved above (env var, repo credentials.env, or the global store) is
    // validated silently — no prompt. This is what makes a join (or any re-run) on a machine that
    // already ran `login` ask for nothing at all.
    if (keySource) {
        try {
            const login = await api<any>(server as string, '/api/auth/login-with-key', {
                method: 'POST',
                body: { apiKey: key },
            });
            if (login?.status !== 'ok' || !login?.token) throw new Error(login?.status || 'invalid');
            token = login.token;
            me = login.user ?? (await api(server as string, '/api/auth/me', { token }));
            if (!isJson) {
                console.log(`Using your saved key for ${server} (${me.displayName})`);
            }
        } catch {
            // Stale/revoked: forget it and fall through exactly as if nothing had resolved — a
            // rejected saved key is recoverable (re-enter it), not fatal.
            key = '';
            keySource = null;
        }
    }

    // Whether THIS run had to authenticate a key it did not already trust from somewhere
    // `resolveApiKey` would find again on its own (typed interactively, passed via --key, or a
    // pre-resolved one that was just rejected above). Only such a key is a candidate for the
    // save-to-global-store offer below — one that already came from the global store (or env, or
    // the repo file) needs nothing written.
    const freshlyAuthenticated = !me;

    if (!me) {
        if (isYes) {
            try {
                // An API key is not a JWT: it must be exchanged for one. Sending it as a Bearer token
                // to /api/auth/me fails for every valid key — which unit tests against a permissive
                // stub did not catch, but a real server does immediately.
                const login = await api<any>(server as string, '/api/auth/login-with-key', {
                    method: 'POST',
                    body: { apiKey: key },
                });
                if (login?.status !== 'ok' || !login?.token) throw new Error(login?.status || 'invalid');
                token = login.token;
                me = login.user ?? (await api(server as string, '/api/auth/me', { token }));
            } catch (err: any) {
                if (isJson) {
                    console.log(JSON.stringify({ ok: false, error: { code: 3, message: "Invalid API key" } }));
                } else {
                    console.error("Invalid API key.");
                }
                process.exit(3);
            }
        } else {
            let attempts = 0;
            // First-time interactive with nothing resolved yet (no --key, no env/repo/global hit):
            // ask how to sign in before falling into the paste-a-key loop below. A retry after a
            // rejected --key (key is already set here) skips straight to that loop — the user
            // already told us they want to type one.
            if (!key) {
                const choice = await select('How do you want to sign in?', [
                    'Sign in in your browser (recommended)',
                    'Paste an API key',
                ]);
                if (choice.startsWith('Sign in in your browser')) {
                    const outcome = await runDeviceLogin(server as string, { noBrowser: options['no-browser'] === true });
                    if (!outcome.ok) {
                        if (outcome.reason === 'denied') {
                            console.error('Sign-in was denied.');
                        } else {
                            console.error('The sign-in code expired. Run `npx pinsay-cli init` again.');
                        }
                        process.exit(3);
                    }
                    key = outcome.result.apiKey;
                    // The rest of init needs a JWT (`token`) and the full `me` profile (roleName,
                    // etc.), not just the key the device flow handed back — same exchange as the
                    // paste path just below.
                    try {
                        const login = await api<any>(server as string, '/api/auth/login-with-key', {
                            method: 'POST',
                            body: { apiKey: key },
                        });
                        if (login?.status !== 'ok' || !login?.token) throw new Error(login?.status || 'invalid');
                        token = login.token;
                        me = login.user ?? (await api(server as string, '/api/auth/me', { token }));
                    } catch {
                        console.error('Invalid API key.');
                        process.exit(3);
                    }
                }
            }
            while (!me) {
                if (!key) {
                    key = await ask(`API key (from ${product} -> profile -> API key; input hidden)`, { secret: true });
                }
                try {
                    // Same exchange as the --yes branch: key -> token -> profile.
                    const login = await api<any>(server as string, '/api/auth/login-with-key', {
                        method: 'POST',
                        body: { apiKey: key },
                    });
                    if (login?.status !== 'ok' || !login?.token) throw new Error(login?.status || 'invalid');
                    token = login.token;
                    me = login.user ?? (await api(server as string, '/api/auth/me', { token }));
                } catch (err: any) {
                    attempts++;
                    if (attempts >= 3) {
                        console.error("Invalid API key.");
                        process.exit(3);
                    }
                    console.error("Invalid API key.");
                    key = '';
                }
            }
            console.log(`✔ Signed in as ${me.displayName} (${me.roleName || 'User'})`);
        }
    }

    // Credential persistence.
    //
    // `keyLivesGlobally`: true once the key is (or already was) sitting in the global per-machine
    // store — whether that is because it resolved from there a moment ago, or because THIS run
    // just saved it there. Drives the human-summary "Key" line further down.
    //
    // `writeLocalCreds`: whether to (re)write the repo-local `.pinsay/credentials.env`. A key
    // sourced from `env` or `global` needs nothing written locally at all — it is already
    // resolvable from wherever it came from, and duplicating it into the repo is exactly what the
    // global store exists to avoid. A `repo` source keeps writing (idempotent — it is already a
    // local file, and the later "rewrite with the final project key" step needs to run against it,
    // same as always). A fresh key (no source yet) defaults to the global store too, unless
    // `--local-credentials` was passed or — interactively — the user answered "no" below.
    let keyLivesGlobally = keySource === 'global';
    let writeLocalCreds = keySource !== 'global' && keySource !== 'env';

    if (freshlyAuthenticated) {
        let saveGlobally = !localCredentialsFlag;
        if (saveGlobally && !isYes && scopeFlag === undefined) {
            saveGlobally = (await askKeyScope()) === 'global';
        }
        if (saveGlobally) {
            await saveGlobalCredential(server as string, { apiKey: key, email: me?.email, displayName: me?.displayName });
            keyLivesGlobally = true;
            writeLocalCreds = false;
        }
    }

    if (writeLocalCreds) {
        // The project is added later only in single-project mode (a multi-project
        // repo's pinsay.sh takes -p, so a pinned PINSAY_PROJECT would be wrong for every other app).
        await writeCredentials(cwd, key);
    }
    await hidePinsayFiles(cwd, skillsDirExtra((options['skills-dir'] as string) || config.skillsDir));

    // Multi-project join: the repo already has one or more apps configured under `projects`, this
    // is another clone/machine, and there is nothing to inject or ask beyond the key already
    // handled above. Installs skills once at the root and refreshes only the per-app stack files
    // that are missing — see `handleMultiJoin`.
    if (isJoin && configIsMulti) {
        await handleMultiJoin(cwd, config, server as string, product, Boolean(isJson), options, token, me);
        return;
    }

    // Detected BEFORE the questions, not after them.
    //
    // This used to run after project, environment and tool had all been chosen, so a repo whose
    // stack cannot be auto-injected (an Nx monorepo, say) answered five questions and only then
    // learned that the widget would not be mounted. Knowing up front lets us say so while the
    // answers still have a visible purpose — the project and key are what the skill needs in order
    // to finish the job, and they are written to .pinsay/config.json either way.
    //
    // A join never injects (see below), so there is nothing to say here — it would only be noise
    // ahead of a single question (the API key).
    const appInfo = await detectStack(cwd);
    // `--html` names the file outright, so it counts as injectable whatever detection concluded.
    const canInject = !isJoin && (appInfo.kind === 'vite' || appInfo.kind === 'static' || !!options['html']);
    if (!isJson && !isYes && !isJoin) {
        console.log(`\nStack: ${appInfo.kind}${appInfo.evidence.length ? ` (${appInfo.evidence.join(', ')})` : ''}`);
        if (!canInject && !options['no-inject']) {
            console.log(
                `\x1b[33mHeads up:\x1b[0m automatic widget injection isn't supported for ${appInfo.kind} yet.\n` +
                `Everything else still applies — the questions below set up your project, key and skills,\n` +
                `and the pinsay-init skill uses them to mount the widget for you afterwards.\n`,
            );
        }
    }

    // Nx monorepo, interactive, not already handled above: offer to set up more than one app as its
    // own PinSay project, instead of asking the single-project questions below for the repo root
    // (which usually has no widget of its own in this layout at all).
    let nxApps: DiscoveredApp[] = [];
    if (!isJoin && !isAddProject && !isYes) {
        if (await isNxWorkspace(cwd).catch(() => false)) {
            nxApps = await discoverNxApps(cwd).catch(() => []);
        }
    }
    const isMultiInteractive = nxApps.length > 0;

    if (isAddProject || isMultiInteractive) {
        await handleMultiProjectSetup({
            cwd,
            config,
            options,
            server: server as string,
            token,
            key,
            isJson: Boolean(isJson),
            isYes: Boolean(isYes),
            product,
            pathFlag,
            nxApps,
            configIsMulti,
            writeLocalCreds,
        });
        return;
    }

    let project = options['project'] as string;
    let create = options['create'] as string;
    let finalProjectKey = '';
    let projectName = '';
    let created = false;

    if (isJoin) {
        // Nothing to ask, nothing to create, nothing to activate — the project this app belongs to
        // was decided (and PATCHed active) the first time `init` ran here.
        finalProjectKey = config.project;
        projectName = config.project;
    } else {
        finalProjectKey = project || '';
        projectName = create || finalProjectKey;

        if (!isYes && !project && !create) {
            const projects = await api<any[]>(server as string, '/api/admin/projects', { token }).catch(() => []);
            const createOpt = '＋ Create a new project…';
            const choices = projects.map(p => `${p.name}  (${p.key})`).concat(createOpt);

            let choice = createOpt;
            if (projects.length > 0) {
                choice = await select(projectQuestion(), choices);
            }

            if (choice === createOpt) {
                const name = await ask('Project name');
                let derivedKey = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
                finalProjectKey = await ask('Project key', { default: derivedKey, validate: (v) => /^[a-z0-9-]+$/.test(v) ? undefined : 'Must match ^[a-z0-9-]+$' });
                projectName = name;
                created = true;
            } else {
                const match = choice.match(/\((.*?)\)$/);
                if (match) finalProjectKey = match[1];
                // Carry the name across too. Without this, picking an EXISTING project left projectName
                // as the empty string it was initialised to, and the summary read:
                //   ✔ PinSay is set up for project "" (pinsay-dashboard)
                const picked = projects.find((p) => p.key === finalProjectKey);
                projectName = picked?.name || finalProjectKey;
            }
        } else if (isYes && project && !create) {
            const existing = await api<any[]>(server as string, '/api/admin/projects', { token }).catch(() => []);
            if (!existing.some((p) => p.key === project)) {
                created = true;
                projectName = project;
            }
        } else if (create) {
            created = true;
            let derivedKey = create.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            finalProjectKey = project || derivedKey;
            projectName = create;
        }

        if (created) {
            try {
                await api(server as string, '/api/admin/projects', { method: 'POST', body: { key: finalProjectKey, name: projectName }, token });
            } catch (err: any) {
                if (err instanceof ApiError && err.code === 409) {
                    // Exit 3, not 1: under --yes there is nobody to ask for a different key, so this
                    // is "cannot proceed with the identity you gave me" — the same class as 403 — and
                    // a caller scripting init branches on the code to tell it apart from a generic
                    // failure.
                    console.error("Key already exists, choose another.");
                    process.exit(3);
                } else if (err instanceof ApiError && err.code === 403) {
                    console.error("This account cannot create projects.");
                    process.exit(3);
                } else if (err instanceof ApiError && err.code === 400) {
                    console.error(err.message);
                    process.exit(1);
                } else {
                    // Previously fell through silently and carried on as though the project existed,
                    // writing a config that points at nothing.
                    console.error(`Could not create project: ${err?.message ?? err}`);
                    process.exit(1);
                }
            }
        }
    }

    // Environments and their per-environment activation live in the dashboard now, next to the
    // project's URLs — there is no "Which environment(s) does this app run in?" question any more,
    // in either this single-project flow or the per-app one in `setupOneProject`. The widget/
    // extension resolve the environment from the app's URL at runtime, and a signed-in reviewer can
    // switch it from the toolbar.
    //
    // `--environment <list>` survives as a deliberate, EXPLICIT opt-in for the one case that still
    // needs it: activating a project for specific environments without a trip to the dashboard.
    // Given, it PATCHes activation exactly as before. Omitted (the default), nothing about
    // environments is asked, activated, or written to `.pinsay/config.json` — see the
    // `environment`/`environments` fields' `@deprecated` docs in `config.ts` (still read, for
    // installs from before this change).
    const ALL_ENVS = ['local', 'staging', 'production'];
    let envs: string[];
    let environmentPinned: boolean;
    let env: string;

    if (isJoin) {
        // Read back for backward compatibility only — an install from before this change may still
        // have `environment`/`environments` recorded. A join asks nothing and activates nothing
        // either way.
        envs = Array.isArray(config.environments) && config.environments.length
            ? config.environments
            : [config.environment || 'local'];
        environmentPinned = Boolean(config.environment) || (Array.isArray(config.environments) && config.environments.length > 0);
        env = config.environment || envs[0] || 'local';
    } else {
        envs = String(options['environment'] ?? '')
            .split(',')
            .map((e) => e.trim())
            .filter(Boolean);

        const badEnv = envs.find((e) => !ALL_ENVS.includes(e));
        if (badEnv) {
            console.error(`Unknown environment "${badEnv}". Valid values: ${ALL_ENVS.join(', ')}.`);
            process.exit(2);
        }

        environmentPinned = envs.length > 0;
        if (envs.length === 0) envs = ['local'];

        // The primary environment: what a single-valued field means when several were named. First in
        // the canonical order rather than first-listed, so `local,staging` and `staging,local` agree.
        // Only feeds injection (the pinned `environment` attribute) and `--app-url` detection below —
        // it is never written to config.
        env = ALL_ENVS.filter((e) => envs.includes(e))[0] ?? 'local';

        if (environmentPinned) {
            // `--environment` was given: activate the project for every environment named — additive,
            // exactly as before. An environment already active stays active, and one not named is left
            // alone rather than switched off.
            const projectRow = await api<any[]>(server as string, '/api/admin/projects', { token })
                .then((rows) => rows.find((p) => p.key === finalProjectKey))
                .catch(() => null);
            if (projectRow?.id) {
                const activation: Record<string, boolean> = {};
                if (envs.includes('local') && !projectRow.isActiveLocal) activation['isActiveLocal'] = true;
                if (envs.includes('staging') && !projectRow.isActiveStaging) activation['isActiveStaging'] = true;
                if (envs.includes('production') && !projectRow.isActiveProduction) activation['isActiveProduction'] = true;
                if (Object.keys(activation).length) {
                    try {
                        await api(server as string, `/api/admin/projects/${projectRow.id}`, {
                            method: 'PATCH',
                            body: activation,
                            token,
                        });
                    } catch (err: any) {
                        // A developer without project-edit rights can still install the widget; the
                        // environment simply stays inactive until an admin enables it. Worth saying out
                        // loud, never worth aborting for.
                        if (!isJson) {
                            console.error(
                                `Note: could not activate ${Object.keys(activation).length} environment(s) for this project ` +
                                `(${err?.message ?? err}). An admin can switch them on in the dashboard.`,
                            );
                        }
                    }
                }
            }
        }
    }

    let appUrl = options['app-url'] as string | undefined;
    let noAppUrl = options['no-app-url'] as boolean;
    let source = '';

    // Detected, never asked. Skipped entirely on a join: the value only ever fed `--json` output
    // and the (skipped) injection step.
    //
    // This used to prompt "Where does this app run in <env>?" and then drop the answer: the only
    // code that consumed it was an empty `if (appUrl && env !== 'local') {}` block, and the value
    // reaches nothing but `--json` output. Asking someone for a URL that goes nowhere is worse than
    // not asking, so the question is gone while the flags and detection stay — `--app-url` still
    // overrides, `--no-app-url` still skips the scan.
    //
    // Registering it against the project's environment (PUT /api/admin/projects/{id}/app-urls/
    // {environmentId}, which the dashboard already uses) is the real feature this was a stub for.
    // Deliberately still not done — see the note in R1-02.
    if (!isJoin && !noAppUrl && !appUrl) {
        const detected = await detectAppUrl(cwd, appInfo.kind, env);
        source = detected.source;
        appUrl = detected.url || undefined;
    }

    // `--tool` (or config.aiTool on a join) wins outright; a config missing it — an old install,
    // written before this field existed — falls back to the same auto-detect / prompt a fresh
    // install uses.
    let tool = (options['tool'] as string) || config.aiTool;
    /** Every tool to install skills for; `tool` remains the primary one recorded in config. */
    let tools: string[] = tool ? [tool] : [];
    if (!tool) {
        // auto-detect
        if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) tool = 'claude-code';
        else if (process.env.ANTIGRAVITY_AGENT || process.env.GEMINI_CLI) tool = 'antigravity';
        else if (process.env.TERM_PROGRAM && process.env.TERM_PROGRAM.includes('Cursor')) tool = 'cursor';
        else if (process.env.WINDSURF) tool = 'windsurf';
        else if (process.env.OPENCODE) tool = 'opencode';
        else tool = isYes ? 'other' : 'claude-code';

        if (!isYes && !options['tool']) {
            // Multi-select: a repo is rarely worked on through exactly one agent, and installing a
            // second tool's skills later means re-running init. `all` is a row rather than a
            // keystroke people have to discover.
            const ALL = 'all of them';
            const catalogue = ['claude-code', 'cursor', 'windsurf', 'opencode', 'antigravity', 'other'];
            const picked = await multiSelect(
                'Which AI tools work in this repo?',
                [ALL, ...catalogue],
                [tool],
            );
            tools = picked.includes(ALL) ? catalogue : picked;
            // `aiTool` stays a single value in config and on the wire: every consumer of it —
            // doctor, apply, the server's stack record — predates multi-tool and reads a string.
            // The first pick is the primary; the rest still get their skills installed below.
            tool = tools[0] ?? tool;
        }
    }
    if (tools.length === 0) tools = [tool];

    if (!isJson && !isJoin) console.log(`Detecting your stack... -> ${appInfo.kind} (${appInfo.evidence.join(', ')})`);

    let injected = false;
    let routedToSkill = false;
    let filesMod: string[] = [];
    let skillFiles: string[] = [];
    let skillWarnings: SkillWarning[] = [];

    // --pin asks the server which build it is serving and nails the page to it, with the integrity
    // hash the server itself publishes. Resolved HERE, before the stack branch, because the static
    // and Vite injectors both need it — and resolved once, so a failure to reach the manifest is
    // reported with context instead of silently producing an unpinned tag the developer believes
    // is pinned.
    let pin: { version: string; integrity: string } | null = null;
    if (!isJoin && options['pin'] === true) {
        try {
            const manifest = await api<any>(server as string, '/pinsay.version.json');
            const version = manifest?.hash;
            const integrity = manifest?.files?.['widget.js']?.integrity;
            if (!version || !integrity) {
                throw new Error('the server published no hash/integrity for widget.js');
            }
            pin = { version, integrity };
        } catch (err: any) {
            console.error(
                `Could not pin the widget: ${err?.message ?? err}. ` +
                    `Re-run without --pin to install the floating build.`,
            );
            process.exit(1);
        }
    }

    // How reviewers open the widget: embedded in the app (today's default), or via a Chrome
    // extension that injects it — no code change needed. Asked right before the injection block,
    // now that the detected stack is known, so an interactive answer is never wasted work: skip it
    // whenever there is nothing to decide (an explicit --delivery, --yes/--json defaulting to
    // embed, a join reading it back from config, or --no-inject, which already means "no code
    // injection" and stays embed).
    let delivery: 'embed' | 'extension' =
        deliveryFlag === 'extension' ? 'extension' :
        deliveryFlag === 'embed' ? 'embed' :
        isJoin ? (config.delivery ?? 'embed') : 'embed';
    if (!deliveryFlag && !isJoin && !isYes && !options['no-inject']) {
        const choice = await select('How will reviewers open the feedback widget?', [
            'Embed it in this app (recommended — works for every reviewer, no install)',
            'Chrome extension only (no code changes; each reviewer installs the extension)',
        ]);
        delivery = choice.startsWith('Chrome extension') ? 'extension' : 'embed';
    }

    // Questioning is over; hand stdin back. The shared interface would otherwise keep the event
    // loop alive, which only goes unnoticed because every exit path here calls process.exit.
    closePrompts();

    // A join never injects: the embed snippet (or nothing, for extension delivery) is already in
    // the app's committed source — that is the entire point of committing it in the first place.
    // Re-injecting here would either duplicate the snippet or stamp a different reviewer's project
    // key over the one the team already committed.
    if (!isJoin && !options['no-inject'] && delivery !== 'extension') {
        const explicitHtml = options['html'] as string | undefined;
        // An explicitly named HTML file outranks stack detection.
        //
        // Detection answers "how would I find the right file myself", which is a different question
        // from "which file did you just tell me to use". A monorepo reports `monorepo` and has no
        // single entry point to guess at — but `--html apps/profile/src/index.html` is not a guess,
        // and silently ignoring it (as this did) leaves the user staring at "Widget not found"
        // having named the file on the command line.
        if (explicitHtml && appInfo.kind !== 'vite') {
            const htmlPath = await injectStatic(cwd, explicitHtml, {
                server: server as string,
                key: finalProjectKey,
                environment: env,
                pin,
                environments: envs,
                environmentPinned,
            });
            filesMod = [htmlPath];
            injected = true;
            if (!isJson) console.log(`Injected widget into ${htmlPath}`);
        } else if (appInfo.kind === 'vite') {
            filesMod = await injectVite(cwd, { server: server as string, key: finalProjectKey, environment: env, pin, environmentPinned }, options['html'] as string);
            injected = true;
            if (!isJson) console.log(`Injected widget into ${filesMod.join(', ')}`);
        } else if (appInfo.kind === 'static') {
            const htmlPath = await injectStatic(cwd, options['html'] as string, { server: server as string, key: finalProjectKey, environment: env, pin, environments: envs, environmentPinned });
            filesMod = [htmlPath];
            injected = true;
            if (!isJson) console.log(`Injected widget into ${htmlPath}`);
        } else if (appInfo.kind !== 'unknown') {
            routedToSkill = true;
            if (!isJson) {
                console.log(`ℹ ${appInfo.kind} detected — there's no single entry point to inject into automatically.
  If you know the file, name it and re-run — that always wins over detection:
    npx -y pinsay-cli init --html path/to/index.html
  Otherwise the pinsay-init skill was installed for ${tool}; run it and it will mount the widget:
    /pinsay-init (or @pinsay-init, depending on your AI tool)
  Config is already saved in .pinsay/config.json, so neither will ask for the key or project again.`);
            }
        }
    }

    // --source-map: wire in the Vite plugin that stamps component hashes. Opt-in, because it
    // edits the user's build config — the most intrusive thing this CLI does. Unaffected by join
    // mode: still opt-in, still only runs when the flag is passed.
    let sourceMapNote = '';
    if (options['source-map']) {
        const res = await injectSourceMap(cwd);
        if (res.ok) {
            sourceMapNote = res.alreadyPresent
                ? 'source mapping already configured'
                : `source mapping enabled (${res.files.join(', ')})`;
            filesMod.push(...res.files);
            if (!isJson) console.log(`✔ ${sourceMapNote}`);
        } else {
            sourceMapNote = `source mapping NOT enabled: ${res.reason}`;
            // Never fail the install for this: the widget works without it.
            if (!isJson) console.error(`⚠ ${sourceMapNote}`);
        }
    }

    const skillHide: string[] = [];
    if (!options['no-skills']) {
        // Skills and pinsay.sh are gitignored (derived, per-machine) — every clone needs its own
        // copy, a join included. This is, in fact, the main thing a join DOES.
        if (!isJson) console.log(`Installing AI skills for ${tools.join(', ')}`);
        const skillsDir = options['skills-dir'] as string;
        // One pass per selected tool. A --skills-dir override names a single directory, so it can
        // only apply to the primary tool — installing every tool into it would have them overwrite
        // each other's files.
        const installed: string[] = [];
        for (const t of tools) {
            try {
                const r = await installSkills(server as string, t, cwd, t === tool ? skillsDir : undefined);
                installed.push(...r.files);
                skillWarnings.push(...r.warnings);
                skillHide.push(...r.hide);
            } catch (err: any) {
                // installSkills reports file problems as warnings; this only catches a bug, and even
                // then the rest of init (config, widget, stack) must stand.
                skillWarnings.push({
                    tool: t,
                    path: '(all skill files)',
                    message: `could not install the skills (${err?.message ?? err}).`,
                    hint: 'Run "npx pinsay-cli update" to try again.',
                });
            }
        }
        if (!isJson) for (const line of formatSkillWarnings(skillWarnings)) console.error(line);
        filesMod.push(...installed);
        // Kept for the human summary below: "installed" does not tell anyone WHAT was written into
        // their repository, and these are files they will want to find, read and commit.
        // Deduplicated: several tools share the .agents/ layout, so installing for three of them
        // listed the same two paths three times over in the summary.
        skillFiles = [...new Set(installed.filter((f) => f.includes('SKILL.md') || f.endsWith('.md')))];
    }
    const hidden = await hidePinsayFiles(cwd, [...skillsDirExtra(options['skills-dir'] as string), ...skillHide]);
    if (!isJson) for (const line of formatHideWarnings(hidden)) console.error(line);

    const pkgStr = await fs.readFile(join(cwd, 'package.json'), 'utf8').catch(() => '{}');
    const tokens = extractTokens(JSON.parse(pkgStr));
    const stackMeta = { frontend: tokens.frontend, backend: tokens.backend, aiTool: tool };

    // On a join, .pinsay/stack.json is gitignored derived state exactly like the skills — but
    // unlike them it is usually ALREADY on disk (the first developer's install wrote it, and it
    // rarely differs machine to machine). Refreshing it unconditionally would mean every `init`
    // re-detects design tokens and re-POSTs the stack on every clone; only do that work when the
    // file is actually missing.
    let stackFileExists = false;
    try {
        await fs.access(join(cwd, '.pinsay/stack.json'));
        stackFileExists = true;
    } catch {
        stackFileExists = false;
    }

    if (!isJoin || !stackFileExists) {
        let serverStackResponse: any = null;
        try {
            // `token`, not `key`. /api/projects/{key}/stack is [Authorize] and expects the JWT that
            // was already exchanged above; sending the raw API key as a Bearer 401s every time. The
            // catch below swallowed it, so stack.json was never written and `doctor` reported
            // "Stack not registered" on a perfectly good install.
            const body = buildRequestBody(stackMeta);
            serverStackResponse = await api(server as string, `/api/projects/${finalProjectKey}/stack`, { method: 'POST', body, token });
        } catch (e: any) {
            if (!isJson) console.log(`⚠ Stack not registered (${e.code || 500})`);
        }

        const noDesign = Boolean(options['no-design']);
        let designBlock: DesignBlock | null = null;
        if (!noDesign) {
            designBlock = await detectDesignTokens(cwd);
            const designSummary = summarizeDesignTokens(designBlock.tokens, designBlock.libraries);
            if (!isJson) {
                console.log(`✔ Design tokens: ${designSummary} → .pinsay/stack.json`);
            }
        }

        const mergedStack = mergeStack(stackMeta, serverStackResponse?.data ?? serverStackResponse, noDesign ? null : designBlock);
        await writeStackFile(cwd, mergedStack);
    }

    // The HTML we actually wrote to, so `doctor` can find the widget in a repo whose layout it
    // would never guess. Relative, because the config is committed and an absolute path would be
    // wrong on every other machine.
    //
    // Only set when THIS run injected: a join never injects, and must not clobber an `htmlPath`
    // an earlier install already recorded — spreading an explicit `undefined` into writeConfig's
    // merge would drop the existing key instead of leaving it alone.
    const injectedHtml = injected
        ? filesMod.find((f) => f.toLowerCase().endsWith('.html'))?.replace(`${cwd}/`, '')
        : undefined;
    // No `environment`/`environments` written — see `PinSayConfig`'s `@deprecated` docs in
    // config.ts. Environments and their activation are a dashboard concern now; `env`/`envs` above
    // exist only to drive this run's injection and (opt-in, via `--environment`) activation.
    const configPatch: Record<string, unknown> = {
        project: finalProjectKey,
        aiTool: tool,
        skillsDir: options['skills-dir'] as string,
        cliVersion: BUILD_CLI_VERSION,
        delivery,
    };
    if (injectedHtml !== undefined) configPatch.htmlPath = injectedHtml;
    await writeConfig(cwd, configPatch);
    filesMod.push('.pinsay/config.json');
    if (writeLocalCreds) {
        // Re-write credentials now that the project key is final, so pinsay.sh can resolve
        // the project from this file in repos that have no .env (see writeCredentials). Skipped
        // entirely when the key lives in the global store instead — there is no repo-local secret
        // to keep in sync.
        await writeCredentials(cwd, key, { project: finalProjectKey });
        // Written back near the top of this function, long before filesMod exists. It is the one
        // file in this list that holds a secret, so omitting it from `--json`'s `files` is the
        // worst omission of the set: a caller reading that list to know what to gitignore, review
        // or clean up never sees it.
        filesMod.push('.pinsay/credentials.env');
    }

    if (!isJson) console.log('Verifying...');
    // Real checks now, against the install that was just written. This previously called a stub
    // that returned [] — the "Verifying..." line printed and nothing was ever verified.
    const checks = await runInitChecks(cwd, { server: server as string, project: finalProjectKey }, BUILD_CLI_VERSION);
    if (!isJson) {
        const icon = { ok: '✔', warn: '⚠', error: '✘' } as const;
        for (const c of checks) {
            console.log(`${icon[c.status]} ${c.id}: ${c.message}`);
        }
    }

    await postEvent(server as string, token, { type: 'installed', projectKey: finalProjectKey, meta: { stack: stackMeta, aiTool: tool, injected, cliVersion: BUILD_CLI_VERSION, mode } });

    if (isJson) {
        console.log(JSON.stringify({
            ok: true,
            mode,
            product,
            server,
            project: { key: finalProjectKey, name: projectName, created },
            // Only present when `--environment` was explicitly given — environments are otherwise a
            // dashboard concern this run never touched.
            environment: environmentPinned ? env : undefined,
            delivery,
            extension: { storeUrl: branding.extension?.storeUrl || '', zipUrl: branding.extension?.zipUrl || '' },
            appUrl: appUrl || null,
            appUrlSource: source,
            aiTool: tool,
            stack: { kind: appInfo.kind, evidence: appInfo.evidence },
            injected,
            routedToSkill,
            files: filesMod,
            skillWarnings,
            hiddenFromGit: hidden.status,
            trackedPinsayFiles: hidden.tracked,
            checks,
            cliVersion: BUILD_CLI_VERSION
        }));
        process.exit(0);
    }

    // Formatted so the one thing the reader must DO is the thing they see.
    //
    // The previous summary ran the state and the next action together in one undifferentiated
    // list, then buried both under an MCP JSON blob — so an install that still needed the skill
    // run looked finished. The action now gets its own titled block, in colour, last.
    const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
    const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
    const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
    const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
    const rule = dim('─'.repeat(60));

    // Only shown when `--environment` was explicitly given — otherwise environments are a dashboard
    // concern this run never touched, and printing a defaulted "local" here would misstate that.
    const envLabel = environmentPinned ? (envs.length > 1 ? envs.join(', ') : env) : null;
    const keyLine = keyLivesGlobally
        ? `this machine's global store ${dim('(~/.config/pinsay/credentials.json)')}`
        : `.pinsay/credentials.env ${dim('(gitignored)')}`;

    if (isJoin) {
        console.log(`
${rule}
${green('✔')} ${bold(`Joined ${product} project ${finalProjectKey} as ${me?.displayName ?? 'you'}`)}
${envLabel !== null ? `\n  ${dim('Environment(s)')}  ${envLabel}` : ''}
  ${dim('Server')}          ${server}
  ${dim('Key')}             ${keyLine}
  ${dim('Skills')}          ${skillFiles.length ? skillFiles.join('\n                    ') : (skillWarnings.length ? 'not installed — see the warning above' : 'installed')}
${rule}`);
    } else {
        console.log(`
${rule}
${green('✔')} ${bold(`${product} is set up`)}

  ${dim('Project')}       ${projectName || finalProjectKey} ${dim(`(${finalProjectKey})`)}
${envLabel !== null ? `  ${dim('Environments')}  ${envLabel}\n` : ''}  ${dim('Server')}        ${server}
  ${dim('Key')}           ${keyLine}
  ${dim('Skills')}        ${skillFiles.length ? skillFiles.join('\n                ') : (skillWarnings.length ? 'not installed — see the warning above' : 'installed')}
${rule}`);
    }

    if (delivery === 'extension') {
        const storeUrl = branding.extension?.storeUrl || '';
        const zipUrl = branding.extension?.zipUrl || '';
        const installLine = storeUrl
            ? `  1. Install the extension: ${cyan(storeUrl)}`
            : `  1. ${cyan(`Your admin has not set the Chrome Web Store URL yet (${product} → Settings → Extension).`)}` +
              (zipUrl ? `\n     Manual install: ${zipUrl} → chrome://extensions → Load unpacked` : '');
        console.log(`
${bold('Next')}  Reviewers open the widget through the ${product} Chrome extension — nothing was injected.

${installLine}
  2. Open the extension and sign in with your ${product} account.
  3. Open your app, click the extension icon, choose project ${dim(finalProjectKey)}, Activate.
  4. Then ${bold('npx pinsay-cli list')} / ${bold('apply')} as usual.
      ${dim(`Dashboard: ${branding.urls?.app || server}`)}`);
    } else if (isJoin && config.htmlPath) {
        console.log(`
${bold('Next')}  ${product} is already embedded in this app's committed source — nothing to inject.
      Start your dev server, open the app, and the ${product} button should appear.
      Then ${bold('npx pinsay-cli list')} / ${bold('apply')} as usual.
      ${dim(`Dashboard: ${branding.urls?.app || server}`)}`);
    } else if (isJoin) {
        // The first install here was skill-routed too (or ran with --no-inject) — `config.htmlPath`
        // was never recorded, so telling this developer the widget "is already embedded" would be
        // false: nothing was ever mounted. Point at the skill instead, the same guidance a fresh
        // skill-routed install gives below.
        console.log(`
${bold('Next')}  ${cyan(`The widget is not mounted yet — ${appInfo.kind} has no single entry point to inject into.`)}

      Run this in ${tool}:   ${bold('/pinsay-init')}
      ${dim('It reads .pinsay/config.json, so it will not ask for your key or project again.')}
      ${dim(`Dashboard: ${branding.urls?.app || server}`)}`);
    } else if (injected) {
        console.log(`
${bold('Next')}  Start your dev server and open the app — the ${product} button should appear.
      ${dim(`Widget mounted in ${filesMod.find((f) => f.endsWith('.html')) ?? 'your HTML'}`)}
      ${dim(`Dashboard: ${branding.urls?.app || server}`)}`);
    } else {
        // The install is NOT finished here, and saying so plainly is the whole point of the block.
        console.log(`
${bold('Next')}  ${cyan(`The widget is not mounted yet — ${appInfo.kind} has no single entry point to inject into.`)}

      Run this in ${tool}:   ${bold('/pinsay-init')}
      ${dim('It reads .pinsay/config.json, so it will not ask for your key or project again.')}

      ${dim(`Or name the file yourself:  pinsay init --html path/to/index.html`)}
      ${dim(`Dashboard: ${branding.urls?.app || server}`)}`);
    }

    const mcpConfigPaths: Record<string, string> = {
      'claude-code': '~/.claude.json',
      claude: '~/.claude.json',
      cursor: '~/.cursor/mcp.json (or Cursor Settings > MCP)',
      windsurf: '~/.codeium/windsurf/mcp_config.json',
      opencode: '~/.config/opencode/opencode.json',
    };
    const toolKey = (tool || '').toLowerCase();
    const configPath = mcpConfigPaths[toolKey] || "your tool's user MCP settings";

    // Optional, so it reads as optional. It used to be the last and largest thing printed, which
    // made a 12-line JSON blob look like a required step and pushed the actual next action off
    // screen.
    console.log(`
${dim('─'.repeat(60))}
${dim(`Optional — MCP server, for tool-native access to comments (${tool}):`)}
${dim(`Add to ${configPath}, user-level, do not commit:`)}
${dim('  { "mcpServers": { "pinsay": { "command": "npx", "args": ["-y", "pinsay-cli", "mcp"] } } }')}`);

    process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Multi-project (monorepo) support
// ---------------------------------------------------------------------------------------------

/**
 * The app-identifying phrase used in every question asked once per app during multi-project setup
 * — e.g. `apps/tuwaiq-clubs` — so a run that selected several Nx apps never asks an ambiguous
 * "this app?" once app 2 (or 3, ...)'s questions begin. One place, so both questions
 * (`projectQuestion` and the delivery select in `setupOneProject`) agree on the wording if it ever
 * changes.
 */
export function appLabel(appDir: string): string {
    return appDir;
}

/**
 * Wording for "which project": unambiguous ("this app") for the single-project flow, where there is
 * only ever one app to ask about — or naming the app (`appLabel`) once a single interactive run can
 * ask this question more than once, back to back, for several apps (see `handleMultiProjectSetup`'s
 * per-app header).
 */
export function projectQuestion(label?: string): string {
    return label ? `Which PinSay project is ${label}?` : 'Which project is this app?';
}

/** An absolute path made repo-root-relative, with forward slashes — what a `ProjectEntry` stores. */
function toRootRelative(root: string, p: string): string {
    const abs = isAbsolute(p) ? p : resolve(p);
    return relative(root, abs).split(sep).join('/');
}

/** Does this app directory have its own Vite config? Decides `injectVite` vs `injectStatic`. */
async function hasViteConfig(appDir: string): Promise<boolean> {
    for (const ext of ['ts', 'js', 'mjs', 'mts']) {
        if (existsSync(join(appDir, `vite.config.${ext}`))) return true;
    }
    return false;
}

async function readJsonSafe(p: string): Promise<any | null> {
    try {
        return JSON.parse(await fs.readFile(p, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * The HTML file to inject into for one app, tried in order: an explicit `--html` (used as-is,
 * trusted — `injectStatic`/`injectVite` themselves report a clear error if it does not exist),
 * `<appDir>/index.html`, `<appDir>/src/index.html` (the real shape of every app in an Nx workspace
 * like tuwaiq-mono-spa — `detectStack`'s own `<cwd>/index.html`-only check misses this entirely,
 * and an app directory with no `package.json` of its own never resolves to a `vite`/`static` kind
 * in the first place, so injection silently did nothing), `<sourceRoot>/index.html` when the app's
 * `project.json` declares a `sourceRoot` (Nx's own field for exactly this, relative to the repo
 * root rather than the app directory), then `<appDir>/public/index.html` (CRA/Nx-with-webpack).
 * Returns the first that exists, or `undefined` if none do.
 */
async function resolveHtmlCandidate(root: string, appDir: string, explicitHtml?: string): Promise<string | undefined> {
    if (explicitHtml) return explicitHtml;

    const targetCwd = join(root, appDir);
    const candidates = [join(targetCwd, 'index.html'), join(targetCwd, 'src', 'index.html')];

    const projectJson = await readJsonSafe(join(targetCwd, 'project.json'));
    if (projectJson?.sourceRoot) {
        candidates.push(join(root, projectJson.sourceRoot, 'index.html'));
    }

    candidates.push(join(targetCwd, 'public', 'index.html'));

    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return undefined;
}

/**
 * Where the app that used to be THE single project probably lives, for the single→multi
 * migration (see `handleMultiProjectSetup`). Derived from the recorded `htmlPath`
 * (`apps/profile/src/index.html` → `apps/profile`); a Vite/webpack `src/index.html` layout has its
 * app root one level above `index.html`'s directory, so a trailing `/src` is stripped too. Falls
 * back to `.` — the safe assumption for a repo that never recorded an `htmlPath` at all, e.g. an
 * `extension`-delivery install, which injects nothing — and the caller warns the migrated path
 * should be double-checked either way.
 */
function deriveAppDirFromHtmlPath(htmlPath?: string): string {
    if (!htmlPath) return '.';
    let dir = dirname(htmlPath).replace(/\/src$/, '');
    return dir === '' || dir === '.' ? '.' : dir;
}

/**
 * Picks (or creates) the PinSay project a single app belongs to — the same question/creation
 * flow `init` has always asked, factored out so both the single-project flow and the
 * multi-project one (`setupOneProject`, one call per app) ask it identically.
 */
async function selectOrCreateProject(
    server: string,
    token: string | undefined,
    isYes: boolean,
    presetKey?: string,
    presetCreate?: string,
    /** Names the app in the question — e.g. `apps/tuwaiq-clubs` — when this run may ask it more
     *  than once (see `appLabel`). Omitted for the single-project flow, where "this app?" is
     *  already unambiguous. */
    label?: string,
): Promise<{ key: string; name: string; created: boolean }> {
    let finalProjectKey = presetKey || '';
    let projectName = presetCreate || finalProjectKey;
    let created = false;

    if (!isYes && !presetKey && !presetCreate) {
        const projects = await api<any[]>(server, '/api/admin/projects', { token }).catch(() => []);
        const createOpt = '＋ Create a new project…';
        const choices = projects.map((p) => `${p.name}  (${p.key})`).concat(createOpt);

        let choice = createOpt;
        if (projects.length > 0) {
            choice = await select(projectQuestion(label), choices);
        }

        if (choice === createOpt) {
            const name = await ask('Project name');
            let derivedKey = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            finalProjectKey = await ask('Project key', {
                default: derivedKey,
                validate: (v) => (/^[a-z0-9-]+$/.test(v) ? undefined : 'Must match ^[a-z0-9-]+$'),
            });
            projectName = name;
            created = true;
        } else {
            const match = choice.match(/\((.*?)\)$/);
            if (match) finalProjectKey = match[1];
            const picked = projects.find((p) => p.key === finalProjectKey);
            projectName = picked?.name || finalProjectKey;
        }
    } else if (isYes && presetKey && !presetCreate) {
        const existing = await api<any[]>(server, '/api/admin/projects', { token }).catch(() => []);
        if (!existing.some((p) => p.key === presetKey)) {
            created = true;
            projectName = presetKey;
        }
    } else if (presetCreate) {
        created = true;
        let derivedKey = presetCreate.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        finalProjectKey = presetKey || derivedKey;
        projectName = presetCreate;
    }

    if (created) {
        try {
            await api(server, '/api/admin/projects', { method: 'POST', body: { key: finalProjectKey, name: projectName }, token });
        } catch (err: any) {
            if (err instanceof ApiError && err.code === 409) {
                console.error('Key already exists, choose another.');
                process.exit(3);
            } else if (err instanceof ApiError && err.code === 403) {
                console.error('This account cannot create projects.');
                process.exit(3);
            } else if (err instanceof ApiError && err.code === 400) {
                console.error(err.message);
                process.exit(1);
            } else {
                console.error(`Could not create project: ${err?.message ?? err}`);
                process.exit(1);
            }
        }
    }

    return { key: finalProjectKey, name: projectName, created };
}

/** Every AI tool this install installs skills for — a faithful port of the single-project flow's
 *  inline detection, factored out so `handleMultiProjectSetup` (asked once, repo-level) uses the
 *  exact same rule instead of a second copy that could drift. */
async function resolveAiTool(
    options: Record<string, string | boolean>,
    config: any,
    isYes: boolean,
): Promise<{ tool: string; tools: string[] }> {
    let tool = (options['tool'] as string) || config.aiTool;
    let tools: string[] = tool ? [tool] : [];
    if (!tool) {
        if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) tool = 'claude-code';
        else if (process.env.ANTIGRAVITY_AGENT || process.env.GEMINI_CLI) tool = 'antigravity';
        else if (process.env.TERM_PROGRAM && process.env.TERM_PROGRAM.includes('Cursor')) tool = 'cursor';
        else if (process.env.WINDSURF) tool = 'windsurf';
        else if (process.env.OPENCODE) tool = 'opencode';
        else tool = isYes ? 'other' : 'claude-code';

        if (!isYes && !options['tool']) {
            const ALL = 'all of them';
            const catalogue = ['claude-code', 'cursor', 'windsurf', 'opencode', 'antigravity', 'other'];
            const picked = await multiSelect('Which AI tools work in this repo?', [ALL, ...catalogue], [tool]);
            tools = picked.includes(ALL) ? catalogue : picked;
            tool = tools[0] ?? tool;
        }
    }
    if (tools.length === 0) tools = [tool];
    return { tool, tools };
}

/** The repo-level default `delivery` for a multi-project install — asked once, not per app. */
async function resolveDeliveryDefault(
    options: Record<string, string | boolean>,
    config: any,
    isYes: boolean,
): Promise<'embed' | 'extension'> {
    const deliveryFlag = options['delivery'] as string | undefined;
    if (deliveryFlag === 'extension' || deliveryFlag === 'embed') return deliveryFlag;
    if (config.delivery === 'embed' || config.delivery === 'extension') return config.delivery;
    if (isYes || options['no-inject']) return 'embed';
    const choice = await select('How will reviewers open the feedback widget, by default?', [
        'Embed it in this app (recommended — works for every reviewer, no install)',
        'Chrome extension only (no code changes; each reviewer installs the extension)',
    ]);
    return choice.startsWith('Chrome extension') ? 'extension' : 'embed';
}

/** `--pin`, resolved once per repo (a single manifest fetch) and shared by every app this run
 *  injects into. */
async function resolvePin(
    server: string,
    options: Record<string, string | boolean>,
): Promise<{ version: string; integrity: string } | null> {
    if (options['pin'] !== true) return null;
    try {
        const manifest = await api<any>(server, '/pinsay.version.json');
        const version = manifest?.hash;
        const integrity = manifest?.files?.['widget.js']?.integrity;
        if (!version || !integrity) throw new Error('the server published no hash/integrity for widget.js');
        return { version, integrity };
    } catch (err: any) {
        console.error(
            `Could not pin the widget: ${err?.message ?? err}. Re-run without --pin to install the floating build.`,
        );
        process.exit(1);
    }
}

/**
 * Sets up ONE app inside a multi-project repo: picks/creates its PinSay project, its delivery
 * (defaulting to the repo default), injects the widget into that app's own directory, detects/
 * registers its stack, and writes `.pinsay/projects/<key>.stack.json`. Environments are never
 * asked — `presetEnvironments` (from `--environment`) only activates the project, and nothing is
 * recorded to config either way (see `ProjectEntry`'s `@deprecated` docs in config.ts).
 *
 * Shared by both multi-project entry points: `--path` (exactly one app, presets from flags) and
 * the interactive Nx picker (one call per selected app, nothing preset — everything asked).
 */
async function setupOneProject(ctx: {
    cwd: string;
    appDir: string;
    server: string;
    token?: string;
    isYes: boolean;
    presetKey?: string;
    presetCreate?: string;
    presetEnvironments?: string;
    repoDefaultDelivery: 'embed' | 'extension';
    presetDelivery?: 'embed' | 'extension';
    noDesign: boolean;
    noInject: boolean;
    explicitHtml?: string;
    pin: { version: string; integrity: string } | null;
    interactive: boolean;
    aiTool: string;
}): Promise<{
    key: string;
    name: string;
    created: boolean;
    entry: ProjectEntry;
    injected: boolean;
    filesModified: string[];
    /** The delivery actually used for this app (repo default, or this app's own override). */
    effectiveDelivery: 'embed' | 'extension';
    /** Set when injection was attempted (delivery !== 'extension', --no-inject not given) but no
     *  HTML candidate existed to inject into — the caller surfaces this as a heads-up. */
    noHtmlFound: boolean;
}> {
    const { cwd, appDir, server, token } = ctx;
    const targetCwd = join(cwd, appDir);
    const label = appLabel(appDir);

    const { key, name, created } = await selectOrCreateProject(server, token, ctx.isYes, ctx.presetKey, ctx.presetCreate, label);

    // No "Which environment(s) does this app run in?" prompt — same product decision as the
    // single-project flow above: environments and their activation live in the dashboard now.
    // `--environment` (via `--path`'s preset) is the only opt-in, and it activates without asking.
    const ALL_ENVS = ['local', 'staging', 'production'];
    let envs: string[];
    let environmentPinned: boolean;
    if (ctx.presetEnvironments !== undefined) {
        envs = ctx.presetEnvironments.split(',').map((e) => e.trim()).filter(Boolean);
        const bad = envs.find((e) => !ALL_ENVS.includes(e));
        if (bad) {
            console.error(`Unknown environment "${bad}". Valid values: ${ALL_ENVS.join(', ')}.`);
            process.exit(2);
        }
        environmentPinned = envs.length > 0;
        if (envs.length === 0) envs = ['local'];
    } else {
        envs = ['local'];
        environmentPinned = false;
    }
    const env = ALL_ENVS.filter((e) => envs.includes(e))[0] ?? 'local';

    if (environmentPinned) {
        const projectRow = await api<any[]>(server, '/api/admin/projects', { token })
            .then((rows) => rows.find((p) => p.key === key))
            .catch(() => null);
        if (projectRow?.id) {
            const activation: Record<string, boolean> = {};
            if (envs.includes('local') && !projectRow.isActiveLocal) activation['isActiveLocal'] = true;
            if (envs.includes('staging') && !projectRow.isActiveStaging) activation['isActiveStaging'] = true;
            if (envs.includes('production') && !projectRow.isActiveProduction) activation['isActiveProduction'] = true;
            if (Object.keys(activation).length) {
                await api(server, `/api/admin/projects/${projectRow.id}`, { method: 'PATCH', body: activation, token }).catch(() => {});
            }
        }
    }

    let delivery: 'embed' | 'extension' = ctx.presetDelivery ?? ctx.repoDefaultDelivery;
    if (ctx.interactive && ctx.presetDelivery === undefined) {
        const choice = await select(`How will reviewers open the widget for ${label}?`, [
            `Embed it in this app${ctx.repoDefaultDelivery === 'embed' ? ' (repo default)' : ''}`,
            `Chrome extension only${ctx.repoDefaultDelivery === 'extension' ? ' (repo default)' : ''}`,
        ]);
        delivery = choice.startsWith('Chrome extension') ? 'extension' : 'embed';
    }

    let injected = false;
    let filesModified: string[] = [];
    let injectedHtmlPath: string | undefined;
    let noHtmlFound = false;

    if (!ctx.noInject && delivery !== 'extension') {
        const htmlCandidate = await resolveHtmlCandidate(cwd, appDir, ctx.explicitHtml);
        if (htmlCandidate) {
            const isVite = await hasViteConfig(targetCwd);
            if (isVite) {
                filesModified = await injectVite(
                    targetCwd,
                    { server, key, environment: env, pin: ctx.pin, environmentPinned },
                    htmlCandidate,
                );
            } else {
                const p = await injectStatic(targetCwd, htmlCandidate, {
                    server, key, environment: env, pin: ctx.pin, environments: envs, environmentPinned,
                });
                filesModified = [p];
            }
            injected = true;
            injectedHtmlPath = toRootRelative(cwd, htmlCandidate);
        } else {
            noHtmlFound = true;
        }
    }

    let pkgStr = await fs.readFile(join(targetCwd, 'package.json'), 'utf8').catch(() => '');
    if (!pkgStr) pkgStr = await fs.readFile(join(cwd, 'package.json'), 'utf8').catch(() => '{}');
    const tokens = extractTokens(JSON.parse(pkgStr || '{}'));
    const stackMeta = { frontend: tokens.frontend, backend: tokens.backend, aiTool: ctx.aiTool };

    let serverStackResponse: any = null;
    try {
        const body = buildRequestBody(stackMeta);
        serverStackResponse = await api(server, `/api/projects/${key}/stack`, { method: 'POST', body, token });
    } catch {
        // best-effort, exactly like the single-project flow
    }
    const designBlock = ctx.noDesign ? null : await detectDesignTokens(targetCwd, { root: cwd }).catch(() => null);
    const merged = mergeStack(stackMeta, serverStackResponse?.data ?? serverStackResponse, designBlock);
    await writeStackFile(cwd, merged, key);

    // No `environment`/`environments` recorded — see `ProjectEntry`'s `@deprecated` docs in
    // config.ts. `env`/`envs` above exist only to drive this call's injection and activation.
    const entry: ProjectEntry = { path: appDir };
    if (injectedHtmlPath !== undefined) entry.htmlPath = injectedHtmlPath;
    if (delivery !== ctx.repoDefaultDelivery) entry.delivery = delivery;

    return { key, name, created, entry, injected, filesModified, effectiveDelivery: delivery, noHtmlFound };
}

/**
 * Handles `init` in an already-configured multi-project repo with nothing new to add: installs
 * skills once at the root (they're gitignored, so a fresh clone/machine has none) and refreshes
 * only the per-app stack files that are missing — mirrors the single-project join, scaled to N
 * projects. Never returns.
 */
async function handleMultiJoin(
    cwd: string,
    config: PinSayConfig,
    server: string,
    product: string,
    isJson: boolean,
    options: Record<string, string | boolean>,
    token: string | undefined,
    me: any,
): Promise<never> {
    closePrompts();
    const tool = (options['tool'] as string) || config.aiTool || 'other';
    const skillWarnings: SkillWarning[] = [];
    const hide: string[] = [];
    if (!options['no-skills']) {
        try {
            const r = await installSkills(server, tool, cwd, options['skills-dir'] as string);
            skillWarnings.push(...r.warnings);
            hide.push(...r.hide);
        } catch (err: any) {
            skillWarnings.push({ tool, path: '(all skill files)', message: `could not install the skills (${err?.message ?? err}).`, hint: 'Run "npx pinsay-cli update" to try again.' });
        }
        if (!isJson) for (const line of formatSkillWarnings(skillWarnings)) console.error(line);
    }
    const hidden = await hidePinsayFiles(cwd, [...skillsDirExtra(options['skills-dir'] as string), ...hide]);
    if (!isJson) for (const line of formatHideWarnings(hidden)) console.error(line);

    const projects = listProjects(config);
    for (const p of projects) {
        const relStack = stackFileRelPath(p.key);
        let exists = true;
        try {
            await fs.access(join(cwd, relStack));
        } catch {
            exists = false;
        }
        if (exists) continue;

        const appCwd = join(cwd, p.path);
        let pkgStr = await fs.readFile(join(appCwd, 'package.json'), 'utf8').catch(() => '');
        if (!pkgStr) pkgStr = await fs.readFile(join(cwd, 'package.json'), 'utf8').catch(() => '{}');
        const tokens = extractTokens(JSON.parse(pkgStr || '{}'));
        const stackMeta = { frontend: tokens.frontend, backend: tokens.backend, aiTool: config.aiTool };
        let serverStackResponse: any = null;
        try {
            const body = buildRequestBody(stackMeta);
            serverStackResponse = await api(server, `/api/projects/${p.key}/stack`, { method: 'POST', body, token });
        } catch {
            // best-effort
        }
        const designBlock = await detectDesignTokens(appCwd, { root: cwd }).catch(() => null);
        const merged = mergeStack(stackMeta, serverStackResponse?.data ?? serverStackResponse, designBlock);
        await writeStackFile(cwd, merged, p.key);
    }

    await writeConfig(cwd, { cliVersion: BUILD_CLI_VERSION });

    await postEvent(server, token, {
        type: 'installed',
        projectKey: projects[0]?.key,
        meta: { mode: 'join', multiProject: true, cliVersion: BUILD_CLI_VERSION },
    });

    if (isJson) {
        console.log(JSON.stringify({
            ok: true,
            mode: 'join',
            product,
            server,
            projects: projects.map((p) => ({
                key: p.key,
                path: p.path,
                injected: false,
                htmlPath: p.htmlPath,
                delivery: p.delivery ?? config.delivery ?? 'embed',
            })),
            skillWarnings,
            hiddenFromGit: hidden.status,
            trackedPinsayFiles: hidden.tracked,
            cliVersion: BUILD_CLI_VERSION,
        }));
    } else {
        console.log(`
✔ Joined ${product} (${projects.length} project${projects.length === 1 ? '' : 's'}) as ${me?.displayName ?? 'you'}
  Projects: ${projects.map((p) => `${p.key} (${p.path})`).join(', ')}
  Server: ${server}`);
    }
    process.exit(0);
}

/**
 * Adds one or more app(s) to a multi-project (monorepo) config: either the single app named by
 * `--path` (presets taken from flags, nothing else asked beyond what `--yes` already requires), or
 * — interactively, in a detected Nx workspace — every app the user picks from a multi-select,
 * asked individually. Migrates an existing single-project config into `projects` the first time
 * this runs against one. Never returns.
 */
async function handleMultiProjectSetup(args: {
    cwd: string;
    config: any;
    options: Record<string, string | boolean>;
    server: string;
    token?: string;
    key: string;
    isJson: boolean;
    isYes: boolean;
    product: string;
    pathFlag?: string;
    nxApps: DiscoveredApp[];
    configIsMulti: boolean;
    /** Whether to (re)write the repo-local `.pinsay/credentials.env` — false when the caller
     *  already resolved (or just saved) the key somewhere `resolveApiKey` will find it again on
     *  its own (env var or the global store), so there is nothing to duplicate into the repo. */
    writeLocalCreds: boolean;
}): Promise<never> {
    const { cwd, config, options, server, token, key, isJson, isYes, product, pathFlag, nxApps, configIsMulti, writeLocalCreds } = args;

    const { tool, tools } = await resolveAiTool(options, config, isYes);
    const repoDefaultDelivery = await resolveDeliveryDefault(options, config, isYes);
    const pin = await resolvePin(server, options);
    const noDesign = Boolean(options['no-design']);
    const noInject = Boolean(options['no-inject']);

    type AppSpec = {
        dir: string;
        presetKey?: string;
        presetCreate?: string;
        presetEnvironments?: string;
        presetDelivery?: 'embed' | 'extension';
        explicitHtml?: string;
    };
    let apps: AppSpec[];

    if (pathFlag) {
        apps = [
            {
                dir: pathFlag,
                presetKey: options['project'] as string | undefined,
                presetCreate: options['create'] as string | undefined,
                presetEnvironments: options['environment'] as string | undefined,
                presetDelivery:
                    options['delivery'] === 'extension' || options['delivery'] === 'embed'
                        ? (options['delivery'] as 'embed' | 'extension')
                        : undefined,
                explicitHtml: options['html'] as string | undefined,
            },
        ];
    } else {
        const existingByDir = new Map(
            Object.entries(config.projects ?? {}).map(([k, v]: [string, any]) => [v.path, k]),
        );
        const labels = nxApps.map((a) => {
            const already = existingByDir.get(a.dir);
            const tag = already ? ` (configured as ${already})` : a.note ? ` (${a.note})` : '';
            return `${a.name} — ${a.dir}${tag}`;
        });
        const picked = await multiSelect('Which apps use the feedback widget?', labels, []);
        apps = nxApps.filter((_, i) => picked.includes(labels[i])).map((a) => ({ dir: a.dir }));
        if (apps.length === 0) {
            closePrompts();
            console.log('No apps selected — nothing to do.');
            process.exit(0);
        }
    }

    const results: Array<{
        key: string;
        name: string;
        created: boolean;
        entry: ProjectEntry;
        injected: boolean;
        filesModified: string[];
        effectiveDelivery: 'embed' | 'extension';
        noHtmlFound: boolean;
    }> = [];
    for (const app of apps) {
        // A visible header per app: the questions below (`selectOrCreateProject`, environment,
        // delivery) already run strictly one app at a time (this loop is sequential), but with
        // several apps selected from the Nx multi-select, nothing on screen said WHICH app's
        // questions were currently being asked — every one read as a bare "Which project is this
        // app?" no matter how many had already gone by. Interactive only: --yes/--json presets
        // everything and asks nothing, so there is nothing to head.
        if (!isYes) {
            console.log(`\n── ${appLabel(app.dir)} ──`);
        }
        const result = await setupOneProject({
            cwd,
            appDir: app.dir,
            server,
            token,
            isYes,
            presetKey: app.presetKey,
            presetCreate: app.presetCreate,
            presetEnvironments: app.presetEnvironments,
            repoDefaultDelivery,
            presetDelivery: app.presetDelivery,
            noDesign,
            noInject,
            explicitHtml: app.explicitHtml,
            pin,
            interactive: !isYes,
            aiTool: tool,
        });
        results.push(result);
        if (!isJson) {
            if (result.effectiveDelivery === 'extension') {
                console.log(`✔ ${result.key} (${app.dir}) — nothing injected (extension)`);
            } else if (result.injected && result.entry.htmlPath) {
                console.log(`✔ ${result.key} (${app.dir}) — injected into ${result.entry.htmlPath}`);
            } else {
                console.log(`✔ ${result.key} (${app.dir})`);
                if (result.noHtmlFound) {
                    console.log(
                        `\x1b[33mHeads up:\x1b[0m automatic widget injection isn't supported for ${app.dir} yet — ` +
                        `no index.html found (checked index.html, src/index.html, public/index.html). ` +
                        `The project is still registered; run \`npx pinsay-cli init --path ${app.dir} --project ${result.key} --html <path>\` ` +
                        `once you know the file, or mount the widget by hand.`,
                    );
                }
            }
        }
    }

    closePrompts();

    const skillWarnings: SkillWarning[] = [];
    const hide: string[] = [];
    if (!options['no-skills']) {
        for (const t of tools) {
            try {
                const r = await installSkills(server, t, cwd, t === tool ? (options['skills-dir'] as string) : undefined);
                skillWarnings.push(...r.warnings);
                hide.push(...r.hide);
            } catch (err: any) {
                skillWarnings.push({ tool: t, path: '(all skill files)', message: `could not install the skills (${err?.message ?? err}).`, hint: 'Run "npx pinsay-cli update" to try again.' });
            }
        }
        if (!isJson) for (const line of formatSkillWarnings(skillWarnings)) console.error(line);
    }
    const hidden = await hidePinsayFiles(cwd, [...skillsDirExtra(options['skills-dir'] as string), ...hide]);
    if (!isJson) for (const line of formatHideWarnings(hidden)) console.error(line);

    const projectsMap: Record<string, ProjectEntry> = { ...(config.projects ?? {}) };
    let migrationNote: string | null = null;
    let migrationOk: string | null = null;
    if (!configIsMulti && config.project) {
        const oldKey = config.project as string;
        const derivedPath = deriveAppDirFromHtmlPath(config.htmlPath);
        projectsMap[oldKey] = {
            path: derivedPath,
            environment: config.environment,
            environments: config.environments,
            htmlPath: config.htmlPath,
            delivery: config.delivery,
        };
        // This same run's --path/--project can target the very project being migrated (e.g.
        // `init --path apps/profile --project X` where X was already the single project) — the
        // loop below then overwrites the fallback entry just written above with the real path from
        // `--path`, so warning "please verify this path is correct" would be describing a value
        // that no longer exists by the time config.json is written. Only warn when the migrated
        // entry truly lands on the "." fallback: this run did not touch that project AND there was
        // no recorded htmlPath to derive a real path from.
        const targetedByThisRun = results.some((r) => r.key === oldKey);
        if (targetedByThisRun) {
            migrationOk = oldKey;
        } else if (derivedPath === '.') {
            migrationNote = `Migrated existing project "${oldKey}" into the multi-project config with path "${derivedPath}" — please verify this path is correct.`;
        }
    }
    for (const r of results) projectsMap[r.key] = r.entry;

    await writeConfigFull(cwd, {
        aiTool: tool,
        skillsDir: ((options['skills-dir'] as string) || config.skillsDir) ?? undefined,
        cliVersion: BUILD_CLI_VERSION,
        delivery: repoDefaultDelivery,
        projects: projectsMap,
    });

    if (writeLocalCreds) {
        // No `project`: this repo is multi-project from here on (`projectsMap` has 2+ entries, or
        // did already), and `.pinsay/pinsay.sh` takes `-p <key>` in that mode — a single
        // hardcoded PINSAY_PROJECT line would silently pin every no-Node invocation to whichever
        // app happened to be `results[0]`, wrong for every other configured app.
        await writeCredentials(cwd, key);
    }

    await postEvent(server, token, {
        type: 'installed',
        projectKey: results[0]?.key,
        meta: { mode: 'add-project', keys: results.map((r) => r.key), cliVersion: BUILD_CLI_VERSION },
    });

    if (isJson) {
        console.log(JSON.stringify({
            ok: true,
            mode: 'add-project',
            product,
            server,
            projects: Object.entries(projectsMap).map(([k, p]) => {
                const r = results.find((res) => res.key === k);
                return { key: k, path: p.path, injected: r ? r.injected : false, htmlPath: p.htmlPath, delivery: p.delivery ?? repoDefaultDelivery };
            }),
            skillWarnings,
            hiddenFromGit: hidden.status,
            trackedPinsayFiles: hidden.tracked,
            cliVersion: BUILD_CLI_VERSION,
        }));
    } else {
        const migrationLine = migrationNote
            ? `⚠ ${migrationNote}\n`
            : migrationOk
              ? `✔ migrated "${migrationOk}" → projects map (${projectsMap[migrationOk]?.path})\n`
              : '';
        console.log(`
✔ ${product}: added ${results.length} project${results.length === 1 ? '' : 's'} — ${results.map((r) => r.key).join(', ')}
${migrationLine}  Config: .pinsay/config.json (projects map)
  Stack files: ${results.map((r) => `.pinsay/projects/${r.key}.stack.json`).join(', ')}`);
    }
    process.exit(0);
}
