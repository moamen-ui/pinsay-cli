export class ApiError extends Error {
    /** `retryAfter`: seconds from the `Retry-After` header, set only on HTTP 429 when the server sent one. */
    constructor(public code: number, message: string, public retryAfter?: number) {
        super(message);
    }
}

/** `Retry-After` → seconds (≥ 1): integer seconds or an HTTP date; undefined when missing or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
    if (!value) return undefined;
    const v = value.trim();
    if (/^\d+$/.test(v)) return Math.max(1, parseInt(v, 10));
    const at = Date.parse(v);
    if (Number.isNaN(at)) return undefined;
    return Math.max(1, Math.ceil((at - now) / 1000));
}

/** fetch itself failed: DNS, connection refused, offline, or no answer within API_TIMEOUT_MS. */
export class NetworkError extends Error {
    constructor(public host: string, public cause?: unknown) {
        super(`Can't reach ${host}`);
        this.name = 'NetworkError';
    }
}
export const API_TIMEOUT_MS = 30_000;

/**
 * Tokens handed out by auth.ts `resolveToken`, each with how to get a fresh one. The server can end a session before
 * its JWT `exp` (a role change ends all of a person's sessions), so a 401 on such a token means "exchange the key
 * again", not "the key is bad". Used once per token.
 */
const renewers = new Map<string, () => Promise<string | undefined>>();
/** A renewed token -> its replacement (pending or done), so later calls that still hold the old token use the new one. */
const replaced = new Map<string, Promise<string | undefined>>();

export function registerRenewableToken(token: string, renew: () => Promise<string | undefined>): void {
    renewers.set(token, renew);
}

/** The token to send for `token`: the latest replacement after a renewal, else `token` itself. */
export async function currentToken(token: string | undefined): Promise<string | undefined> {
    let t = token;
    while (t && replaced.has(t)) {
        const next = await replaced.get(t)!.catch(() => undefined);
        if (!next || next === t) break;
        t = next;
    }
    return t;
}

/** One renewal per token, shared by concurrent callers. Undefined when `token` is not renewable or the key is bad. */
function renewToken(token: string): Promise<string | undefined> {
    let next = replaced.get(token);
    if (!next) {
        const renew = renewers.get(token);
        if (!renew) return Promise.resolve(undefined);
        renewers.delete(token);
        next = renew();
        replaced.set(token, next);
    }
    return next;
}

export async function api<T>(server: string, path: string, options: { method?: string, body?: any, token?: string } = {}): Promise<T> {
    const token = await currentToken(options.token);
    try {
        return await request<T>(server, path, { ...options, token });
    } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 401 || !token) throw err;
        // Outage or rate limit during the new exchange: that error wins over the 401.
        const fresh = await renewToken(token);
        if (!fresh || fresh === token) throw err;
        return request<T>(server, path, { ...options, token: fresh });
    }
}

async function request<T>(server: string, path: string, options: { method?: string, body?: any, token?: string } = {}): Promise<T> {
    const url = `${server.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    if (options.body) headers['Content-Type'] = 'application/json';
    
    let res: Response;
    try {
        res = await fetch(url, {
            method: options.method || 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: AbortSignal.timeout(API_TIMEOUT_MS)
        });
    } catch (err) {
        throw new NetworkError(new URL(url).host, err);
    }
    
    if (!res.ok) {
        let msg = res.statusText;
        try {
            const body = await res.json();
            if (body.message) msg = body.message;
        } catch {}
        throw new ApiError(res.status, msg, res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined);
    }
    
    if (res.status === 204) return {} as T;
    
    const body = await res.json();
    return body.data !== undefined ? body.data : body;
}
