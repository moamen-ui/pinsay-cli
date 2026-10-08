import { api } from './api.js';
import { shareAllowed } from './consent.js';

/**
 * A usage event (installed, doctor_run, apply_started, first_apply, apply_failed). Best-effort, and only when the
 * repo at `cwd` shares (see consent.ts) — the same answer that controls the stack registration.
 */
export async function postEvent(
  server: string,
  token: string | undefined,
  payload: { type: string; projectKey?: string; meta?: any },
  cwd: string,
): Promise<void> {
  if (!token) return;
  if (!(await shareAllowed(cwd))) return;
  try {
    await api(server, '/api/events', { method: 'POST', body: payload, token });
  } catch {
    // Events are best-effort.
  }
}

/** The bare "setup done" signal init sends when the user said No: no names, no tool, no meta (CEO, 2026-10-08). */
export async function postSetupDone(server: string, token: string | undefined, projectKey?: string): Promise<void> {
  if (!token) return;
  try {
    await api(server, '/api/events', { method: 'POST', body: { type: 'installed', projectKey }, token });
  } catch {
    // best-effort
  }
}
