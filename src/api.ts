export class ApiError extends Error {
    constructor(public code: number, message: string) {
        super(message);
    }
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
        throw new ApiError(res.status, msg);
    }
    
    if (res.status === 204) return {} as T;
    
    const body = await res.json();
    return body.data !== undefined ? body.data : body;
}
