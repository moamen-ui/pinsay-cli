import { api, ApiError } from '../api.js';
import { ask, select } from '../prompt.js';
import { exitWithError } from '../errors.js';
import { sym } from '../ui/style.js';
import type { Profile } from './session.js';

/**
 * Which PinSay project this repo (or app) uses — SPEC B5. Lead-only: it is where the CLI enforces who may create
 * a project. "Their projects" for a member = what `GET /api/admin/projects` already returns for their workspace
 * (CEO answer 2); no extra filtering here.
 *
 * Deciding never writes or creates anything: `createProject` runs only after the plan is confirmed.
 */

export interface ProjectChoice {
  key: string;
  name: string;
  /** True when this run will create the project (admins only). */
  create: boolean;
}

export const MEMBER_NO_PROJECT =
  "You don't have a project yet. Ask your workspace admin to create one, or copy the ready command from the " +
  'widget (profile menu → Connect your repo).';
export const MEMBER_CANNOT_CREATE =
  'Only a workspace admin can create projects. Ask your admin to create it, or copy the ready command from the ' +
  'widget (profile menu → Connect your repo).';
export const CREATE_ROW_LABEL = 'Create a new project…';

export function memberMissingProject(key: string): string {
  return `Project "${key}" isn't in your workspace. Check the key, or ask your admin.`;
}

/** Same rule init has always used: lowercase, `[a-z0-9-]`, no leading/trailing/double dashes. */
export function slugifyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const KEY_RULE = (v: string) => (/^[a-z0-9-]+$/.test(v) ? undefined : 'Use lowercase letters, digits and dashes only.');

export interface ChooseProjectOptions {
  projectFlag?: string;
  createFlag?: string;
  interactive: boolean;
  json: boolean;
  /** Names the app in the question when one run asks more than once (Nx picker), e.g. `apps/web`. */
  label?: string;
}

async function listProjects(server: string, token: string): Promise<Array<{ key: string; name: string }>> {
  const rows = await api<any[]>(server, '/api/admin/projects', { token });
  return Array.isArray(rows) ? rows.map((p) => ({ key: String(p.key), name: String(p.name ?? p.key) })) : [];
}

export async function chooseProject(
  server: string,
  token: string,
  me: Profile,
  opts: ChooseProjectOptions,
): Promise<ProjectChoice> {
  const createFlag = typeof opts.createFlag === 'string' ? opts.createFlag.trim() : '';
  const projectFlag = typeof opts.projectFlag === 'string' ? opts.projectFlag.trim() : '';

  if (createFlag) {
    if (!me.isAdmin) exitWithError(3, MEMBER_CANNOT_CREATE, opts.json);
    return { key: projectFlag || slugifyKey(createFlag), name: createFlag, create: true };
  }

  const projects = await listProjects(server, token);

  if (projectFlag) {
    const found = projects.find((p) => p.key === projectFlag);
    if (found) return { key: found.key, name: found.name, create: false };
    if (!me.isAdmin) exitWithError(3, memberMissingProject(projectFlag), opts.json);
    return { key: projectFlag, name: projectFlag, create: true };
  }

  if (!opts.interactive) {
    exitWithError(2, 'Pass --project <key> (or --create <name>): there is no terminal to pick a project in.', opts.json);
  }

  if (projects.length === 0) {
    if (!me.isAdmin) exitWithError(3, MEMBER_NO_PROJECT, opts.json);
    return askNewProject();
  }

  const createRow = `${sym.plus} ${CREATE_ROW_LABEL}`;
  const rows = projects.map((p) => `${p.name}  (${p.key})`);
  const question = opts.label ? `Which PinSay project is ${opts.label}?` : 'Which project is this app?';
  const choice = await select(question, me.isAdmin ? [...rows, createRow] : rows);
  if (choice === createRow) return askNewProject();
  const picked = projects[rows.indexOf(choice)];
  return { key: picked.key, name: picked.name, create: false };
}

async function askNewProject(): Promise<ProjectChoice> {
  const name = (await ask('Project name', { validate: (v) => (v.trim() ? undefined : 'Type a name.') })).trim();
  const key = await ask('Project key', { default: slugifyKey(name), validate: KEY_RULE });
  return { key, name, create: true };
}

/** POSTs the project chosen above. Runs after "Go ahead?". Exit codes as before 0.9.0. */
export async function createProject(server: string, token: string, choice: ProjectChoice, json: boolean): Promise<void> {
  if (!choice.create) return;
  try {
    await api(server, '/api/admin/projects', { method: 'POST', body: { key: choice.key, name: choice.name }, token });
  } catch (err) {
    if (err instanceof ApiError && err.code === 409) {
      exitWithError(3, `A project with the key "${choice.key}" already exists. Choose another key.`, json);
    }
    if (err instanceof ApiError && err.code === 403) exitWithError(3, MEMBER_CANNOT_CREATE, json);
    if (err instanceof ApiError && err.code === 400) exitWithError(1, err.message, json);
    throw err;
  }
}
