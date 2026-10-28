import { ApiError, NetworkError } from './api.js';
export { NetworkError };

export const ISSUES_URL = 'https://github.com/moamen-ui/pinsay-cli/issues';

/** "Project <x> not found in workspace <name>." — the project key isn't in the signed-in key's workspace (or doesn't exist). */
export function projectNotFoundMessage(project: string, workspace?: string): string {
    const where = workspace ? `workspace ${workspace}` : 'this workspace';
    return (
        `Project "${project}" not found in ${where}. Sign in with an account in the project's workspace ` +
        '(npx pinsay-cli login), or fix the key in .pinsay/config.json.'
    );
}

/**
 * HTTP 404 on a project's comment queue. `code` is the MCP tool-error code (`mcp/server.ts` uses a string `code` as is);
 * `describeError` turns it into exit 3 (a key/workspace problem).
 */
export class ProjectNotFoundError extends Error {
    readonly code = 'not_found';
    constructor(public project: string, public workspace?: string) {
        super(projectNotFoundMessage(project, workspace));
        this.name = 'ProjectNotFoundError';
    }
}

/** True for failures that mean "PinSay can't be reached right now" — callers must rethrow these, never swallow. */
export function isOutage(err: unknown): boolean {
    return err instanceof NetworkError || (err instanceof ApiError && err.code >= 500);
}

/** HTTP 429: the server is throttling us. Temporary, like an outage: exit 4, never "invalid key". */
export function isRateLimited(err: unknown): err is ApiError {
    return err instanceof ApiError && err.code === 429;
}

/** "45 seconds" / "3 minutes" (minutes rounded up); "a minute" when the server sent no Retry-After. */
export function waitText(seconds?: number): string {
    if (seconds === undefined || !(seconds > 0)) return 'a minute';
    if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`;
    const minutes = Math.ceil(seconds / 60);
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * 2026-10-28 (signin-rate-limit part 2): the API's own sentence when it sends one (it says whether the caller's network
 * or account is out of requests, wait in minutes); otherwise a generic one with the wait.
 */
export function rateLimitMessage(retryAfter?: number, apiMessage?: string): string {
    if (apiMessage && /^(There are too many requests|Too many requests from your account)/.test(apiMessage)) return apiMessage;
    return `There are too many requests right now. Try again in ${waitText(retryAfter)}.`;
}

function hostOf(server?: string): string {
    try { return server ? new URL(server).host : 'the server'; } catch { return server ?? 'the server'; }
}

/** One sentence + fix, and the exit code, for any error that reached the top. White-label: no product name. */
export function describeError(err: unknown, server?: string): { code: number; message: string } {
    if (err instanceof ProjectNotFoundError) return { code: 3, message: err.message };
    if (err instanceof NetworkError) {
        return { code: 4, message: `Can't reach ${err.host}. Check your internet connection and try again.` };
    }
    if (err instanceof ApiError) {
        if (err.code === 429) return { code: 4, message: rateLimitMessage(err.retryAfter, err.message) };
        if (err.code >= 500) return { code: 4, message: `${hostOf(server)} is having trouble right now (HTTP ${err.code}). Try again in a minute.` };
        if (err.code === 401) return { code: 3, message: 'Your saved key no longer works (expired or revoked). Sign in again: npx pinsay-cli login' };
        if (err.code === 403) return { code: 3, message: "Your account isn't allowed to do this. A workspace admin can." };
        if (err.code === 423) return { code: 2, message: 'This workspace is paused. Ask its admin to resume it in the dashboard.' };
    }
    return { code: 1, message: `Something went wrong in pinsay-cli. Run again with PINSAY_DEBUG=1 and report it: ${ISSUES_URL}` };
}

/** Prints the error the user-friendly way and exits. `json` → the error object on stdout instead. */
export function exitWithError(code: number, message: string, json: boolean): never {
    if (json) console.log(JSON.stringify({ ok: false, error: { code, message } }));
    else console.error(message);
    process.exit(code);
}

export function reportFatal(err: unknown, opts: { json: boolean; server?: string }): never {
    if (process.env.PINSAY_DEBUG === '1') console.error(err instanceof Error ? err.stack ?? err.message : err);
    const { code, message } = describeError(err, opts.server);
    exitWithError(code, message, opts.json);
}
