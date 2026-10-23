// Relay server: serves the app, runs agent sessions, and exposes the API used by the page and by agents.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';
import { db, load, changed, bus, pruneSpaces } from './lib/store.mjs';
import * as S from './lib/sessions.mjs';
import * as G from './lib/git.mjs';
import { mcpTools, handleMcp } from './lib/mcp.mjs';
import * as TN from './lib/tasknotes.mjs';
import * as A from './lib/artifacts.mjs';
import * as T from './lib/team.mjs';
import * as U from './lib/update.mjs';
import * as US from './lib/usage.mjs';

const DIR = import.meta.dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
};
const VENDOR = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js',
  'addon-serialize.js': '@xterm/addon-serialize/lib/addon-serialize.js',
};
const STATUSES = ['todo', 'doing', 'review', 'done'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan'];
const SKIP_IN_TREE = new Set(['.git', 'node_modules', '.DS_Store', '.agent-desk']);

let TOKEN = '';
let COOKIE = '';
let LOCAL = new Set();
let VOICE_HELPER = null;
let voice = null;

// ---------- Security ----------
// Every request passes two checks.
// 1. Host and Origin must be this server. Any website you visit can try to reach localhost, and this
//    server hands out shells. Checking Host also stops DNS rebinding.
// 2. It carries a secret. Other programs and other users on this Mac can reach the port too. The master
//    token (a cookie for the page, a header for the server's own calls and your own Claude Code) opens
//    everything. Each agent gets its own token instead, which opens only what its tools and hooks need.
function sameSite(req) {
  if (!LOCAL.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || LOCAL.has(origin.replace(/^https?:\/\//, ''));
}

const AGENT_ROUTES = new Set(['POST /mcp', 'POST /api/claude-session', 'POST /api/touched', 'POST /api/context', 'POST /api/news', 'POST /api/turn-ended']);
// { kind: 'ui' } for the master token, { kind: 'agent', session } for an agent's token on one of
// AGENT_ROUTES (header only, never a cookie or ?t=), otherwise null: anywhere else an agent token counts for nothing.
function auth(req, url) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
  const header = String(req.headers['x-desk-token'] || '');
  const given = Buffer.from(header || String(cookies[COOKIE] || url.searchParams.get('t') || ''));
  const want = Buffer.from(TOKEN);
  if (want.length >= 32 && given.length === want.length && timingSafeEqual(given, want)) return { kind: 'ui' };
  const session = header && AGENT_ROUTES.has(`${req.method} ${url.pathname}`) && S.sessionForToken(header);
  return session ? { kind: 'agent', session } : null;
}

// ---------- Helpers ----------
const fail = (status, message) => Object.assign(new Error(message), { status });
const expand = p => path.resolve(String(p || '').trim().replace(/^~(?=$|\/)/, os.homedir()));
const isDir = p => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const findTask = id => db.tasks.find(t => t.id === id) ?? (() => { throw fail(404, 'No such task'); })();
const findSession = id => S.sessions.get(id) ?? (() => { throw fail(404, 'No such session'); })();
// x-desk-session is only trusted alongside the master token (the server's own calls from mcp(), or you).
// An agent's own token names its session, whatever header it sends.
const caller = req => (req.auth?.kind === 'agent' ? req.auth.session : S.sessions.get(req.headers['x-desk-session']));
const visibleSessions = req => { // an agent sees only its own project's sessions (see sameProject)
  const all = [...S.sessions.values()];
  if (!fromAgent(req)) return all;
  const from = caller(req) ?? (() => { throw fail(403, 'Only agents inside Relay can reach other agents'); })();
  return all.filter(s => s.project === from.project);
};
const starter = req => (s => s && { id: s.id, name: s.name })(caller(req)); // the agent asking, if it's one of ours
// Requests an agent makes through its tools. They may not change settings or add or remove specialists, and
// may only start agents or edit a specialist while Settings allows it. (An agent runs as you and could reach the API some other way; this keeps
// the tools, the way agents actually work, inside the lines you set.)
const fromAgent = req => req.auth?.kind === 'agent' || req.headers['x-desk-via'] === 'mcp' || Boolean(req.headers['x-desk-session']);
const DEBUG = process.env.RELAY_DEBUG === '1'; // the "Relay Debug" early-access app (updates from its own repo, see lib/update.mjs)
const notFromAgent = (req, what) => { if (fromAgent(req)) throw fail(403, `Agents can't ${what}. Ask the user to do it in Relay.`); };
const mayStartAgents = req => {
  if (fromAgent(req) && db.settings.agentsCanSpawn === false) throw fail(403, 'Starting other agents is turned off in Relay settings.');
};
const mayMessage = req => {
  if (fromAgent(req) && db.settings.agentsCanMessage === false) throw fail(403, 'Agents messaging each other is turned off in Relay settings.');
};
const projectFor = (req, value) => {
  const project = value ? expand(value) : caller(req)?.project || db.settings.lastProject;
  if (!project) throw fail(400, 'No project selected');
  return project;
};

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(fail(413, 'Request is too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(fail(400, 'Request body is not JSON')); }
    });
  });
}

function writeAtomic(file, content) {
  fs.writeFileSync(`${file}.desk-tmp`, content);
  fs.renameSync(`${file}.desk-tmp`, file);
}

// ---------- Routes ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, key) => (keys.push(key), '([^/]+)'))}$`);
  routes.push({ method, re, keys, handler });
}

route('GET', '/api/info', () => ({
  url: S.serverUrl(), token: TOKEN, mcpUrl: `${S.serverUrl()}/mcp`,
  electron: Boolean(process.versions.electron), voice: Boolean(VOICE_HELPER), home: os.homedir(), version: U.current(), debug: DEBUG,
}));

// Projects
route('GET', '/api/projects', () => db.projects);
route('POST', '/api/projects', ({ body }) => {
  const dir = expand(body.path);
  if (!isDir(dir)) throw fail(400, `Not a folder: ${dir}`);
  if (!db.projects.some(p => p.path === dir)) db.projects.push({ path: dir, name: path.basename(dir) || dir, addedAt: Date.now() });
  db.settings.lastProject = dir;
  changed('projects');
  changed('settings');
  return db.projects.find(p => p.path === dir);
});
route('DELETE', '/api/projects', ({ query }) => {
  db.projects = db.projects.filter(p => p.path !== query.get('path'));
  pruneSpaces(db);
  if (db.settings.lastProject === query.get('path')) db.settings.lastProject = db.projects[0]?.path ?? '';
  changed('projects');
  changed('settings');
  return {};
});

// Settings
route('GET', '/api/settings', () => db.settings);
route('PATCH', '/api/settings', ({ req, body }) => {
  notFromAgent(req, 'change Relay\'s settings');
  for (const [key, value] of Object.entries(body)) {
    if (!(key in db.settings)) continue;
    if (['agentsCanSpawn', 'agentsCanMessage', 'agentsCanEditTeam', 'agentsAutonomous', 'fancyCursor', 'worktreeByDefault', 'sidebarHidden', 'agentsAware', 'spacesCanAsk', 'autoUpdate'].includes(key) && typeof value !== 'boolean') throw fail(400, `${key} is true or false`);
    if (key === 'artifactEditModel' && !EDIT_MODELS.includes(value)) throw fail(400, `The edit model is one of ${EDIT_MODELS.join(', ')}`);
    if (key === 'scrollSpeed' && !(Number(value) >= 0.25 && Number(value) <= 4)) throw fail(400, 'Scroll speed is between 0.25 and 4');
    if (key === 'agentDefaults') {
      const ok = ['claude', 'lead'].every(k => T.MODELS.includes(value?.[k]?.model) && T.EFFORTS.includes(value?.[k]?.effort));
      if (!ok) throw fail(400, 'Each default needs a known model and effort');
    }
    if (key === 'permissionMode' && !PERMISSION_MODES.includes(value)) throw fail(400, 'Unknown permission mode');
    if (key === 'leadUpkeep') {
      const { on, compactAt, replaceAfter, windowCap } = value ?? {};
      const within = (n, low, high) => Number.isInteger(n) && n >= low && n <= high;
      if (typeof on !== 'boolean' || !within(compactAt, 50, 95) || !within(replaceAfter, 1, 10) || !within(windowCap, 50_000, 2_000_000)) {
        throw fail(400, 'Lead upkeep is on or off, compacts at 50 to 95% of a 50,000 to 2,000,000-token window and replaces after 1 to 10 compactions');
      }
    }
    if (key === 'openSpaces' && !(Array.isArray(value) && value.every(p => typeof p === 'string'))) throw fail(400, 'openSpaces is a list of project folder paths');
    if (key === 'browserPanes') {
      const ok = value && typeof value === 'object' && Object.values(value).every(list => Array.isArray(list)
        && list.every(b => typeof b?.id === 'string' && /^https?:\/\//i.test(String(b.url))));
      if (!ok) throw fail(400, 'Browser panes can only open http and https pages');
    }
    db.settings[key] = value;
  }
  pruneSpaces(db);
  // Open Claude Code panes repaint in the new colours (see claudeTheme in lib/sessions.mjs).
  if ('theme' in body || 'accent' in body) {
    try { S.writeClaudeTheme(); } catch (e) { console.error("Couldn't update Claude Code's Relay theme:", e.message); }
  }
  changed('settings');
  return db.settings;
});

// Sessions
route('GET', '/api/agents', () => S.availableAgents());
route('GET', '/api/sessions', ({ req }) => visibleSessions(req).map(S.info));
route('POST', '/api/sessions', async ({ req, body }) => {
  const { kind = 'agent', agent = db.settings.defaultAgent, prompt = '', name, worktree = false, role: asked = null, specialist = null, model = '', effort = '' } = body;
  if (kind === 'agent') mayStartAgents(req);
  if (asked === 'lead' && fromAgent(req) && caller(req)?.role !== 'lead') throw fail(403, 'Only a lead agent can start another lead.');
  const role = asked;
  const project = projectFor(req, body.project);
  if (!isDir(project)) throw fail(400, `Not a folder: ${project}`);
  return S.info(await S.createSession({ project, kind, agent, prompt, name, worktree, role, specialist, model, effort, startedBy: starter(req) }));
});
route('DELETE', '/api/sessions/:id', ({ req, params }) => (S.stop(noShell(req, sameProject(req, params.id), 'stop')), {}));

// Claude's SessionStart hook reports the conversation id a pane is on (it changes on /clear).
route('POST', '/api/claude-session', ({ req, body }) => {
  const s = caller(req);
  if (!s) throw fail(404, 'Unknown session');
  S.noteClaudeSession(s, body.session_id);
  return {};
});

// Claude's status line reports its context window's size (see statusLine in lib/sessions.mjs), for lead upkeep,
// and that a reply came in, for the pane meter.
route('POST', '/api/context', ({ req, body }) => {
  const s = caller(req);
  if (!s) throw fail(404, 'Unknown session');
  const size = Number(body.context_window?.context_window_size);
  if (size >= 10_000 && size <= 100_000_000) s.contextWindow = size;
  S.meterSoon(s);
  return {};
});

// Claude's PostToolUse hook reports each file an agent edits. The repo it's in becomes a project (you stay on yours),
// a worktree the agent made itself is recorded for Review, and the agent's project remembers the repo.
route('POST', '/api/touched', async ({ req, body }) => {
  const from = caller(req);
  const input = body.tool_input ?? {};
  const file = String(input.file_path ?? input.notebook_path ?? '');
  S.noteTouched(from, file);
  const where = await G.touched(file, from);
  if (where?.added) changed('tasks');
  if (!where || (from && `${from.project}/`.startsWith(`${where.main}/`))) return {}; // the agent's own project already covers it
  let added = false;
  if (!db.projects.some(p => p.path === where.main)) {
    db.projects.push({ path: where.main, name: path.basename(where.main), addedAt: Date.now() });
    added = true;
  }
  const mine = from && db.projects.find(p => p.path === from.project);
  if (mine && !mine.repos?.includes(where.main)) {
    (mine.repos ??= []).push(where.main);
    added = true;
  }
  if (added) changed('projects');
  return {};
});

// Claude's UserPromptSubmit hook: what other agents did since this one's last turn, as context for it (see news
// in lib/sessions.mjs). Nothing at all when nothing changed, so a quiet turn costs no tokens.
route('POST', '/api/news', ({ req }) => {
  const s = caller(req);
  if (!s) throw fail(404, 'Unknown session');
  const text = S.news(s);
  return { raw: text ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }) : '', type: 'application/json' };
});

// Claude's Stop hook: a turn is done. A worker another agent started reports to it, then closes (see turnEnded).
route('POST', '/api/turn-ended', ({ req, body }) => {
  const s = caller(req);
  if (!s) throw fail(404, 'Unknown session');
  S.turnEnded(s, body.last_assistant_message);
  return {};
});

// Chats: agent conversations kept after their pane closes or the app quits, so they can be opened again
const findChat = id => db.chats.find(c => c.id === id) ?? (() => { throw fail(404, 'No such chat'); })();
route('GET', '/api/chats', ({ req, query }) => {
  const project = fromAgent(req) ? (caller(req) ?? (() => { throw fail(403, 'Only agents inside Relay can reach other agents'); })()).project
    : query.get('project') ? expand(query.get('project')) : null; // an agent sees only its own project's chats
  return db.chats.filter(c => !project || c.project === project).map(S.chatInfo).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
});
async function reopen(chat, prompt = '') {
  const s = await S.createSession({ chatId: chat.id, prompt });
  const task = chat.taskId && db.tasks.find(t => t.id === chat.taskId);
  if (task) {
    task.sessionId = s.id;
    changed('tasks');
  }
  return s;
}
route('POST', '/api/chats/:id/open', async ({ params }) => {
  const chat = findChat(params.id);
  const mine = S.chatSessions(chat.id);
  const live = mine.find(s => !s.exited);
  if (live) return { session: S.info(live), replaced: null };
  const done = mine.find(s => s.exited); // a finished pane for this chat gives way to the reopened one
  if (done) S.stop(done);
  const s = await reopen(chat);
  return { session: S.info(s), replaced: done?.id ?? null };
});
// Naming a chat names its agent too: other agents reach it by that name ("ask Adam").
route('PATCH', '/api/chats/:id', ({ req, params, body }) => {
  notFromAgent(req, 'rename agents');
  const chat = findChat(params.id);
  const title = String(body.title ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120);
  chat.title = title || null; // empty goes back to Claude's own title
  if (title) {
    chat.name = title;
    for (const s of S.chatSessions(chat.id)) s.name = title;
    changed('sessions');
  }
  changed('chats');
  return S.chatInfo(chat);
});
route('DELETE', '/api/chats/:id', ({ params }) => {
  const chat = findChat(params.id);
  for (const s of S.chatSessions(chat.id)) S.stop(s);
  db.chats = db.chats.filter(c => c.id !== chat.id); // Claude's own copy of the conversation is left alone
  changed('chats');
  return {};
});
// An agent sees, reads, copies, stops or types into only agents in its own project, and never shells; you can do
// any of them for any session.
const sameProject = (req, id) => {
  const s = findSession(id);
  const from = caller(req);
  if (fromAgent(req) && !from) throw fail(403, 'Only agents inside Relay can reach other agents');
  if (from && s.project !== from.project) throw fail(403, 'Agents can only reach agents in their own project');
  return s;
};
const noShell = (req, s, what) => {
  if (fromAgent(req) && s.kind === 'shell') throw fail(403, `Agents can't ${what} shell panes; ask the user`);
  return s;
};
route('GET', '/api/chats/:id/chat', ({ req, params, query }) => { // a closed pane's conversation, same project only
  const chat = findChat(params.id);
  const from = caller(req);
  if (fromAgent(req) && !from) throw fail(403, 'Only agents inside Relay can reach other agents');
  if (from && chat.project !== from.project) throw fail(403, 'Agents can only reach agents in their own project');
  return S.chatConversation(chat, Math.min(Number(query.get('last')) || 30, 200));
});
route('GET', '/api/sessions/:id/chat', ({ req, params, query }) => S.conversation(sameProject(req, params.id), Math.min(Number(query.get('last')) || 30, 200)));
route('GET', '/api/sessions/:id/transcript', ({ req, params, query }) => { // a Claude pane's chat view, read on from ?after=
  const s = sameProject(req, params.id);
  if (s.kind !== 'agent' || s.agent !== 'claude') throw fail(400, 'Only Claude panes have a chat view');
  return S.chatFeed(s, query.get('sid') || null, Math.max(0, Number(query.get('after')) || 0));
});
route('POST', '/api/sessions/:id/clone', async ({ req, params, body }) => {
  mayStartAgents(req);
  const src = sameProject(req, params.id);
  return S.info(await S.clone(src, { prompt: String(body.prompt ?? ''), name: body.name ? String(body.name).slice(0, 60) : undefined, startedBy: starter(req) }));
});
route('GET', '/api/sessions/:id/output', ({ req, params, query }) =>
  ({ text: S.screenText(noShell(req, sameProject(req, params.id), 'read'), Number(query.get('lines')) || 60) }));
// You type anything into any pane. An agent (send_to_agent) gets a message's checks and limit: plain text, into an
// agent in its own project, never a shell or a permission prompt.
route('POST', '/api/sessions/:id/input', async ({ req, params, body }) => {
  const text = String(body.text ?? '');
  if (!fromAgent(req)) return (S.send(findSession(params.id), text, body.submit !== false), {});
  mayMessage(req);
  const from = caller(req);
  const closed = from && !S.sessions.has(params.id) && closedWorker(from.project, params.id);
  let target = closed ? null : sameProject(req, params.id);
  if (target?.id === from.id) throw fail(400, "An agent can't type into itself");
  const recent = recentMessages(from.project);
  if (target) S.deliver(target, S.sign(from, text));
  else target = await wake(closed, S.sign(from, text));
  if (from.startedBy?.id === target.id) from.told = true; // it told its starter itself, so its turn's report isn't sent too
  sent.set(from.project, [...recent, Date.now()]);
  bus.emit('event', { type: 'agent-message', from: from.name, to: target.name, ...logMessage(from.project, from, target, 'send_to_agent') });
  return {};
});

// Tasks
route('GET', '/api/tasks', ({ req, query }) => {
  const project = query.get('project') ? expand(query.get('project')) : caller(req)?.project;
  return project ? db.tasks.filter(t => t.project === project) : db.tasks;
});
function addTask(req, body) {
  if (!String(body.title || '').trim()) throw fail(400, 'A task needs a title');
  const task = {
    id: randomUUID().slice(0, 8), project: projectFor(req, body.project), title: body.title.trim(),
    description: String(body.description || '').trim(), status: STATUSES.includes(body.status) ? body.status : 'todo',
    agent: body.agent || db.settings.defaultAgent, worktree: body.worktree ?? db.settings.worktreeByDefault,
    sessionId: null, branch: null, worktreePath: null, notes: [], createdBy: caller(req)?.name || 'You', createdAt: Date.now(), updatedAt: Date.now(),
    tasknotes: body.tasknotes ?? null,
  };
  db.tasks.push(task);
  changed('tasks');
  return task;
}
route('POST', '/api/tasks', ({ req, body }) => addTask(req, { ...body, tasknotes: null }));

// Agents talking to each other: a message goes to a running agent by name or id, typed into its terminal and
// signed with who sent it. If no one by that name is running but they're on the team, one starts with it.
const sent = new Map(); // project -> times of its recent messages, to stop agents chatting forever
// Counted against the project that receives it, so neither a new agent nor a different project resets it.
// The caller adds its own time once the message is through.
function recentMessages(project) {
  const recent = (sent.get(project) ?? []).filter(t => Date.now() - t < 10 * 60_000);
  if (recent.length >= 20) throw fail(429, 'That is 20 messages between agents in 10 minutes. Check with the user before sending more.');
  return recent;
}
// Who messaged whom, when and how (never what), for the Graph's edges. The last 500 are kept.
const spaceName = project => S.plain(path.basename(project));
function logMessage(project, from, to, via) {
  const entry = { at: Date.now(), project, fromId: from?.id ?? null, fromName: from?.name ?? 'An agent', toId: to.id, toName: to.name, via };
  db.messages = [...db.messages, entry].slice(-500);
  // A space's question or answer is told as one, with where it came from, never what it said.
  const where = from && from.project !== project ? ` (in ${spaceName(from.project)})` : '';
  const what = { ask_space: `asked ${S.plain(to.name)} a question`, answer_space: `answered ${S.plain(to.name)}'s question` }[via] ?? `messaged ${S.plain(to.name)}`;
  S.note(project, from?.id ?? null, 'messages between agents', `${S.plain(entry.fromName)}${where} ${what}`);
  changed('messages');
  return entry;
}
// A worker Relay closed once its turn was done (S.turnEnded) still answers to its old id and its name: a message
// opens its chat again, as its first message (or reaches it, if it's open again already).
const closedWorker = (project, to) => db.chats.find(c => c.autoClosed && c.project === project && (c.autoClosed === to || c.name.toLowerCase() === to.toLowerCase()));
async function wake(chat, signed) {
  const live = S.chatSessions(chat.id).find(s => !s.exited);
  if (live) return (S.deliver(live, signed), live);
  for (const s of S.chatSessions(chat.id)) S.stop(s); // a finished pane gives way
  return reopen(chat, signed);
}
route('POST', '/api/messages', async ({ req, body }) => {
  mayMessage(req);
  const from = caller(req);
  const text = String(body.text ?? '').trim();
  const to = String(body.to ?? '').trim();
  if (!text || !to) throw fail(400, 'Say who the message is for and what it says');
  if (text.length > 8000) throw fail(413, 'Keep messages under 8,000 characters');
  const project = from?.project ?? projectFor(req, body.project);
  // By name, only agents in the same project; another project's agent only by its exact session id.
  const name = to.toLowerCase();
  const asked = body.model || body.effort ? { model: body.model || '', effort: body.effort || '' } : null; // a model or effort for this one
  const matches = [...S.sessions.values()]
    .filter(s => !s.exited && s.kind === 'agent' && s.id !== from?.id
      && (s.id === to || (s.project === project && (s.specialist?.name.toLowerCase() === name || s.name.toLowerCase() === name))))
    .filter(s => !asked || (({ model, effort }) => s.model === model && s.effort === effort)(T.settle(asked, T.usual(T.find(s.specialist?.id), s.role))))
    .sort((a, b) => b.lastOutputAt - a.lastOutputAt); // the most recently active (on the model asked for, if one was)
  const signed = `${S.sign(from, text)}${from ? `\n\n(To answer, use message_agent to "${from.name}".)` : ''}`;
  let target = matches[0];
  const closed = !target && !asked && closedWorker(project, to);
  const bucket = target?.project ?? project;
  const recent = recentMessages(bucket);
  if (target) {
    S.deliver(target, signed);
  } else if (closed) {
    target = await wake(closed, signed);
  } else {
    if (!T.find(to)) throw fail(404, `No running agent called "${to}"${asked ? ' is on that model and effort' : ''}, and no one on the team has that name. A running agent can't change its model; list_agents and list_team show who there is.`);
    mayStartAgents(req);
    target = await S.createSession({ project, specialist: to, prompt: signed, ...asked, startedBy: starter(req) });
  }
  if (from && from.startedBy?.id === target.id) from.told = true;
  sent.set(bucket, [...recent, Date.now()]);
  const started = !matches[0] && !closed;
  bus.emit('event', { type: 'agent-message', from: from?.name ?? 'An agent', to: target.name, started, ...logMessage(bucket, from, target, 'message_agent') });
  return { delivered: !started, started, reopened: Boolean(closed), to: S.info(target) };
});

route('GET', '/api/messages', ({ req, query }) => {
  if (query.get('all')) { // the Graph's "All spaces" view: every folder's log, including asks between them. Yours only.
    notFromAgent(req, "read other spaces' messages");
    return db.messages;
  }
  const project = projectFor(req, query.get('project'));
  return db.messages.filter(m => m.project === project);
});

// Spaces: each other project folder. An agent may ask one a question and get a short answer back, the one door
// in the wall around its project: it never sees their chats, board or agents, and they choose what to share.
const asks = new Map(); // ask id -> { from, fromName, to, at }, until answered or an hour old
const HOUR = 60 * 60_000;
const mayAskSpaces = req => {
  if (db.settings.spacesCanAsk === false) throw fail(403, 'Spaces asking each other is turned off in Relay settings.');
  return caller(req) ?? (() => { throw fail(403, 'Only agents inside Relay can ask other spaces'); })();
};
const liveAgents = project => [...S.sessions.values()].filter(s => !s.exited && s.kind === 'agent' && (!project || s.project === project))
  .sort((a, b) => b.lastOutputAt - a.lastOutputAt);
const spaces = from => [...new Set([...db.projects.map(p => p.path), ...liveAgents().map(s => s.project)])].filter(p => p !== from.project);
route('GET', '/api/spaces', ({ req }) => spaces(mayAskSpaces(req)).map(p => (agents =>
  ({ name: path.basename(p), path: p, agents: agents.length, lead: agents.some(s => s.role === 'lead') }))(liveAgents(p))));
route('POST', '/api/spaces/ask', async ({ req, body }) => {
  mayMessage(req); // asks and answers type into a pane, so they're messages too
  const from = mayAskSpaces(req);
  const question = String(body.question ?? '').trim();
  const ref = String(body.space ?? '').trim();
  if (!question || !ref) throw fail(400, 'Say which space and what the question is');
  if (question.length > 8000) throw fail(413, 'Keep questions under 8,000 characters');
  const found = spaces(from).filter(p => p === expand(ref) || path.basename(p).toLowerCase() === ref.toLowerCase());
  if (found.length !== 1) throw fail(found.length ? 409 : 404, found.length ? `Several spaces are called "${ref}"; give its path` : `No space called "${ref}". list_spaces shows them.`);
  const project = found[0];
  const agents = liveAgents(project);
  let target = agents.find(s => s.role === 'lead') ?? agents.find(s => s.agent === 'claude');
  // Counted against both folders, so a looping asker can't send 20 to each space.
  const recent = recentMessages(project);
  const mine = recentMessages(from.project);
  for (const [id, a] of asks) if (Date.now() - a.at > HOUR) asks.delete(id);
  const askId = randomUUID().slice(0, 8);
  const signed = `[Question from ${S.plain(from.name)} in space ${spaceName(from.project)} (ask id ${askId})]\n${S.defuse(question)}\n\n` +
    `(Answer briefly with answer_space and ask id ${askId}. Share only what they need; they can't see your chats or board.)`;
  if (target) S.deliver(target, signed);
  else {
    mayStartAgents(req);
    target = await S.createSession({ project, prompt: signed, startedBy: starter(req) });
  }
  asks.set(askId, { from: from.id, fromName: from.name, to: target.id, at: Date.now() });
  sent.set(project, [...recent, Date.now()]);
  sent.set(from.project, [...mine, Date.now()]);
  bus.emit('event', { type: 'agent-message', from: `${from.name} (${spaceName(from.project)})`, to: target.name, ...logMessage(project, from, target, 'ask_space') });
  return { askId, deliveredTo: { name: target.name, space: path.basename(project), started: !agents.includes(target) } };
});
route('POST', '/api/spaces/answer', ({ req, body }) => {
  mayMessage(req);
  const from = mayAskSpaces(req);
  const askId = String(body.askId ?? '');
  const ask = asks.get(askId);
  if (!ask || Date.now() - ask.at > HOUR) throw fail(404, 'No open question with that ask id: each is answered once, within an hour');
  if (ask.to !== from.id) throw fail(403, 'Only the agent the question was delivered to can answer it');
  const answer = String(body.answer ?? '').trim();
  if (!answer) throw fail(400, 'Give an answer');
  const to = S.sessions.get(ask.from);
  if (!to || to.exited) {
    asks.delete(askId);
    throw fail(410, `${ask.fromName} has finished, so there is no one to answer`);
  }
  // Spaces share summaries, not transcripts.
  const capped = answer.length > 2000 ? `${answer.slice(0, 2000)}... (cut at 2,000 characters)` : answer;
  const recent = recentMessages(to.project);
  S.deliver(to, `[Answer from space ${spaceName(from.project)} (ask id ${askId})]\n${S.defuse(capped)}`);
  asks.delete(askId); // once delivered: an asker busy at a prompt can be answered again later
  sent.set(to.project, [...recent, Date.now()]);
  bus.emit('event', { type: 'agent-message', from: `${from.name} (${spaceName(from.project)})`, to: to.name, ...logMessage(to.project, from, to, 'answer_space') });
  return { delivered: true, to: to.name, capped: capped !== answer };
});

// Groups on the Graph: you name them and pick who's in them; agents can't change them.
const findGroup = id => db.groups.find(g => g.id === id) ?? (() => { throw fail(404, 'No such group'); })();
function groupFields(group, body) {
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!T.NAME.test(name)) throw fail(400, 'A group name is 1 to 30 letters, numbers or spaces');
    group.name = name;
  }
  if (body.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(String(body.color))) throw fail(400, 'A colour is like #1c7ed6');
    group.color = body.color;
  }
  if (body.members !== undefined) {
    if (!Array.isArray(body.members) || body.members.length > 50) throw fail(400, 'Members is a list of up to 50 agents');
    group.members = [...new Set(body.members.map(String).filter(m => /^[\w-]{1,64}$/.test(m)))];
  }
  return group;
}
route('GET', '/api/groups', ({ req, query }) => {
  const project = projectFor(req, query.get('project'));
  return db.groups.filter(g => g.project === project);
});
route('POST', '/api/groups', ({ req, body }) => {
  notFromAgent(req, 'change groups');
  const group = groupFields({ id: randomUUID().slice(0, 8), project: projectFor(req, body.project), name: '', color: '#1c7ed6', members: [] }, { name: '', ...body });
  db.groups.push(group);
  changed('groups');
  return group;
});
route('PATCH', '/api/groups/:id', ({ req, params, body }) => {
  notFromAgent(req, 'change groups');
  const group = groupFields(findGroup(params.id), body);
  changed('groups');
  return group;
});
route('DELETE', '/api/groups/:id', ({ req, params }) => {
  notFromAgent(req, 'change groups');
  db.groups = db.groups.filter(g => g.id !== findGroup(params.id).id);
  changed('groups');
  return {};
});

// Updates: is there a newer release on GitHub, and download it
route('GET', '/api/update', ({ query }) => U.status(query.get('force') === '1'));
// With automatic updates on, Download gets the update ready to install instead of saving it to Downloads.
route('POST', '/api/update/download', ({ req }) => (notFromAgent(req, 'download updates'), U.autoOn() ? U.prepare() : U.download()));
route('POST', '/api/update/install', ({ req }) => (notFromAgent(req, 'install updates'), U.restart()));
route('POST', '/api/update/show', () => U.reveal());

// The team: named specialists with their own instructions and model
route('GET', '/api/specialists', () => T.list());
route('POST', '/api/specialists', ({ req, body }) => (notFromAgent(req, 'change the team'), T.add(body)));
route('PATCH', '/api/specialists/:id', ({ req, params, body }) => {
  if (!fromAgent(req)) return T.update(params.id, body);
  if (db.settings.agentsCanEditTeam === false) throw fail(403, 'Agents changing the team is turned off in Relay settings.');
  const was = T.find(params.id)?.name;
  const s = T.update(params.id, body);
  bus.emit('event', { type: 'specialist-changed', name: was, by: caller(req)?.name ?? 'An agent' });
  return s;
});
route('DELETE', '/api/specialists/:id', ({ req, params }) => (notFromAgent(req, 'change the team'), T.remove(params.id), {}));

// Artifacts: pages and reports agents saved. You view them, open them in your browser and publish them.
const findArtifact = id => A.find(id) ?? (() => { throw fail(404, 'No such artifact'); })();
route('GET', '/api/artifacts', () => db.artifacts);
route('POST', '/api/artifacts', ({ req, body }) => {
  let html = body.html;
  if (body.file !== undefined) { // an .html file the agent wrote, relative to its own folder
    const from = caller(req)?.cwd || projectFor(req, body.project);
    // The real file, so a link named page.html can't stand in for something else. It isn't limited to the
    // agent's folder: agents often write pages to scratch folders, and the token already reads any file.
    const file = (() => { try { return fs.realpathSync(path.resolve(from, String(body.file).replace(/^~(?=$|\/)/, os.homedir()))); } catch { return ''; } })();
    const stat = file && fs.statSync(file, { throwIfNoEntry: false });
    if (!/\.html?$/i.test(file) || !stat?.isFile()) throw fail(400, `Not an .html file: ${file}`);
    if (stat.size > 10 * 1024 * 1024) throw fail(413, 'Artifacts can be up to 10 MB');
    html = fs.readFileSync(file, 'utf8');
  }
  const project = caller(req)?.project || (body.project ? expand(body.project) : db.settings.lastProject) || null;
  const a = A.save({ id: body.id, title: body.title, html, project, by: caller(req)?.name || 'You', folder: body.folder });
  return { ...a, url: `${S.serverUrl()}/a/${a.id}` };
});
route('PATCH', '/api/artifacts/:id', ({ params, body }) => {
  const a = findArtifact(params.id);
  if (body.title === undefined && body.folder === undefined) throw fail(400, 'Give it a name or a folder');
  if (body.title !== undefined && !String(body.title || '').trim()) throw fail(400, 'Give it a name');
  if (body.folder !== undefined) A.setFolder(a, body.folder); // checks the name first, so a bad one changes nothing
  if (body.title !== undefined) a.title = body.title.trim().slice(0, 120);
  changed('artifacts');
  return a;
});
// Folders group the Artifacts tab. Agents can file a page in one (save_artifact), but only you make, rename and delete them.
route('GET', '/api/artifact-folders', () => A.folders());
route('POST', '/api/artifact-folders', ({ req, body }) => (notFromAgent(req, 'change artifact folders'), A.addFolder(body.name), A.folders()));
route('PATCH', '/api/artifact-folders/:name', ({ req, params, body }) => (notFromAgent(req, 'change artifact folders'), A.renameFolder(params.name, body.name), A.folders()));
route('DELETE', '/api/artifact-folders/:name', ({ req, params }) => (notFromAgent(req, 'change artifact folders'), A.removeFolder(params.name), A.folders()));
route('DELETE', '/api/artifacts/:id', ({ params }) => {
  const a = findArtifact(params.id);
  for (const s of editSessions(a.id)) S.stop(s);
  A.remove(a);
  return {}; // a published copy stays on GitHub
});
// "Edit with AI": a small-model chat beside the page, working on a copy of it and saving back by id. One per page:
// asking again returns the one still running.
const EDIT_MODELS = ['haiku', 'sonnet', 'opus'];
const editSessions = id => [...S.sessions.values()].filter(s => s.artifactId === id);
route('POST', '/api/artifacts/:id/edit-chat', async ({ req, params, body }) => {
  notFromAgent(req, 'open an edit chat');
  const a = findArtifact(params.id);
  const live = editSessions(a.id).find(s => !s.exited);
  if (live) return S.info(live);
  const model = body.model ?? db.settings.artifactEditModel;
  if (!EDIT_MODELS.includes(model)) throw fail(400, `The edit model is one of ${EDIT_MODELS.join(', ')}`);
  for (const s of editSessions(a.id)) S.stop(s); // a finished one gives way, like a reopened chat
  const project = a.project && isDir(a.project) ? a.project : db.settings.lastProject;
  if (!isDir(project)) throw fail(400, 'Pick a project folder first');
  return S.info(await S.createSession({ project, name: `Edit ${S.plain(a.title)}`, model, cwd: A.editCopy(a), artifactId: a.id }));
});
route('GET', '/api/github/accounts', () => A.accounts());
route('POST', '/api/artifacts/:id/unpublish', ({ req, params }) => (notFromAgent(req, 'take pages down'), A.unpublish(findArtifact(params.id))));
route('POST', '/api/artifacts/:id/publish', ({ params, body }) =>
  A.publish(findArtifact(params.id), { account: String(body.account || ''), repo: String(body.repo || ''), slug: String(body.slug || '') }));

// Spend: what Claude Code cost on this Mac, per day, at API list prices (the page only; not in AGENT_ROUTES)
route('GET', '/api/usage/days', async () => (await US.scan(), { today: US.today(), days: US.usageDays() }));
route('GET', '/api/usage', async ({ query }) => {
  const day = query.get('day') || US.today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw fail(400, 'day is YYYY-MM-DD');
  await US.scan();
  return US.usageDay(day);
});

// Task Notes, the other app on this Mac: its open tasks, and bringing one onto this board
route('GET', '/api/tasknotes', () => TN.openTasks());
route('POST', '/api/tasknotes/import', async ({ req, body }) =>
  addTask(req, await TN.bringOver({ id: String(body.id || ''), date: String(body.date || '') }, projectFor(req, body.project))));
// A task changing column, for the other agents' news (see note in lib/sessions.mjs).
const moved = (req, task, to) => S.note(task.project, caller(req)?.id ?? null, `tasks moved to ${to}`, `Task ${S.plain(task.title, 60)} moved to ${to}`);
route('PATCH', '/api/tasks/:id', ({ req, params, body }) => {
  const task = findTask(params.id);
  if (body.status !== undefined && !STATUSES.includes(body.status)) throw fail(400, `Status must be one of: ${STATUSES.join(', ')}`);
  const toReview = body.status === 'review' && task.status !== 'review';
  if (body.status !== undefined && body.status !== task.status) moved(req, task, body.status);
  for (const key of ['title', 'description', 'status', 'agent', 'worktree']) if (body[key] !== undefined) task[key] = body[key];
  if (body.before !== undefined) { // drag-and-drop: place this task just before another one
    db.tasks.splice(db.tasks.indexOf(task), 1);
    const at = db.tasks.findIndex(t => t.id === body.before);
    db.tasks.splice(at < 0 ? db.tasks.length : at, 0, task);
  }
  task.updatedAt = Date.now();
  changed('tasks');
  if (toReview) S.tellStarter(task, 'is ready for review');
  return task;
});
route('DELETE', '/api/tasks/:id', ({ params }) => {
  db.tasks = db.tasks.filter(t => t.id !== params.id);
  changed('tasks');
  return {};
});
route('POST', '/api/tasks/:id/comments', ({ req, params, body }) => {
  const task = findTask(params.id);
  if (!String(body.text || '').trim()) throw fail(400, 'Comment is empty');
  task.notes.push({ at: Date.now(), by: caller(req)?.name || 'You', text: body.text.trim() });
  for (const pr of new Set(body.text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g))) {
    S.note(task.project, caller(req)?.id ?? null, 'PR links posted', `${S.plain(caller(req)?.name || 'You')} posted ${pr} on ${S.plain(task.title, 60)}`);
  }
  task.updatedAt = Date.now();
  changed('tasks');
  if (task.status === 'doing' && caller(req)?.id === task.sessionId && /blocked/i.test(body.text)) S.tellStarter(task, 'is blocked');
  return task;
});
route('POST', '/api/tasks/:id/start', async ({ req, params, body }) => {
  mayStartAgents(req);
  const task = findTask(params.id);
  const running = task.sessionId && S.sessions.get(task.sessionId);
  if (running && !running.exited) throw fail(409, 'This task already has a running agent');
  const agent = body.agent || task.agent || db.settings.defaultAgent;
  const worktree = body.worktree ?? task.worktree;
  const prompt = task.description ? `${task.title}\n\n${task.description}` : task.title;
  const s = await S.createSession({ project: task.project, agent, prompt, name: task.title, taskId: task.id, worktree, specialist: body.specialist || null, model: body.model || '', effort: body.effort || '', startedBy: starter(req) });
  if (task.status !== 'doing') S.note(task.project, s.id, 'tasks moved to doing', `Task ${S.plain(task.title, 60)} moved to doing`); // by its own agent, which knows
  Object.assign(task, { status: 'doing', sessionId: s.id, agent, worktree, branch: s.worktree?.branch ?? null, worktreePath: s.worktree?.path ?? null, updatedAt: Date.now() });
  changed('tasks');
  return { task, session: S.info(s) };
});

// Review: what each agent worktree changed, and committing, merging or discarding it
route('GET', '/api/review', async ({ req, query }) => {
  const project = projectFor(req, query.get('project'));
  const result = await G.review(project);
  // Not a repo itself: the repos its agents changed instead
  if (!result.git) result.elsewhere = (db.projects.find(p => p.path === project)?.repos ?? []).filter(isDir).map(root => ({ root, name: path.basename(root) }));
  for (const item of result.items) {
    const s = [...S.sessions.values()].find(x => x.cwd === item.path && !x.exited);
    item.session = s ? S.info(s) : null;
    item.task = item.taskId ? db.tasks.find(t => t.id === item.taskId) ?? null : null;
  }
  return result;
});
const existingDir = p => {
  const dir = expand(p);
  if (!isDir(dir)) throw fail(404, 'No such worktree');
  return dir;
};
route('GET', '/api/review/file', ({ query }) => G.fileVersions(existingDir(query.get('worktree')), query.get('file')));
route('GET', '/api/review/diff', async ({ req, query }) => {
  const dir = existingDir(query.get('worktree'));
  if (fromAgent(req) && !visibleSessions(req).some(s => s.cwd === dir)) throw fail(403, 'Agents can only see the changes of agents in their own project');
  return { text: await G.diffText(dir) };
});
route('POST', '/api/review/commit', ({ body }) => G.commit(existingDir(body.worktree), String(body.message || 'Relay changes')));
route('POST', '/api/review/merge', async ({ req, body }) => {
  const meta = await G.merge(existingDir(body.worktree));
  const task = meta.taskId && db.tasks.find(t => t.id === meta.taskId);
  if (task) {
    if (task.status !== 'done') moved(req, task, 'done');
    task.status = 'done';
    task.notes.push({ at: Date.now(), by: 'You', text: `Merged ${meta.branch} into ${meta.base}.` });
    changed('tasks');
  }
  return { merged: meta.branch, into: meta.base };
});
route('POST', '/api/review/remove', async ({ body }) => {
  const dir = existingDir(body.worktree);
  if ([...S.sessions.values()].some(s => s.cwd === dir && !s.exited)) throw fail(409, 'An agent is still running in this worktree. Stop it first.');
  await G.removeWorktree(dir);
  return {};
});

// Files (the editor, folder suggestions, images)
route('GET', '/api/fs/list', ({ query }) => {
  const dir = expand(query.get('path'));
  if (!isDir(dir)) throw fail(404, `Not a folder: ${dir}`);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !SKIP_IN_TREE.has(e.name))
    .map(e => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() }))
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
});
route('GET', '/api/fs/file', ({ query }) => {
  const file = expand(query.get('path'));
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw fail(404, 'No such file');
  if (stat.size > 5 * 1024 * 1024) throw fail(413, 'File is over 5 MB, open it in a shell instead');
  const data = fs.readFileSync(file);
  if (data.subarray(0, 8000).includes(0)) throw fail(415, 'This looks like a binary file');
  return { content: data.toString('utf8') };
});
route('PUT', '/api/fs/file', ({ body }) => {
  const file = expand(body.path);
  if (!isDir(path.dirname(file))) throw fail(404, 'Folder does not exist');
  writeAtomic(file, String(body.content ?? ''));
  return {};
});
route('GET', '/api/fs/suggest', ({ query }) => {
  const raw = query.get('prefix') || '~/';
  const full = expand(raw);
  const [dir, start] = raw.endsWith('/') ? [full, ''] : [path.dirname(full), path.basename(full)];
  if (!isDir(dir)) return [];
  const shown = raw.endsWith('/') ? raw : raw.slice(0, raw.length - start.length);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(start.toLowerCase()))
    .slice(0, 30).map(e => `${shown}${e.name}`);
});
// Raster images only: an SVG opened from here would run its scripts with this app's access.
const RASTER = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
route('GET', '/api/fs/raw', ({ query }) => {
  const file = expand(query.get('path'));
  if (!RASTER.has(path.extname(file).toLowerCase()) || !fs.existsSync(file)) throw fail(404, 'No such image');
  return { raw: fs.readFileSync(file), type: MIME[path.extname(file).toLowerCase()] };
});

// Screenshots for agents, saved inside the project (kept out of git)
const shotsDir = project => path.join(project, '.agent-desk', 'shots');
route('GET', '/api/shots', ({ req, query }) => {
  const dir = shotsDir(projectFor(req, query.get('project')));
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.png'))
    .map(f => ({ name: f, path: path.join(dir, f), at: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at).slice(0, 40);
});
route('POST', '/api/shots', async ({ req, body }) => {
  const project = projectFor(req, body.project);
  const match = /^data:image\/png;base64,(.+)$/.exec(body.dataUrl || '');
  if (!match) throw fail(400, 'Expected a PNG image');
  const root = await G.repoRoot(project);
  if (root) await G.excludeDeskFolder(root);
  fs.mkdirSync(shotsDir(project), { recursive: true });
  const file = path.join(shotsDir(project), `shot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
  fs.writeFileSync(file, Buffer.from(match[1], 'base64'));
  return { path: file };
});

// Voice: an on-device speech helper (macOS Speech framework) streams what you say to the page
route('POST', '/api/voice/start', ({ body }) => {
  if (!VOICE_HELPER) throw fail(501, 'The voice helper is not built. Run: npm run build:native');
  if (voice) return {};
  voice = spawn(VOICE_HELPER, [String(body.lang || db.settings.voiceLang)], { stdio: ['pipe', 'pipe', 'ignore'] });
  readline.createInterface({ input: voice.stdout }).on('line', line => {
    const [kind, ...rest] = line.split(':');
    const text = rest.join(':');
    if (kind === 'PARTIAL' || kind === 'FINAL') bus.emit('event', { type: 'voice', text, final: kind === 'FINAL' });
    if (kind === 'ERROR') bus.emit('event', { type: 'voice', error: text });
  });
  voice.on('exit', () => {
    voice = null;
    bus.emit('event', { type: 'voice', stopped: true });
  });
  return {};
});
route('POST', '/api/voice/stop', () => {
  voice?.stdin.write('stop\n');
  return {};
});

// ---------- HTTP ----------
function staticPath(pathname) {
  const inside = (base, rel) => {
    const file = path.resolve(base, decodeURIComponent(rel));
    return file.startsWith(base + path.sep) ? file : null;
  };
  if (pathname === '/') return path.join(DIR, 'public', 'index.html');
  if (pathname.startsWith('/vendor/monaco/')) return inside(path.join(DIR, 'node_modules', 'monaco-editor', 'min'), pathname.slice(15));
  if (pathname.startsWith('/vendor/')) return Object.hasOwn(VENDOR, pathname.slice(8)) ? path.join(DIR, 'node_modules', VENDOR[pathname.slice(8)]) : null;
  return inside(path.join(DIR, 'public'), pathname.slice(1));
}

const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>Relay</title>
<body style="font:15px -apple-system,system-ui,sans-serif;background:#0b0c10;color:#e7e9ef;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:420px;text-align:center"><h2>Relay is locked</h2>
<p style="color:#8a90a2">Open it with the link printed in the terminal where you ran <code>npm start</code>.</p></div>`;

// One bad request must never take the server (and every running agent) down.
async function handle(req, res) {
  try {
    await respond(req, res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(e instanceof URIError ? 400 : 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e instanceof URIError ? 'Bad URL' : e.message }));
  }
}

async function respond(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!sameSite(req)) return json(403, { error: 'Forbidden' });
  req.auth = auth(req, url);
  if (url.pathname === '/mcp') return req.auth ? mcp(req, res, json) : json(401, { error: 'Missing or wrong Relay token' });

  // An artifact opens without the token, so your own browser can show it: its random id is the key. It runs
  // sandboxed in an origin of its own, so its scripts can't reach Relay, and it sends no Referer that
  // would leak its address to the sites it loads from.
  const artifact = req.method === 'GET' && /^\/a\/([A-Za-z0-9_-]{22})\/?$/.exec(url.pathname);
  if (artifact) {
    const a = A.find(artifact[1]);
    if (!a) return json(404, { error: 'No such artifact' });
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads',
    });
    return res.end(A.serve(a));
  }

  if (!url.pathname.startsWith('/api/')) {
    if (url.pathname === '/' && url.searchParams.has('t')) { // trade the link's secret for a cookie, then drop it from the address bar
      if (req.auth?.kind !== 'ui') return res.writeHead(302, { location: '/' }).end();
      url.searchParams.delete('t'); // a new window's ?project= stays
      return res.writeHead(302, { location: `/${url.search}`, 'set-cookie': `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/` }).end();
    }
    if (url.pathname === '/' && req.auth?.kind !== 'ui') return res.writeHead(401, { 'content-type': 'text/html' }).end(LOCKED_PAGE);
    const file = req.method === 'GET' && staticPath(url.pathname);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  }

  if (!req.auth) return json(401, { error: 'Missing or wrong Relay token' });

  if (url.pathname === '/api/events') { // server-sent events: the page refetches whatever changed
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    bus.on('event', send);
    return req.on('close', () => { clearInterval(ping); bus.off('event', send); });
  }

  for (const r of routes) {
    const m = r.method === req.method && r.re.exec(url.pathname);
    if (!m) continue;
    try {
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const result = await r.handler({ req, params, query: url.searchParams, body });
      if (result?.raw !== undefined) {
        res.writeHead(200, { 'content-type': result.type, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' });
        return res.end(result.raw);
      }
      return json(200, result ?? {});
    } catch (e) {
      return json(e.status || 500, { error: e.message });
    }
  }
  json(404, { error: 'Not found' });
}

// MCP over HTTP: each POST carries one JSON-RPC message (or a batch). The tools act as the session the agent's
// token belongs to (or, with the master token, the one in x-desk-session), so "update my task" knows which task.
// Their API calls are the server calling itself, with the master token. No server-to-client stream is offered.
async function mcp(req, res, json) {
  if (req.method !== 'POST') return json(405, { error: 'POST JSON-RPC messages here' });
  const body = await readBody(req);
  const session = String(caller(req)?.id ?? req.headers['x-desk-session'] ?? '');
  const api = async (method, apiPath, payload) => {
    const r = await fetch(`${S.serverUrl()}${apiPath}`, {
      method, headers: { 'content-type': 'application/json', 'x-desk-token': TOKEN, 'x-desk-session': session, 'x-desk-via': 'mcp' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Relay answered ${r.status}`);
    return data;
  };
  const tools = mcpTools({ api, session });
  const answers = (await Promise.all((Array.isArray(body) ? body : [body]).map(m => handleMcp(m, tools)))).filter(Boolean);
  if (!answers.length) return res.writeHead(202).end();
  json(200, Array.isArray(body) ? answers : answers[0]);
}

// Each terminal pane attaches to one session: it gets the current screen, then live output.
const wss = new WebSocketServer({ noServer: true });
function upgrade(req, socket, head) {
  // Node hands an upgrade's socket over with no error listener, so a client resetting it would crash the server.
  socket.on('error', () => socket.destroy());
  try {
    const url = new URL(req.url, 'http://localhost');
    const s = url.pathname === '/ws' && S.sessions.get(url.searchParams.get('id'));
    if (!sameSite(req) || auth(req, url)?.kind !== 'ui' || !s) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => S.attach(s, ws));
  } catch {
    socket.destroy();
  }
}

// A work network that inspects HTTPS installs its own root certificate in the Mac's keychain, which Safari
// and curl trust but Node doesn't: GitHub calls (updates, publishing) then fail with "self signed certificate
// in certificate chain". So Node trusts the Mac's roots too, as Task Notes does. Verification stays on.
function trustTheMac() {
  try {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
  } catch {} // older Node: its own roots only
}

// Starts Relay. The Mac app calls this with its own data folder; `npm start` runs it directly.
export async function start({ port = Number(process.env.PORT) || 4747, dataDir = path.join(DIR, 'data'), voiceHelper } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  trustTheMac();
  load(dataDir);
  S.forgetRunningChats();
  // No session outlives a restart, so neither do its MCP and hook files (left behind by a crash; older ones held the master token).
  for (const dir of ['mcp', 'hooks']) fs.rmSync(path.join(dataDir, dir), { recursive: true, force: true });
  A.setDir(dataDir);
  TN.watch();
  VOICE_HELPER = [voiceHelper, path.join(DIR, 'native', 'build', 'desk-listen')].find(p => p && fs.existsSync(p)) ?? null;
  // The secret is kept in a file only you can read, so links and MCP setups keep working across restarts.
  // ponytail: agents run as you, so one with a shell can still read this file; only their own tools and config
  // files are kept from it. Real isolation needs a separate macOS user or the keychain.
  const tokenFile = path.join(dataDir, 'token');
  TOKEN = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  if (!/^[A-Za-z0-9_-]{32,}$/.test(TOKEN)) { // missing, empty or damaged: make a new one
    TOKEN = randomBytes(24).toString('base64url');
    fs.writeFileSync(`${tokenFile}.tmp`, TOKEN, { mode: 0o600 });
    fs.renameSync(`${tokenFile}.tmp`, tokenFile);
  }
  const server = http.createServer(handle);
  server.on('upgrade', upgrade);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = server.address().port;
  LOCAL = new Set([`localhost:${actual}`, `127.0.0.1:${actual}`]);
  COOKIE = `desk_${actual}`;
  S.setServer({ url: `http://127.0.0.1:${actual}`, dataDir });
  // 127.0.0.1, not localhost: localhost may resolve to ::1, where some other program could be listening.
  const url = `http://127.0.0.1:${actual}/?t=${TOKEN}`;
  console.log(`Relay is running. Open ${url}`);
  // Panes that were open when Relay stopped come back as they were (oldest first, so the grid keeps its order).
  // A chat whose folder is gone stays in Recent. A shell's process can't be resumed: it gets a fresh one in its folder.
  for (const c of db.chats.filter(c => c.open).sort((a, b) => a.createdAt - b.createdAt)) {
    c.open = false;
    if (S.chatInfo(c).folderMissing) continue;
    await reopen(c).catch(e => console.error(`Couldn't reopen ${c.name}:`, e.message));
  }
  for (const x of [...db.shells].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!fs.statSync(x.cwd, { throwIfNoEntry: false })?.isDirectory()) db.shells = db.shells.filter(y => y !== x);
    else await S.createSession({ kind: 'shell', project: x.project, cwd: x.cwd, name: x.name, shellId: x.id }).catch(e => console.error(`Couldn't reopen ${x.name}:`, e.message));
  }
  const upkeep = setInterval(() => S.upkeep().catch(e => console.error('Lead upkeep failed:', e)), 30_000);
  // Save finished days of spend even if the Spend page is never opened, before Claude Code deletes their transcripts.
  const spend = () => US.scan().catch(e => console.error('Spend scan failed:', e));
  setTimeout(spend, 30_000).unref();
  setInterval(spend, 60 * 60_000).unref();
  return {
    port: actual, url, token: TOKEN,
    close: () => { clearInterval(upkeep); S.stopAll(); voice?.kill(); server.close(); },
  };
}

if (process.argv[1] && import.meta.filename === fs.realpathSync(process.argv[1])) {
  const { close } = await start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { close(); process.exit(0); });
}
