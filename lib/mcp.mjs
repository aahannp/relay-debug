// Relay's MCP tools: they let Claude Code (inside Relay, or in your own terminal) read and drive
// the shared task board and the other agents. Served over HTTP at /mcp ("streamable HTTP" with plain JSON
// answers), so no extra process is needed. The tools call this server's own API as the agent that asked.
// Results are compact JSON with empty fields left out; the REST answers the page reads stay as they are.
import { plain, prose } from './sessions.mjs';

const ago = t => (m => m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`)(Math.max(1, Math.round((Date.now() - t) / 60_000)));
const fail = message => { throw new Error(message); };

export function mcpTools({ api, session }) {
  const me = async () => (session ? (await api('GET', '/api/sessions')).find(s => s.id === session) : null);
  // Every tool that takes an agent finds it here, by any handle: a live session id, the old id of a worker Relay
  // closed, a chat id, a task id, or a name (pane title or specialist). It answers { s } for a live pane or { c } for a
  // closed chat. The server lists only the caller's own project, so nothing in another project is ever found.
  const find = async ref => {
    const live = (await api('GET', '/api/sessions')).filter(s => s.kind === 'agent');
    if (!ref) return { s: live.find(s => s.id === session) ?? fail('Name an agent (you are not a Relay session)') };
    const r = String(ref).trim();
    const key = r.toLowerCase();
    const chats = (await api('GET', '/api/chats')).filter(c => !c.artifactId); // newest first
    const paneOf = c => live.find(s => s.chatId === c.id);
    const pick = c => (s => s ? { s } : { c })(paneOf(c));
    const byId = live.find(s => s.id === r || s.chatId === r);
    if (byId) return { s: byId };
    const chat = chats.find(c => c.id === r || c.autoClosed === r);
    if (chat) return pick(chat);
    const task = (await api('GET', '/api/tasks')).find(t => t.id === r);
    if (task) {
      const s = live.filter(x => x.taskId === task.id).sort((a, b) => b.startedAt - a.startedAt)[0];
      const c = chats.find(x => x.taskId === task.id);
      if (s || c) return s ? { s } : pick(c);
      fail(`Task ${task.id} has no agent yet. start_task starts one.`);
    }
    const named = x => x.name?.toLowerCase() === key || x.specialist?.name?.toLowerCase() === key;
    const running = live.filter(named);
    const wanted = running.filter(s => !s.exited).length ? running.filter(s => !s.exited) : running;
    if (wanted.length === 1) return { s: wanted[0] };
    const closed = wanted.length ? [] : chats.filter(c => !paneOf(c) && (named(c) || c.title?.toLowerCase() === key));
    if (closed.length === 1) return { c: closed[0] };
    const all = wanted.length ? wanted.map(s => `${plain(s.name)} (agent ${s.id}, ${s.status})`) : closed.slice(0, 5).map(c => `${plain(c.name || c.title)} (agent ${c.autoClosed ?? c.id}, closed ${ago(c.lastActiveAt)})`);
    if (all.length) throw Object.assign(new Error(`${all.length} agents are called "${plain(r)}": ${all.join('; ')}. Name one by its agent id.`), { matches: wanted });
    fail(`No agent "${plain(r, 60)}" here. list_agents shows live agents and recent closed chats; a closed worker is reached by its name or task id.`);
  };
  const who = async ref => (r => r.s ?? fail(`${plain(r.c.name || r.c.title)}'s pane is closed. read_agent_chat reads it; message_agent opens it again if Relay closed it.`))(await find(ref));
  // What a tool that started or reached an agent answers: enough to name it next time.
  const short = (s, extra = {}) => ({ ok: true, agent: s.id, name: plain(s.name, 60), task: s.taskId, ...extra });
  const myTaskId = async id => id || (await me())?.taskId || (() => { throw new Error('Give a task id (this session is not working on a task)'); })();
  const q = encodeURIComponent;
  // Changing a task answers with just this, not the whole task (its description and every note) read back.
  const brief = ({ id, status, title, branch }) => ({ id, status, title, branch: branch ?? null });

  const str = description => ({ type: 'string', description });
  const MODEL = { type: 'string', enum: ['fable', 'opus', 'sonnet', 'haiku', 'lighter', 'stronger'], description: 'Leave out to use their usual model. "lighter" or "stronger" is one step from their usual one (for "a light/fast/cheap model" or "a smarter/stronger one"); or name one: haiku for quick simple jobs, sonnet for everyday work, opus for the hardest, fable only for the very hardest and longest (twice the price of opus).' };
  const EFFORT = { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'lower', 'higher'], description: 'Leave out to use their usual effort. "lower" or "higher" is one step from it.' };
  const SPECIALIST = str('Name of a specialist from list_team to do it (they always run as Claude)');
  const AGENT = str('Who: their name, agent id or task id (a closed worker too, from list_agents)');
  const tool = (name, description, properties, required, run) => ({ name, description, inputSchema: { type: 'object', properties, required }, run });

  const TOOLS = [
    tool('get_project', 'The project folder, and which session and task you are, if any.', {}, [], async () => {
      const self = await me();
      return { project: self?.project ?? null, you: self ?? 'not a Relay session' };
    }),
    tool('list_tasks', 'List tasks on the board: those not done, or only one status ("all" includes done). agent is the session working on it.', {
      status: { type: 'string', enum: ['todo', 'doing', 'review', 'done', 'all'] },
    }, [], async ({ status }) => {
      const tasks = await api('GET', '/api/tasks');
      return tasks.filter(t => status === 'all' || (status ? t.status === status : t.status !== 'done'))
        .map(({ id, title, status, branch, sessionId, notes }) => ({ id, title: prose(title, 120), status, agent: sessionId, branch, comments: notes.length || undefined }));
    }),
    tool('create_task', 'Add a task to the To do column. Make it self-contained: the goal, the files involved, what to report back (shape and length), and what not to touch.', {
      title: str('Short title'), description: str('What to do, in detail'),
      agent: { type: 'string', enum: ['claude', 'codex', 'gemini', 'cursor'] },
    }, ['title'], async ({ title, description, agent }) => brief(await api('POST', '/api/tasks', { title, description, agent }))),
    tool('update_task', 'Change a task\'s status, title or description. Leave id out to update your own task.', {
      id: str('Task id'), status: { type: 'string', enum: ['todo', 'doing', 'review', 'done'] }, title: str('New title'), description: str('New description'),
    }, [], async ({ id, ...changes }) => brief(await api('PATCH', `/api/tasks/${q(await myTaskId(id))}`, changes))),
    tool('comment_on_task', 'Post a progress note or summary on a task. Leave id out to comment on your own task.', {
      id: str('Task id'), text: str('The comment'),
    }, ['text'], async ({ id, text }) => brief(await api('POST', `/api/tasks/${q(await myTaskId(id))}/comments`, { text }))),
    tool('start_task', 'Start a worker agent on a task, optionally a specialist from the team and a model. By default it gets its own git worktree.', {
      id: str('Task id'), agent: { type: 'string', enum: ['claude', 'codex', 'gemini', 'cursor'] }, worktree: { type: 'boolean' },
      specialist: SPECIALIST, model: MODEL, effort: EFFORT,
    }, ['id'], async ({ id, agent, worktree, specialist, model, effort }) => {
      const { task, session: s } = await api('POST', `/api/tasks/${q(id)}/start`, { agent, worktree, specialist, model, effort });
      return short({ ...s, taskId: task.id }, { started: true });
    }),
    tool('start_agent', 'Start a new agent with a first message, optionally a specialist from the team and a model. It can\'t see your conversation, so make it self-contained: the goal, the files involved, what to report back (shape and length), and what not to touch. A lead may start another lead (role "lead") for a separate goal.', {
      prompt: str('First message for the agent'), name: str('Pane title'), role: { type: 'string', enum: ['lead'] },
      agent: { type: 'string', enum: ['claude', 'codex', 'gemini', 'cursor'] }, worktree: { type: 'boolean' },
      specialist: SPECIALIST, model: MODEL, effort: EFFORT,
    }, ['prompt'], async ({ prompt, name, role, agent, worktree, specialist, model, effort }) =>
      short(await api('POST', '/api/sessions', { prompt, name, role, agent, worktree, specialist, model, effort, kind: 'agent' }), { started: true })), // Settings can turn this off
    tool('message_agent', 'Send a message to another agent, by name (like Christie), agent id or task id. It is typed into their terminal, signed with your name, and the user sees it there; they can answer the same way. A worker Relay closed opens again with your message. If no one by that name is running but they are on the team, a new one starts with your message. Only message another agent when the user asks you to, or your task clearly needs it, and make the message self-contained: they can\'t see your conversation.', {
      agent: AGENT, text: str('The message'), model: MODEL, effort: EFFORT, to: str('Same as agent (older name)'),
    }, ['text'], async ({ agent, to, text, model, effort }) => {
      const ref = String(agent ?? to ?? '').trim() || fail('Say who the message is for (agent)');
      // A specialist's name reaches the team: the server picks their most recently active pane (on the model asked
      // for, if any) or starts one. Anything else must be an agent here, so another project's is never reached.
      const team = (await api('GET', '/api/specialists').catch(() => [])).find(x => x.id === ref || x.name.toLowerCase() === ref.toLowerCase());
      let target = team?.name;
      if (!target) {
        const r = await find(ref);
        if (r.c && !r.c.autoClosed) fail(`${plain(r.c.name || r.c.title)}'s pane was closed by the user, so it can't take messages. read_agent_chat reads its conversation.`);
        target = r.s?.id ?? r.c.autoClosed;
      }
      const res = await api('POST', '/api/messages', { to: target, text, model, effort });
      return short(res.to, { reopened: res.reopened || undefined, started: res.started || undefined });
    }),
    tool('read_agent_chat', 'Read another agent\'s conversation (what the user and they have said, and the tools they used) to get their context quickly. Shows the commands they ran and any PR links. Messages are cut at 2,000 characters except their latest one; full: true keeps whole messages (use with last 3 or less). Works for closed chats too; leave agent out to read your own.', {
      agent: AGENT, last: { type: 'number', description: 'How many of the latest messages (default 30)' },
      full: { type: 'boolean', description: 'Whole messages, up to 20,000 characters each (use with last 3 or less)' },
    }, [], async ({ agent, last = 30, full }) => {
      const r = await find(agent);
      const query = `?last=${Number(last) || 30}${full ? '&full=1' : ''}`;
      return api('GET', r.s ? `/api/sessions/${q(r.s.id)}/chat${query}` : `/api/chats/${q(r.c.id)}/chat${query}`);
    }),
    tool('clone_agent', 'Start a copy of an agent (yourself, by default) that carries its whole conversation so far, to work on another part in parallel. It runs in the same folder, so agree who edits which files. Give it a self-contained first message saying which part is its own.', {
      agent: str('Who to copy: their name or agent id (leave out to copy yourself)'), prompt: str('What the copy should do'), name: str('A name for the copy'),
    }, ['prompt'], async ({ agent, prompt, name }) => short(await api('POST', `/api/sessions/${q((await who(agent)).id)}/clone`, { prompt, name }), { started: true })),
    tool('list_team', 'Who is on the team: each specialist\'s full profile (id, name, what they are good at, instructions, model, effort, read-only) and how many of them are running now.', {}, [], async () => {
      const running = (await api('GET', '/api/sessions').catch(() => [])).filter(s => !s.exited); // none outside Relay
      return (await api('GET', '/api/specialists')).map(({ id, name, role, instructions, model, effort, readOnly }) =>
        ({ id, name, goodAt: role, instructions, model: model || 'default', effort: effort || 'default', readOnly: !!readOnly, runningNow: running.filter(s => s.specialist?.id === id).length }));
    }),
    tool('update_specialist', 'Change a specialist\'s profile, only when the user asks you to (it may be your own). Read it with list_team first; give only what changes. Agents started from now on get the change; running ones keep their old instructions until restarted.', {
      specialist: str('Their name or id, from list_team'), name: str('New name'), role: str('What they are good at, in a line'),
      instructions: str('Their complete new instructions (replaces the old ones)'),
      model: str('fable, opus, sonnet or haiku, or "" for the worker default in Settings'), effort: str('low, medium, high, xhigh or max, or "" for the worker default'),
    }, ['specialist'], async ({ specialist, ...changes }) => {
      const key = String(specialist).toLowerCase();
      const s = (await api('GET', '/api/specialists')).find(x => x.id === specialist || x.name.toLowerCase() === key);
      if (!s) throw new Error(`No one called "${specialist}" on the team. list_team shows who there is.`);
      return api('PATCH', `/api/specialists/${q(s.id)}`, changes); // Settings can turn this off
    }),
    tool('list_agents', 'List the agents in this project: id, name, status (working, idle, needs-input or exited), task, branch, what each was asked and who started it. Also the 5 newest closed chats of the last 2 days (status "closed"): a closed worker answers to its name, id or task id, read_agent_chat reads it and message_agent opens it again. closed: N lists more.', {
      closed: { type: 'number', description: 'How many closed chats, of any age (default 5 from the last 2 days, max 50)' },
      shells: { type: 'boolean', description: 'Include shell panes' },
    }, [], async ({ closed, shells }) => {
      const live = (await api('GET', '/api/sessions')).filter(s => shells || s.kind === 'agent')
        .map(({ id, name, agent, kind, role, status, taskId, worktree, specialist, model, effort, asked, startedBy }) =>
          ({ id, name: plain(name, 60), cli: kind === 'shell' ? 'shell' : agent === 'claude' ? undefined : agent, specialist: specialist?.name, model, effort,
            role, status, task: taskId, branch: worktree?.branch, asked: asked && asked !== name ? prose(asked, 100) : undefined, by: startedBy ? plain(startedBy.name) : 'the user' }));
      const n = Math.min(Math.max(Number(closed) || 0, 0), 50);
      const past = (await api('GET', '/api/chats')).filter(c => !c.sessionId && !c.artifactId && (n || Date.now() - c.lastActiveAt < 2 * 86_400_000)) // newest first
        .slice(0, n || 5).map(c => ({ id: c.autoClosed ?? c.id, chat: c.autoClosed ? c.id : undefined, name: plain(c.name || c.title, 60), task: c.taskId, status: 'closed', last: ago(c.lastActiveAt) }));
      return [...live, ...past];
    }),
    tool('read_agent_output', 'Read the last lines of another agent\'s terminal screen, in this project (not shells). For a closed one, its last message.', {
      agent: AGENT, lines: { type: 'number', description: 'How many lines (default 60, max 500)' }, id: str('Same as agent (older name)'),
    }, [], async ({ agent, id, lines = 60 }) => {
      const r = await find(agent ?? id ?? fail('Say whose screen to read (agent)'));
      if (r.s) return (await api('GET', `/api/sessions/${q(r.s.id)}/output?lines=${lines}`)).text;
      const said = (await api('GET', `/api/chats/${q(r.c.id)}/chat?last=10`)).messages ?? [];
      return `${said.findLast(m => m.from === 'agent')?.text ?? '(nothing said)'}\n\n(pane closed; read_agent_chat has the rest)`;
    }),
    tool('send_to_agent', 'Type plain text into another agent in this project, signed with your name, and press Enter. It can\'t type into shells, permission prompts or yourself. A worker Relay closed opens again with it.', {
      agent: AGENT, text: str('What to type'), id: str('Same as agent (older name)'),
    }, ['text'], async ({ agent, id, text }) => {
      const r = await find(agent ?? id ?? fail('Say who to type into (agent)'));
      if (r.c && !r.c.autoClosed) fail(`${plain(r.c.name || r.c.title)}'s pane was closed by the user, so it can't take messages. read_agent_chat reads its conversation.`);
      await api('POST', `/api/sessions/${q(r.s?.id ?? r.c.autoClosed)}/input`, { text });
      if (r.s) return short(r.s);
      const s = (await api('GET', '/api/sessions')).find(x => x.chatId === r.c.id);
      return short(s ?? { id: r.c.autoClosed, name: r.c.name, taskId: r.c.taskId }, { reopened: true });
    }),
    tool('stop_agent', 'Stop an agent in this project and close its pane (not shells).', { agent: AGENT, id: str('Same as agent (older name)') }, [],
      async ({ agent, id }) => {
        const s = await who(agent ?? id ?? fail('Say who to stop (agent)'));
        await api('DELETE', `/api/sessions/${q(s.id)}`);
        return short(s);
      }),
    tool('get_agent_diff', 'See what an agent in this project changed in its worktree, as a diff against where it branched. Works after its pane closed.', {
      agent: AGENT, id: str('Same as agent (older name)'),
    }, [], async ({ agent, id }) => {
      const r = await find(agent ?? id ?? fail('Say whose changes to show (agent)'));
      return (await api('GET', `/api/review/diff?worktree=${q((r.s ?? r.c).cwd)}`)).text;
    }),
    tool('save_artifact', 'Save a page, report, chart or other visual you made for the user as one HTML file. It shows in Relay\'s Artifacts tab, where they can view it, open it in a browser and publish it. Pass the HTML, or the path of an .html file you wrote. Pass id to replace one you saved before. Mermaid diagrams in <pre class="mermaid"> render automatically.', {
      title: str('Short name for it'), html: str('The complete HTML document'),
      file: str('Path of an .html file to save instead of html, relative to your folder'), id: str('Id of an artifact you saved before, to replace it'),
      folder: str('A folder to file it in, e.g. the project or topic; it\'s created if missing'),
    }, ['title'], args => api('POST', '/api/artifacts', args)),
    // Other project folders are other spaces: you can ask one a question, never read its chats, board or agents.
    tool('list_spaces', 'The other spaces: each other project folder in Relay, with how many agents run there and whether it has a lead. Only names, never their chats or tasks.', {}, [],
      () => api('GET', '/api/spaces')),
    tool('ask_space', 'Ask another space (a project folder from list_spaces) a question when your work needs their context. It goes to their lead, or their most recently active agent, who answers into your pane with a short summary. Make it self-contained: they can\'t see your conversation.', {
      space: str('Its name or path, from list_spaces'), question: str('What you need to know'),
    }, ['space', 'question'], ({ space, question }) => api('POST', '/api/spaces/ask', { space, question })),
    tool('answer_space', 'Answer a question another space asked you, by its ask id. Keep it brief (up to 2,000 characters) and share only what they need.', {
      askId: str('The ask id from the question'), answer: str('Your answer'),
    }, ['askId', 'answer'], ({ askId, answer }) => api('POST', '/api/spaces/answer', { askId, answer })),
  ];
  return TOOLS;
}

// Answers one JSON-RPC message. Returns null for notifications, which need no answer.
export async function handleMcp(msg, tools) {
  const { id, method, params = {} } = msg || {};
  if (id === undefined || id === null) return null;
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') {
    return reply({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-desk', version: '1.0.0' } });
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: tools.map(({ run, ...t }) => t) });
  if (method === 'tools/call') {
    const t = tools.find(x => x.name === params.name);
    if (!t) return error(-32602, `Unknown tool ${params.name}`);
    try {
      const out = await t.run(params.arguments || {});
      return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, (k, v) => (v === null || v === '' ? undefined : v)) }] });
    } catch (e) {
      return reply({ content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return error(-32601, `Method not found: ${method}`);
}
