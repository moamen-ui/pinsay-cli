import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot, readConfig, writeConfig, writeConfigFull, isMultiProject, type PinSayConfig } from '../config.js';
import { resolveServer } from '../server.js';
import { exitWithError } from '../errors.js';
import { api } from '../api.js';
import { SKILL_FILES } from '../skills.js';
import { accent, green, sym } from '../ui/style.js';
import { isInteractive } from '../ui/interactive.js';
import { confirm, select, closePrompts, CANCELLED_MESSAGE } from '../prompt.js';
import { planEmbed, runEmbed, resolvePin } from '../embed/embed.js';

/** Puts the widget into the app's code (or says how the AI tool does it); never needs a sign-in. */
export async function embedCommand(cwd: string, options: Record<string, string | boolean>): Promise<void> {
    const json = options['json'] === true;
    const root = await findRepoRoot(cwd);
    const config: PinSayConfig = await readConfig(root);
    const server = resolveServer();
    const multi = isMultiProject(config);

    let project: string | undefined;
    let appDir = '.';
    let recordedHtml: string | undefined;

    if (typeof options['project'] === 'string') {
        project = options['project'];
    } else if (multi) {
        const entries = config.projects!;
        const keys = Object.keys(entries);
        const pathFlag = typeof options['path'] === 'string'
            ? String(options['path']).replace(/^\.\/+/, '').replace(/\/+$/, '')
            : undefined;
        if (pathFlag) {
            project = keys.find((k) => entries[k].path === pathFlag);
        } else if (isInteractive(options)) {
            project = await select('Which app should get the widget?', keys);
        } else {
            exitWithError(
                2,
                `Several apps are set up here. Pass --path <app> (one of: ${keys.map((k) => entries[k].path).join(', ')}).`,
                json,
            );
        }
        if (project) {
            appDir = entries[project].path;
            recordedHtml = entries[project].htmlPath;
        }
    } else {
        project = config.project;
        recordedHtml = config.htmlPath;
    }

    if (!project) {
        exitWithError(2, 'No project in this folder yet. Run: npx pinsay-cli init --embed', json);
    }

    const plan = await planEmbed(root, {
        appDir,
        html: typeof options['html'] === 'string' ? options['html'] : undefined,
        recordedHtml,
    });

    const widgetLine =
        plan.kind === 'inject' ? `Embedded in your code: ${plan.files.join(', ')}` :
        plan.kind === 'skill' ? 'Your AI tool adds it (this stack has no single file to inject into)' :
        `Already in your code (${plan.htmlPath})`;
    if (!json) {
        console.log(accent("  Here's the plan"));
        console.log(`  Widget    ${widgetLine}`);
    }

    if (options['dry-run'] === true) {
        if (json) {
            console.log(JSON.stringify({
                ok: true, dryRun: true,
                plan: { project, delivery: 'embed', kind: plan.kind, files: plan.files },
            }));
        } else {
            console.log('Dry run: nothing was written or sent.');
        }
        return;
    }

    const saveConfig = async (htmlPath?: string): Promise<void> => {
        if (multi && !options['project']) {
            const entry = config.projects![project!];
            entry.delivery = 'embed';
            if (htmlPath !== undefined) entry.htmlPath = htmlPath;
            await writeConfigFull(root, config);
        } else {
            await writeConfig(root, { delivery: 'embed', ...(htmlPath !== undefined ? { htmlPath } : {}) });
        }
    };
    const finish = (message: string, extra: { files: string[]; htmlPath?: string; nextStep: string }): void => {
        if (json) console.log(JSON.stringify({ ok: true, project, delivery: 'embed', kind: plan.kind, ...extra }));
        else console.log(message);
    };

    if (plan.kind === 'already') {
        await saveConfig(plan.htmlPath);
        finish(`The widget is already in your code (${plan.htmlPath}). Nothing to change.`, {
            files: [], htmlPath: plan.htmlPath, nextStep: 'Nothing to change.',
        });
        return;
    }

    if (plan.kind === 'skill') {
        await saveConfig();
        const tool = config.aiTool ?? 'your AI tool';
        const nextStep = `Next: in ${tool}, run /pinsay-init to add the widget.`;
        const skillFile = SKILL_FILES[config.aiTool ?? 'other']?.[0];
        const missing = !skillFile || !existsSync(join(root, skillFile));
        if (!json && missing) console.log('Run npx pinsay-cli update first to install the skills.');
        finish(nextStep, { files: [], nextStep });
        return;
    }

    if (isInteractive(options)) {
        const go = await confirm('Go ahead?', { defaultYes: true });
        closePrompts();
        if (!go) {
            if (json) console.log(JSON.stringify({ ok: true, cancelled: true }));
            else console.log(CANCELLED_MESSAGE);
            process.exit(0);
        }
    }

    const pin = await resolvePin(server, options['pin'] === true);
    const result = await runEmbed(root, plan, { server, key: project, pin });
    await saveConfig(result.htmlPath);

    let product = 'feedback';
    try {
        const branding = await api<{ productName?: string }>(server, '/api/branding');
        if (branding?.productName) product = branding.productName;
    } catch {
        /* best effort: the word "feedback" is fine */
    }
    const nextStep = `Next: start your app and click the ${product} button.`;
    finish(`${green(sym.check)} Widget added: ${result.files.join(', ')}\n${accent(nextStep)}`, {
        files: result.files, htmlPath: result.htmlPath, nextStep,
    });
    closePrompts();
    process.exit(0);
}
