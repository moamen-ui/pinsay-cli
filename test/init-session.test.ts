import { test, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exchangeKey, signIn, InvalidKeyError, quickAccessMessage, noKeyMessage } from '../src/init/session.js';
import {
  chooseProject,
  createProject,
  sortProjects,
  slugifyKey,
  MEMBER_NO_PROJECT,
  MEMBER_CANNOT_CREATE,
  memberMissingProject,
} from '../src/init/project.js';
import { NetworkError } from '../src/api.js';

/** Stub: keys map to profiles; /api/admin/projects returns `projects`; POSTs are recorded. */
let server: http.Server;
let url: string;
let projects: Array<{ key: string; name: string }> = [];
const posts: string[] = [];
const profiles: Record<string, any> = {
  ptr_admin: { displayName: 'Ada', email: 'ada@x.dev', isAdmin: true, isQuickAccess: false },
  ptr_member: { displayName: 'Mo', email: 'mo@x.dev', isAdmin: false, isQuickAccess: false },
  ptr_quick: { displayName: 'Q', isAdmin: false, isQuickAccess: true },
};

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') posts.push(req.url!);
      if (req.url === '/api/auth/login-with-key') {
        const key = JSON.parse(body || '{}').apiKey;
        if (profiles[key]) {
          // `user` deliberately lacks the role flags: /api/auth/me must be the source of truth.
          res.end(JSON.stringify({ data: { status: 'ok', token: `jwt-${key}`, user: { displayName: 'from-login' } } }));
        } else {
          res.writeHead(401);
          res.end(JSON.stringify({ message: 'Invalid API key' }));
        }
      } else if (req.url === '/api/auth/me') {
        const key = String(req.headers.authorization ?? '').replace('Bearer jwt-', '');
        res.end(JSON.stringify({ data: profiles[key] }));
      } else if (req.url === '/api/admin/projects') {
        res.end(JSON.stringify(req.method === 'POST' ? { ok: true } : projects));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  url = `http://localhost:${(server.address() as import('net').AddressInfo).port}`;
});

after(() => server.close());

class Exit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

let errors: string[] = [];
const realExit = process.exit;
const realError = console.error;
const realLog = console.log;
let tmp: string;
let prevKey: string | undefined;
let prevConfigDir: string | undefined;

beforeEach(async () => {
  errors = [];
  posts.length = 0;
  (process as any).exit = (code: number) => {
    throw new Exit(code);
  };
  console.error = (...a: any[]) => void errors.push(a.join(' '));
  console.log = (...a: any[]) => void errors.push(a.join(' '));
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pinsay-session-'));
  prevKey = process.env.PINSAY_API_KEY;
  prevConfigDir = process.env.PINSAY_CONFIG_DIR;
  delete process.env.PINSAY_API_KEY;
  process.env.PINSAY_CONFIG_DIR = path.join(tmp, 'global');
});

afterEach(async () => {
  process.exit = realExit;
  console.error = realError;
  console.log = realLog;
  if (prevKey === undefined) delete process.env.PINSAY_API_KEY;
  else process.env.PINSAY_API_KEY = prevKey;
  if (prevConfigDir === undefined) delete process.env.PINSAY_CONFIG_DIR;
  else process.env.PINSAY_CONFIG_DIR = prevConfigDir;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function exitCode(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
  throw new Error('expected an exit');
}

const nonInteractive = { interactive: false, noBrowser: true, json: false, product: 'PinSay' };

test('exchangeKey reads isAdmin/isQuickAccess from /api/auth/me', async () => {
  const { token, me } = await exchangeKey(url, 'ptr_admin');
  assert.strictEqual(token, 'jwt-ptr_admin');
  assert.deepStrictEqual(me, { displayName: 'Ada', email: 'ada@x.dev', roleName: undefined, isAdmin: true, isQuickAccess: false });
});

test('exchangeKey: a rejected key is InvalidKeyError; an unreachable server is NOT', async () => {
  await assert.rejects(exchangeKey(url, 'ptr_nope'), InvalidKeyError);
  await assert.rejects(exchangeKey('http://127.0.0.1:9', 'ptr_admin'), NetworkError);
});

test('signIn: --key <value> wins and is not saved anywhere', async () => {
  const s = await signIn(url, tmp, { ...nonInteractive, flagKey: 'ptr_member' });
  assert.strictEqual(s.origin, 'flag');
  assert.strictEqual(s.me.isAdmin, false);
  assert.deepStrictEqual(await fs.readdir(tmp), [], 'nothing written');
});

test('signIn: a key from PINSAY_API_KEY is used silently (origin env)', async () => {
  process.env.PINSAY_API_KEY = 'ptr_admin';
  const s = await signIn(url, tmp, nonInteractive);
  assert.strictEqual(s.origin, 'env');
});

test('signIn: no key and no terminal exits 2 with the "No API key" line', async () => {
  assert.strictEqual(await exitCode(signIn(url, tmp, nonInteractive)), 2);
  assert.ok(errors.includes(noKeyMessage('PinSay')));
});

test('signIn: --key with no value and no terminal exits 2', async () => {
  assert.strictEqual(await exitCode(signIn(url, tmp, { ...nonInteractive, flagKey: true })), 2);
});

test('signIn: a rejected saved key without a terminal exits 3', async () => {
  process.env.PINSAY_API_KEY = 'ptr_revoked';
  assert.strictEqual(await exitCode(signIn(url, tmp, nonInteractive)), 3);
  assert.match(errors.join('\n'), /Your saved key no longer works/);
});

test('signIn: a quick-access account stops with exit 3 and the quick-access message', async () => {
  assert.strictEqual(await exitCode(signIn(url, tmp, { ...nonInteractive, flagKey: 'ptr_quick' })), 3);
  assert.ok(errors.includes(quickAccessMessage('PinSay')));
});

const admin = { displayName: 'Ada', isAdmin: true, isQuickAccess: false };
const member = { displayName: 'Mo', isAdmin: false, isQuickAccess: false };
const ni = { interactive: false, json: false };

test('chooseProject: --project that exists is used, for admins and members alike', async () => {
  projects = [{ key: 'my-app', name: 'My App' }];
  for (const me of [admin, member]) {
    assert.deepStrictEqual(await chooseProject(url, 't', me, { ...ni, projectFlag: 'my-app' }), { key: 'my-app', name: 'My App', create: false });
  }
});

test('chooseProject: --project missing → admin will create it; member exits 3', async () => {
  projects = [];
  assert.deepStrictEqual(await chooseProject(url, 't', admin, { ...ni, projectFlag: 'new-one' }), { key: 'new-one', name: 'new-one', create: true });
  assert.strictEqual(await exitCode(chooseProject(url, 't', member, { ...ni, projectFlag: 'new-one' })), 3);
  assert.ok(errors.includes(memberMissingProject('new-one')));
});

test('chooseProject: --create → admin gets a slug key; member exits 3 with the admin-only message', async () => {
  assert.deepStrictEqual(await chooseProject(url, 't', admin, { ...ni, createFlag: 'My Shop!' }), { key: 'my-shop', name: 'My Shop!', create: true });
  assert.strictEqual(await exitCode(chooseProject(url, 't', member, { ...ni, createFlag: 'X' })), 3);
  assert.ok(errors.includes(MEMBER_CANNOT_CREATE));
});

test('chooseProject: no flags and no terminal exits 2', async () => {
  projects = [{ key: 'a', name: 'A' }];
  assert.strictEqual(await exitCode(chooseProject(url, 't', admin, ni)), 2);
});

test('chooseProject never POSTs; createProject does, only when create is true', async () => {
  projects = [];
  const choice = await chooseProject(url, 't', admin, { ...ni, projectFlag: 'fresh' });
  assert.deepStrictEqual(posts, []);
  await createProject(url, 't', { ...choice, create: false }, false);
  assert.deepStrictEqual(posts, []);
  await createProject(url, 't', choice, false);
  assert.deepStrictEqual(posts, ['/api/admin/projects']);
});

test('member message texts are the SPEC wording', () => {
  assert.match(MEMBER_NO_PROJECT, /^You don't have a project yet\. Ask your workspace admin to create one, or copy the ready command from the widget \(profile menu → Connect your repo\)\.$/);
  assert.strictEqual(memberMissingProject('k'), 'Project "k" isn\'t in your workspace. Check the key, or ask your admin.');
  assert.strictEqual(slugifyKey('  Hello  World--App '), 'hello-world-app');
});

test('sortProjects: by name, case-insensitive, input untouched', () => {
  const input = [{ name: 'zeta' }, { name: 'Beta' }, { name: 'alpha' }];
  assert.deepStrictEqual(sortProjects(input).map((p) => p.name), ['alpha', 'Beta', 'zeta']);
  assert.deepStrictEqual(input.map((p) => p.name), ['zeta', 'Beta', 'alpha']);
});
