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

export async function api<T>(server: string, path: string, options: { method?: string, body?: any, token?: string } = {}): Promise<T> {
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
