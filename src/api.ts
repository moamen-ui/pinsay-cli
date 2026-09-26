export class ApiError extends Error {
    constructor(public code: number, message: string) {
        super(message);
    }
}

export async function api<T>(server: string, path: string, options: { method?: string, body?: any, token?: string } = {}): Promise<T> {
    const url = `${server.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    if (options.body) headers['Content-Type'] = 'application/json';
    
    const res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    
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
