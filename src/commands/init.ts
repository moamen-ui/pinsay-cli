import { multiSelect, confirm, closePrompts } from '../prompt.js';
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
import { postEvent, postSetupDone } from '../events.js';
import { runInitChecks, compareSemver, tooOldMessage } from '../checks.js';
import { promises as fs, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute, sep, basename } from 'node:path';
import { detectDesignTokens } from '../stack/design.js';
import { buildRequestBody, mergeStack, writeStackFile, stackFileRelPath } from '../stack/stackfile.js';
import { resolveApiKey, saveGlobalCredential, globalCredentialsPath } from '../credentials.js';
import { scopeFromFlags } from '../key-scope.js';
import { shareFromFlags } from '../consent.js';
import { resolveServer } from '../server.js';
import { exitWithError, isOutage } from '../errors.js';
import { bold, dim, green, sym } from '../ui/style.js';
import { isInteractive } from '../ui/interactive.js';
import { signIn, type Session } from '../init/session.js';
import { chooseProject, createProject, slugifyKey, type ProjectChoice } from '../init/project.js';
import { decideTools, detectRepoTools, TOOL_CATALOGUE } from '../init/tool-detect.js';
import { renderPlan, planToJson, type InitPlan } from '../init/plan.js';
import { nextStepText, renderNext, type NextCase } from '../init/next-step.js';
import { createProgress, progressMode } from '../init/progress.js';
import { quickCheckLines } from '../init/quick-check.js';
import { planEmbed, runEmbed, resolvePin, findExistingWidget, resolveHtmlCandidate, hasViteConfig, type EmbedPlan } from '../embed/embed.js';
import { pinsayShNote } from '../lib/legacy.js';
import { skillFilesFor } from '../lib/skill-paths.js';

type KeySaved = 'repo' | 'global' | 'existing';
type Widget = InitPlan['widget'];

const ALL_ENVS = ['local', 'staging', 'production'];

/** SPEC B3/B5: the share answer. A flag wins, then the saved answer, then (on a terminal) the question. */
async function decideShare(
    flag: boolean | undefined,
    config: any,
    interactive: boolean,
    product: string,
): Promise<{ share: boolean; saved: boolean }> {
    if (flag !== undefined) return { share: flag, saved: false };
    if (typeof config.shareStack === 'boolean') return { share: config.shareStack, saved: true };
    if (interactive) {
        const share = await confirm(`Share your project's framework names with ${product}?`, {
            defaultYes: true,
            details: [
                'Only names like react, vite, dotnet and your AI tool, plus a "setup done" signal.',
                'Never your code or your files.',
            ],
            answerLabel: 'Share framework names',
        });
        return { share, saved: false };
    }
    return { share: true, saved: false };
}

/** Every AI tool to install skills for; `tools[0]` is the primary one recorded in config. */
async function pickTools(
    cwd: string,
    options: Record<string, string | boolean>,
    config: any,
    interactive: boolean,
): Promise<{ tool: string; tools: string[] }> {
    const d = decideTools(await detectRepoTools(cwd), {
        flagTool: typeof options['tool'] === 'string' ? (options['tool'] as string) : undefined,
        savedTool: config.aiTool,
        interactive,
    });
    let tools = d.tools;
    if (d.ask) {
        const ALL = 'all of them';
        const picked = await multiSelect('Which AI tools work in this repo?', [ALL, ...TOOL_CATALOGUE], d.preselected);
        tools = picked.includes(ALL) ? [...TOOL_CATALOGUE] : picked;
        if (tools.length === 0) tools = d.preselected;
    }
    return { tool: tools[0], tools };
}

/** Where the widget goes, decided without writing anything. A join never injects. */
async function decideWidget(
    cwd: string,
    options: Record<string, string | boolean>,
    config: any,
    ctx: { isJoin: boolean; wantEmbed: boolean; tool: string },
): Promise<{ widget: Widget; embedPlan?: EmbedPlan }> {
    if (ctx.isJoin) {
        return config.delivery === 'embed'
            ? { widget: { kind: 'already', file: config.htmlPath ?? 'your app' } }
            : { widget: { kind: 'extension' } };
    }
    if (ctx.wantEmbed) {
        const p = await planEmbed(cwd, {
            html: typeof options['html'] === 'string' ? (options['html'] as string) : undefined,
            recordedHtml: config.htmlPath,
            forInit: true,
        });
        if (p.kind === 'inject') return { widget: { kind: 'embed', files: p.files }, embedPlan: p };
        if (p.kind === 'skill') return { widget: { kind: 'embed-skill', tool: ctx.tool } };
        return { widget: { kind: 'already', file: p.htmlPath ?? 'your app' } };
    }
    const w = await findExistingWidget(cwd, config.htmlPath);
    return w ? { widget: { kind: 'already', file: w.file } } : { widget: { kind: 'extension' } };
}

/** Where this run's key ends up. A key that already resolves from env, the repo or the machine needs nothing. */
function keyPlacement(session: Session, saveGlobal: boolean): KeySaved {
    if (session.origin === 'env' || session.origin === 'repo' || session.origin === 'global') return 'existing';
    return saveGlobal ? 'global' : 'repo';
}

async function saveKey(cwd: string, server: string, session: Session, keySaved: KeySaved, project?: string): Promise<void> {
    if (keySaved === 'repo') {
        await writeCredentials(cwd, session.key, project ? { project } : {});
    } else if (keySaved === 'global') {
        await saveGlobalCredential(server, {
            apiKey: session.key,
            email: session.me.email,
            displayName: session.me.displayName,
        });
    }
}

async function readStackNames(cwd: string): Promise<{ frontend: string[]; backend: string[] }> {
    const pkgStr = await fs.readFile(join(cwd, 'package.json'), 'utf8').catch(() => '{}');
    try {
        return extractTokens(JSON.parse(pkgStr || '{}'));
    } catch {
        return { frontend: [], backend: [] };
    }
}

export async function initCommand(cwd: string, options: Record<string, string | boolean> = {}) {
    const json = options['json'] === true;
    const interactive = isInteractive(options);
    const dryRun = options['dry-run'] === true;

    const deliveryFlag = options['delivery'] as string | undefined;
    if (deliveryFlag !== undefined && deliveryFlag !== 'embed' && deliveryFlag !== 'extension') {
        exitWithError(2, `Invalid --delivery "${deliveryFlag}". Valid values: embed, extension.`, json);
    }
    const scopeResult = scopeFromFlags(options);
    if (scopeResult.error) exitWithError(2, scopeResult.error, json);
    const saveGlobal = scopeResult.scope === 'global';
    const shareResult = shareFromFlags(options);
    if (shareResult.error) exitWithError(2, shareResult.error, json);

    const htmlFlag = typeof options['html'] === 'string' ? (options['html'] as string) : undefined;
    const wantEmbed =
        options['embed'] === true || deliveryFlag === 'embed' || htmlFlag !== undefined || options['pin'] === true;
    const notes: string[] = [];
    if ((htmlFlag !== undefined || options['pin'] === true) && options['embed'] !== true && deliveryFlag !== 'embed') {
        notes.push('--html/--pin put the widget in your code (same as --embed).');
    }

    // `--path apps/x`: this run adds (or updates) ONE app inside a multi-project (monorepo) config
    // instead of setting up "the" project at the repo root. See the `projects` map in config.ts.
    const pathFlag = typeof options['path'] === 'string'
        ? String(options['path']).replace(/^\.\/+/, '').replace(/\/+$/, '')
        : undefined;
    const isAddProject = Boolean(pathFlag);

    const config: any = await readConfig(cwd).catch(() => ({}));
    const configIsMulti = isMultiProject(config);

    // A "join": .pinsay/config.json already names a project (or, in a multi-project repo, at least
    // one app under `projects`). Whoever ran `init` the first time already made every decision —
    // a second developer only needs their own API key. Never true for `--path`: adding a new app
    // to an already-configured repo is "add a project", not "join the existing one".
    const isJoin = !isAddProject && (Boolean(config.project) || configIsMulti);
    const mode: 'join' | 'install' = isJoin ? 'join' : 'install';

    // Environments live in the dashboard now. `--environment <list>` survives as an explicit opt-in
    // that only activates the project for those environments; nothing about them is written to config.
    let envs: string[];
    let environmentPinned: boolean;
    let env: string;
    if (isJoin) {
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
            exitWithError(2, `Unknown environment "${badEnv}". Valid values: ${ALL_ENVS.join(', ')}.`, json);
        }
        environmentPinned = envs.length > 0;
        if (envs.length === 0) envs = ['local'];
        // First in the canonical order, so `local,staging` and `staging,local` agree.
        env = ALL_ENVS.filter((e) => envs.includes(e))[0] ?? 'local';
    }

    const server = resolveServer() as string;

    // Refuse to run against a server that requires a newer CLI — same gate `apply`, `mcp` and
    // `doctor` apply, exit 5 as cli.ts documents. init is the first command anyone runs and the one
    // that writes files, so a contract mismatch must stop it before anything is written.
    try {
        const meta = await api<any>(server, '/api/meta');
        const minCli = meta?.minCliVersion || '0.0.0';
        if (compareSemver(BUILD_CLI_VERSION, minCli) < 0) {
            console.error(tooOldMessage(BUILD_CLI_VERSION, minCli));
            process.exit(5);
        }
    } catch (err: any) {
        if (isOutage(err)) throw err;
        // A server too old to have /api/meta cannot be declaring a minimum; anything else is
        // reported by the calls that follow.
    }

    const branding = await getBranding(server);
    const product = branding.productName;
    if (!json) console.log(bold(`${product} setup ${sym.dot} ${basename(cwd)}`));

    const flagTool = typeof options['tool'] === 'string' ? (options['tool'] as string) : undefined;

    if (dryRun) {
        const createName = typeof options['create'] === 'string' ? (options['create'] as string).trim() : '';
        const projectFlag = typeof options['project'] === 'string' ? (options['project'] as string).trim() : '';
        const planProject: InitPlan['project'] = createName
            ? { key: projectFlag || slugifyKey(createName), name: createName, create: true }
            : projectFlag || config.project
              ? { key: projectFlag || config.project, name: projectFlag || config.project, create: false }
              : null;
        const resolved = await resolveApiKey(cwd, server);
        const account: InitPlan['account'] =
            resolved.key && resolved.source ? { kind: 'found', source: resolved.source } : { kind: 'pending' };
        const tools = decideTools(await detectRepoTools(cwd), {
            flagTool,
            savedTool: config.aiTool,
            interactive: false,
        }).tools;
        const tool = tools[0];
        const { widget } = await decideWidget(cwd, options, config, { isJoin, wantEmbed, tool });
        const names = await readStackNames(cwd);
        const shared: InitPlan['shared'] =
            shareResult.share !== undefined
                ? { decided: true, share: shareResult.share, saved: false, ...names, aiTool: tool }
                : typeof config.shareStack === 'boolean'
                  ? { decided: true, share: config.shareStack, saved: true, ...names, aiTool: tool }
                  : interactive
                    ? { decided: false, share: true, saved: false, ...names, aiTool: tool }
                    : { decided: true, share: true, saved: false, ...names, aiTool: tool };
        const files = [
            '.pinsay/config.json',
            '.pinsay/stack.json',
            ...(account.kind === 'pending' && !saveGlobal ? ['.pinsay/credentials.env'] : []),
            ...(widget.kind === 'embed' ? widget.files : []),
            '.git/info/exclude (PinSay block)',
        ];
        const plan: InitPlan = {
            product,
            project: planProject,
            account,
            widget,
            skills: options['no-skills']
                ? []
                : tools.map((t) => ({
                      tool: t,
                      paths: skillFilesFor({ aiTool: t, skillsDir: t === tool ? (options['skills-dir'] as string) : undefined }),
                  })),
            files,
            shared,
            notes,
        };
        if (json) {
            console.log(JSON.stringify({ ok: true, dryRun: true, plan: planToJson(plan) }));
        } else {
            console.log('');
            for (const line of renderPlan(plan)) console.log(line);
            console.log('');
            console.log('Dry run: nothing was written or sent.');
        }
        process.exit(0);
    }

    const session = await signIn(server, cwd, {
        flagKey: options['key'] as string | true | undefined,
        interactive,
        noBrowser: options['no-browser'] === true,
        json,
        product,
    });
    if (!json) console.log(`${green(sym.check)} Signed in as ${session.me.displayName}`);
    const keySaved = keyPlacement(session, saveGlobal);

    // Multi-project join: the repo already has apps configured under `projects`; this is another
    // clone or machine. See `handleMultiJoin`.
    if (isJoin && configIsMulti) {
        const { share } = await decideShare(shareResult.share, config, interactive, product);
        await handleMultiJoin(cwd, config, server, product, json, options, session, share, keySaved);
        return;
    }

    const appInfo = await detectStack(cwd);

    // Nx monorepo, interactive: offer to set up more than one app as its own PinSay project.
    let nxApps: DiscoveredApp[] = [];
    if (!isJoin && !isAddProject && interactive) {
        if (await isNxWorkspace(cwd).catch(() => false)) {
            nxApps = await discoverNxApps(cwd).catch(() => []);
        }
    }

    if (isAddProject || nxApps.length > 0) {
        const { share } = await decideShare(shareResult.share, config, interactive, product);
        await handleMultiProjectSetup({
            cwd,
            config,
            options,
            server,
            session,
            json,
            interactive,
            product,
            pathFlag,
            nxApps,
            configIsMulti,
            share,
            keySaved,
            wantEmbed,
        });
        return;
    }

    // ---- Decisions (nothing is written or sent until "Go ahead?") ----
    const project: ProjectChoice = isJoin
        ? { key: config.project, name: config.project, create: false }
        : await chooseProject(server, session.token, session.me, {
              projectFlag: options['project'] as string | undefined,
              createFlag: options['create'] as string | undefined,
              interactive,
              json,
          });

    const { tool, tools } = await pickTools(cwd, options, config, interactive);
    const { share, saved: shareSaved } = await decideShare(shareResult.share, config, interactive, product);
    const { widget, embedPlan } = await decideWidget(cwd, options, config, { isJoin, wantEmbed, tool });
    const delivery: 'embed' | 'extension' = widget.kind === 'extension' ? 'extension' : 'embed';

    const names = await readStackNames(cwd);
    const stackMeta = { frontend: names.frontend, backend: names.backend, aiTool: tool };

    const noSkills = Boolean(options['no-skills']);
    const skills = noSkills
        ? []
        : tools.map((t) => ({
              tool: t,
              paths: skillFilesFor({ aiTool: t, skillsDir: t === tool ? (options['skills-dir'] as string) : undefined }),
          }));
    const files = [
        '.pinsay/config.json',
        '.pinsay/stack.json',
        ...(keySaved === 'repo' ? ['.pinsay/credentials.env'] : []),
        ...(widget.kind === 'embed' ? widget.files : []),
        '.git/info/exclude (PinSay block)',
    ];
    const plan: InitPlan = {
        product,
        project,
        account: {
            kind: 'signed-in',
            displayName: session.me.displayName,
            keySaved,
            existingSource:
                session.origin === 'env' || session.origin === 'repo' || session.origin === 'global' ? session.origin : undefined,
            globalPath: globalCredentialsPath(),
        },
        widget,
        skills,
        files,
        shared: { decided: true, share, saved: shareSaved, ...names, aiTool: tool },
        notes,
    };

    if (!json) {
        console.log('');
        for (const line of renderPlan(plan)) console.log(line);
        console.log('');
    }
    if (interactive && !(await confirm('Go ahead?', { defaultYes: true }))) {
        closePrompts();
        console.log('Cancelled. Nothing was written.');
        process.exit(0);
    }
    closePrompts();

    // ---- Execute ----
    const hasStackWork = !isJoin || !existsSync(join(cwd, '.pinsay/stack.json'));
    const stepLabels = [
        ...(keySaved !== 'existing' ? ['Saving your key'] : []),
        'Writing .pinsay/config.json',
        ...(noSkills ? [] : [`Installing skills for ${tools.join(', ')}`]),
        'Hiding PinSay files from git',
        ...(widget.kind === 'embed' ? ['Adding the widget to your code'] : []),
        ...(share ? ['Sharing framework names'] : []),
        'Quick check',
    ];
    const progress = createProgress(stepLabels.length, progressMode(json));

    await removeLegacyRepoFiles(cwd);
    await createProject(server, session.token, project, json);

    // `--environment`: activate the project for every environment named — additive, an environment
    // already active stays active and one not named is left alone.
    if (!isJoin && environmentPinned) {
        const projectRow = await api<any[]>(server, '/api/admin/projects', { token: session.token })
            .then((rows) => rows.find((p) => p.key === project.key))
            .catch(() => null);
        if (projectRow?.id) {
            const activation: Record<string, boolean> = {};
            if (envs.includes('local') && !projectRow.isActiveLocal) activation['isActiveLocal'] = true;
            if (envs.includes('staging') && !projectRow.isActiveStaging) activation['isActiveStaging'] = true;
            if (envs.includes('production') && !projectRow.isActiveProduction) activation['isActiveProduction'] = true;
            if (Object.keys(activation).length) {
                try {
                    await api(server, `/api/admin/projects/${projectRow.id}`, {
                        method: 'PATCH',
                        body: activation,
                        token: session.token,
                    });
                } catch (err: any) {
                    // A developer without project-edit rights can still install the widget; the
                    // environment stays inactive until an admin enables it. Never worth aborting for.
                    if (!json) {
                        console.error(
                            `Note: could not activate ${Object.keys(activation).length} environment(s) for this project ` +
                            `(${err?.message ?? err}). An admin can switch them on in the dashboard.`,
                        );
                    }
                }
            }
        }
    }

    const filesMod: string[] = [];
    const skillWarnings: SkillWarning[] = [];
    const skillHide: string[] = [];
    let injected = false;
    let htmlPath: string | undefined;

    if (keySaved !== 'existing') {
        progress.step('Saving your key');
        await saveKey(cwd, server, session, keySaved, project.key);
        if (keySaved === 'repo') filesMod.push('.pinsay/credentials.env');
    }

    progress.step('Writing .pinsay/config.json');
    await writeConfig(cwd, {
        project: project.key,
        aiTool: tool,
        skillsDir: options['skills-dir'] as string,
        cliVersion: BUILD_CLI_VERSION,
        delivery,
        shareStack: share,
    });
    filesMod.push('.pinsay/config.json');

    if (!noSkills) {
        progress.step(`Installing skills for ${tools.join(', ')}`);
        const installed: string[] = [];
        for (const t of tools) {
            try {
                // A --skills-dir override names a single directory, so it only applies to the primary tool.
                const r = await installSkills(server, t, cwd, t === tool ? (options['skills-dir'] as string) : undefined);
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
        filesMod.push(...installed);
    }

    progress.step('Hiding PinSay files from git');
    const hidden = await hidePinsayFiles(cwd, [...skillsDirExtra(options['skills-dir'] as string), ...skillHide]);

    if (widget.kind === 'embed' && embedPlan) {
        progress.step('Adding the widget to your code');
        const pin = await resolvePin(server, options['pin'] === true);
        const r = await runEmbed(cwd, embedPlan, { server, key: project.key, pin });
        htmlPath = r.htmlPath;
        injected = r.files.length > 0;
        filesMod.push(...r.files);
        if (htmlPath) await writeConfig(cwd, { htmlPath });
    }

    // --source-map: wire in the Vite plugin that stamps component hashes. Opt-in, because it edits
    // the user's build config — the most intrusive thing this CLI does.
    let sourceMapLine: { ok: boolean; text: string } | null = null;
    if (options['source-map']) {
        const res = await injectSourceMap(cwd);
        if (res.ok) {
            sourceMapLine = {
                ok: true,
                text: res.alreadyPresent ? 'source mapping already configured' : `source mapping enabled (${res.files.join(', ')})`,
            };
            filesMod.push(...res.files);
        } else {
            // Never fail the install for this: the widget works without it.
            sourceMapLine = { ok: false, text: `source mapping NOT enabled: ${res.reason}` };
        }
    }

    if (share) progress.step('Sharing framework names');

    if (hasStackWork) {
        const design = options['no-design'] ? null : await detectDesignTokens(cwd);
        let serverStack: any = null;
        let stackWarn = false;
        if (share) {
            try {
                // `token`, not `key`: /api/projects/{key}/stack is [Authorize] and expects the JWT.
                serverStack = await api(server, `/api/projects/${project.key}/stack`, {
                    method: 'POST',
                    body: buildRequestBody(stackMeta),
                    token: session.token,
                });
            } catch (e: any) {
                if (isOutage(e)) throw e;
                stackWarn = true;
            }
        }
        await writeStackFile(cwd, mergeStack(stackMeta, serverStack?.data ?? serverStack, design));
        if (stackWarn && !json) console.error(`${sym.warn} Stack not registered with ${product}.`);
    }

    if (share) {
        await postEvent(
            server,
            session.token,
            {
                type: 'installed',
                projectKey: project.key,
                meta: { stack: stackMeta, aiTool: tool, injected, cliVersion: BUILD_CLI_VERSION, mode },
            },
            cwd,
        );
    } else {
        await postSetupDone(server, session.token, project.key);
    }

    progress.step('Quick check');
    const checks = await runInitChecks(cwd, { server, project: project.key }, BUILD_CLI_VERSION);
    progress.done();

    let next: NextCase;
    if (isJoin) next = { kind: 'join' };
    else if (widget.kind === 'extension') next = { kind: 'extension', storeUrl: branding.extension.storeUrl };
    else if (widget.kind === 'embed-skill') next = { kind: 'skill', tool };
    else next = { kind: 'embedded' };

    if (json) {
        let appUrl = options['app-url'] as string | undefined;
        let source = '';
        if (!isJoin && !options['no-app-url'] && !appUrl) {
            const detected = await detectAppUrl(cwd, appInfo.kind, env);
            source = detected.source;
            appUrl = detected.url || undefined;
        }
        console.log(JSON.stringify({
            ok: true,
            mode,
            product,
            server,
            project: { key: project.key, name: project.name, created: project.create },
            // Only present when `--environment` was explicitly given.
            environment: environmentPinned ? env : undefined,
            delivery,
            extension: { storeUrl: branding.extension?.storeUrl || '', zipUrl: branding.extension?.zipUrl || '' },
            appUrl: appUrl || null,
            appUrlSource: source,
            aiTool: tool,
            stack: { kind: appInfo.kind, evidence: appInfo.evidence },
            injected,
            routedToSkill: widget.kind === 'embed-skill',
            files: filesMod,
            skillWarnings,
            hiddenFromGit: hidden.status,
            trackedPinsayFiles: hidden.tracked,
            checks,
            cliVersion: BUILD_CLI_VERSION,
            shareStack: share,
            keySaved,
            nextStep: nextStepText(next, product),
        }));
        process.exit(0);
    }

    if (sourceMapLine) {
        if (sourceMapLine.ok) console.log(`${green(sym.check)} ${sourceMapLine.text}`);
        else console.error(`${sym.warn} ${sourceMapLine.text}`);
    }
    for (const line of formatSkillWarnings(skillWarnings)) console.error(line);
    for (const line of formatHideWarnings(hidden)) console.error(line);
    for (const line of quickCheckLines(checks)) console.log(line);
    const shNote = pinsayShNote(cwd);
    if (shNote) console.log(dim(shNote));
    console.log('');
    for (const line of renderNext(nextStepText(next, product))) console.log(line);
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

/** The repo-level default `delivery` for a multi-project install: `--delivery`, then the saved one, then
 *  the extension unless the run asked for the widget in the code. Never asks. */
function resolveDeliveryDefault(
    options: Record<string, string | boolean>,
    config: any,
    wantEmbed: boolean,
): 'embed' | 'extension' {
    const deliveryFlag = options['delivery'] as string | undefined;
    if (deliveryFlag === 'extension' || deliveryFlag === 'embed') return deliveryFlag;
    if (config.delivery === 'embed' || config.delivery === 'extension') return config.delivery;
    return wantEmbed ? 'embed' : 'extension';
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
    session: Session;
    json: boolean;
    share: boolean;
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
    const { cwd, appDir, server, session } = ctx;
    const token = session.token;
    const targetCwd = join(cwd, appDir);
    const label = appLabel(appDir);

    const choice = await chooseProject(server, token, session.me, {
        projectFlag: ctx.presetKey,
        createFlag: ctx.presetCreate,
        interactive: ctx.interactive,
        json: ctx.json,
        label,
    });
    await createProject(server, token, choice, ctx.json);
    const { key, name } = choice;
    const created = choice.create;

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

    const delivery: 'embed' | 'extension' = ctx.presetDelivery ?? ctx.repoDefaultDelivery;

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
    if (ctx.share) {
        try {
            const body = buildRequestBody(stackMeta);
            serverStackResponse = await api(server, `/api/projects/${key}/stack`, { method: 'POST', body, token });
        } catch (e) {
            if (isOutage(e)) throw e;
        }
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
    session: Session,
    share: boolean,
    keySaved: KeySaved,
): Promise<never> {
    closePrompts();
    const token = session.token;
    await saveKey(cwd, server, session, keySaved);
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
        if (share) {
            try {
                const body = buildRequestBody(stackMeta);
                serverStackResponse = await api(server, `/api/projects/${p.key}/stack`, { method: 'POST', body, token });
            } catch (e) {
                if (isOutage(e)) throw e;
            }
        }
        const designBlock = await detectDesignTokens(appCwd, { root: cwd }).catch(() => null);
        const merged = mergeStack(stackMeta, serverStackResponse?.data ?? serverStackResponse, designBlock);
        await writeStackFile(cwd, merged, p.key);
    }

    await writeConfig(cwd, { cliVersion: BUILD_CLI_VERSION, shareStack: share });

    if (share) {
        await postEvent(server, token, { type: 'installed', projectKey: projects[0]?.key, meta: { mode: 'join', multiProject: true, cliVersion: BUILD_CLI_VERSION } }, cwd);
    } else {
        await postSetupDone(server, token, projects[0]?.key);
    }

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
✔ Joined ${product} (${projects.length} project${projects.length === 1 ? '' : 's'}) as ${session.me.displayName}
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
    session: Session;
    json: boolean;
    interactive: boolean;
    product: string;
    pathFlag?: string;
    nxApps: DiscoveredApp[];
    configIsMulti: boolean;
    share: boolean;
    /** Where this run's key goes; `existing` = it already resolves from env, the repo or the machine. */
    keySaved: KeySaved;
    wantEmbed: boolean;
}): Promise<never> {
    const { cwd, config, options, server, session, interactive, product, pathFlag, nxApps, configIsMulti, share, keySaved, wantEmbed } = args;
    const isJson = args.json;
    const token = session.token;

    await saveKey(cwd, server, session, keySaved);
    const { tool, tools } = await pickTools(cwd, options, config, interactive);
    const repoDefaultDelivery = resolveDeliveryDefault(options, config, wantEmbed);
    const pin = await resolvePin(server, options['pin'] === true);
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
        if (interactive) {
            console.log(`\n── ${appLabel(app.dir)} ──`);
        }
        const result = await setupOneProject({
            cwd,
            appDir: app.dir,
            server,
            session,
            json: isJson,
            share,
            presetKey: app.presetKey,
            presetCreate: app.presetCreate,
            presetEnvironments: app.presetEnvironments,
            repoDefaultDelivery,
            presetDelivery: app.presetDelivery,
            noDesign,
            noInject,
            explicitHtml: app.explicitHtml,
            pin,
            interactive,
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
        shareStack: share,
        projects: projectsMap,
    });

    if (share) {
        await postEvent(server, token, { type: 'installed', projectKey: results[0]?.key, meta: { mode: 'add-project', keys: results.map((r) => r.key), cliVersion: BUILD_CLI_VERSION } }, cwd);
    } else {
        await postSetupDone(server, token, results[0]?.key);
    }

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
