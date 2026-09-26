import { api } from './api.js';

export async function postEvent(server: string, token: string | undefined, payload: { type: string, projectKey?: string, meta?: any }): Promise<void> {
    if (!token) return; // If we don't have a token, we just skip it to not crash
    try {
        await api(server, '/api/events', { method: 'POST', body: payload, token });
    } catch (e) {
        // Events are best-effort in CLI
    }
}
