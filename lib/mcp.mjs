// Relay's MCP tools: they let Claude Code (inside Relay, or in your own terminal) read and drive
// the shared task board and the other agents. Served over HTTP at /mcp ("streamable HTTP" with plain JSON
// answers), so no extra process is needed. The tools call this server's own API as the agent that asked.

export function mcpTools({ api, session }) {
  const me = async () => (session ? (await api('GET', '/api/sessions')).find(s => s.id === session) : null);
  // An agent by session id or name (this project's first, most recently active), or the one asking.
  const who = async ref => {
    const all = (await api('GET', '/api/sessions')).filter(s => s.kind === 'agent');
    if (!ref) return all.find(s => s.id === session) ?? (() => { throw new Error('Name an agent (you are not a Relay session)'); })();
    const name = String(ref).toLowerCase();
    const mine = all.find(s => s.id === session)?.project;
    const found = all.find(s => s.id === ref) ?? all.filter(s => (!mine || s.project === mine) && (s.name.toLowerCase() === name || s.specialist?.name.toLowerCase() === name))
      .sort((a, b) => b.startedAt - a.startedAt)[0]; // by name, only this project's
    return found ?? (() => { throw new Error(`No agent called "${ref}". list_agents shows who is on the board.`); })();
  };
  const myTaskId = async id => id || (await me())?.taskId || (() => { throw new Error('Give a task id (this session is not working on a task)'); })();
  const q = encodeURIComponent;
  // Changing a task answers with just this, not the whole task (its description and every note) read back.
  const brief = ({ id, status, title, branch }) => ({ id, status, title, branch: branch ?? null });

  const str = description => ({ type: 'string', description });
  const MODEL = { type: 'string', enum: ['fable', 'opus', 'sonnet', 'haiku', 'lighter', 'stronger'], description: 'Leave out to use their usual model. "lighter" or "stronger" is one step from their usual one (for "a light/fast/cheap model" or "a smarter/stronger one"); or name one: haiku for quick simple jobs, sonnet for everyday work, opus for the hardest, fable only for the very hardest and longest (twice the price of opus).' };
  const EFFORT = { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'lower', 'higher'], description: 'Leave out to use their usual effort. "lower" or "higher" is one step from it.' };
  const SPECIALIST = str('Name of a specialist from list_team to do it (they always run as Claude)');
  const tool = (name, description, properties, required, run) => ({ name, description, inputSchema: { type: 'object', properties, required }, run });

  const TOOLS = [
    tool('get_project', 'The project folder, and which session and task you are, if any.', {}, [], async () => {
      const self = await me();
      return { project: self?.project ?? null, you: self ?? 'not a Relay session' };
    }),
    tool('list_tasks', 'List tasks on the board, optionally only one status.', {
      status: { type: 'string', enum: ['todo', 'doing', 'review', 'done'] },
    }, [], async ({ status }) => {
      const tasks = await api('GET', '/api/tasks');
      return tasks.filter(t => !status || t.status === status)
        .map(({ id, title, status, agent, branch, sessionId, notes }) => ({ id, title, status, agent, branch, sessionId, comments: notes.length }));
    }),
    tool('create_task', 'Add a task to the To do column. Make the description self-contained: goal, files, how to check it works.', {
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
      return { ...brief(task), sessionId: s.id, model: s.model || null, effort: s.effort || null };
    }),
    tool('start_agent', 'Start a new agent with a first message, optionally a specialist from the team and a model. Give it a self-contained prompt: it can\'t see your conversation. A lead may start another lead (role "lead") for a separate goal.', {
      prompt: str('First message for the agent'), name: str('Pane title'), role: { type: 'string', enum: ['lead'] },
      agent: { type: 'string', enum: ['claude', 'codex', 'gemini', 'cursor'] }, worktree: { type: 'boolean' },
      specialist: SPECIALIST, model: MODEL, effort: EFFORT,
    }, ['prompt'], ({ prompt, name, role, agent, worktree, specialist, model, effort }) =>
      api('POST', '/api/sessions', { prompt, name, role, agent, worktree, specialist, model, effort, kind: 'agent' })), // Settings can turn this off
    tool('message_agent', 'Send a message to another agent, by name (like Christie) or session id. It is typed into their terminal, signed with your name, and the user sees it there; they can answer the same way. If no one by that name is running but they are on the team, a new one starts with your message. Only message another agent when the user asks you to, or your task clearly needs it, and make the message self-contained: they can\'t see your conversation.', {
      to: str('Their name (a specialist like Christie, or a pane title) or session id'), text: str('The message'),
      model: MODEL, effort: EFFORT,
    }, ['to', 'text'], ({ to, text, model, effort }) => api('POST', '/api/messages', { to, text, model, effort })),
    tool('read_agent_chat', 'Read another agent\'s conversation (what the user and they have said, and the tools they used) to get their context quickly. Shows the commands they ran and any PR links. Give their name or session id, or the id of a closed chat from list_agents; leave it out to read your own.', {
      agent: str('Their name, session id or closed chat id'), last: { type: 'number', description: 'How many of the latest messages (default 30)' },
    }, [], async ({ agent, last = 30 }) => {
      const n = Number(last) || 30;
      const chat = agent && (await api('GET', '/api/chats')).find(c => (c.id === agent || c.autoClosed === agent) && !c.sessionId); // a closed chat
      return api('GET', chat ? `/api/chats/${q(chat.id)}/chat?last=${n}` : `/api/sessions/${q((await who(agent)).id)}/chat?last=${n}`);
    }),
    tool('clone_agent', 'Start a copy of an agent (yourself, by default) that carries its whole conversation so far, to work on another part in parallel. It runs in the same folder, so agree who edits which files. Give it a self-contained first message saying which part is its own.', {
      agent: str('Who to copy: their name or session id (leave out to copy yourself)'), prompt: str('What the copy should do'), name: str('A name for the copy'),
    }, ['prompt'], async ({ agent, prompt, name }) => api('POST', `/api/sessions/${q((await who(agent)).id)}/clone`, { prompt, name })),
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
    tool('list_agents', 'List the agents and shells in this project with who they are, what each was asked, and their status: working, idle, needs-input or exited. Also the 20 most recent closed chats (status "closed", pane gone) whose conversation read_agent_chat can still read, e.g. to find what the user worked on earlier.', {}, [], async () => {
      const live = (await api('GET', '/api/sessions')).map(({ id, name, agent, kind, role, status, taskId, worktree, specialist, model, effort, asked, startedBy }) =>
        ({ id, name, agent: agent || kind, specialist: specialist ? `${specialist.name}, ${specialist.role}` : null, model: model || null, effort: effort || null,
          role, status, taskId, branch: worktree?.branch ?? null, asked: asked || null, startedBy: startedBy ? startedBy.name : 'the user' }));
      const closed = (await api('GET', '/api/chats')).filter(c => !c.sessionId).slice(0, 20) // newest first
        .map(({ id, title, agent, role, cwd, worktree, taskId, lastActiveAt }) =>
          ({ id, name: title, agent, role, status: 'closed', taskId, cwd, branch: worktree?.branch ?? null, lastActiveAt: new Date(lastActiveAt).toISOString() }));
      return [...live, ...closed];
    }),
    tool('read_agent_output', 'Read the last lines of another agent\'s terminal screen, in this project (not shells).', {
      id: str('Session id'), lines: { type: 'number', description: 'How many lines (default 60, max 500)' },
    }, ['id'], async ({ id, lines = 60 }) => (await api('GET', `/api/sessions/${q(id)}/output?lines=${lines}`)).text),
    tool('send_to_agent', 'Type plain text into another agent in this project, signed with your name, and press Enter. It can\'t type into shells, permission prompts or yourself.', {
      id: str('Session id'), text: str('What to type'),
    }, ['id', 'text'], ({ id, text }) => api('POST', `/api/sessions/${q(id)}/input`, { text })),
    tool('stop_agent', 'Stop an agent in this project and close its pane (not shells).', { id: str('Session id') }, ['id'],
      ({ id }) => api('DELETE', `/api/sessions/${q(id)}`)),
    tool('get_agent_diff', 'See what an agent in this project changed in its worktree, as a diff against where it branched.', {
      id: str('Session id'),
    }, ['id'], async ({ id }) => {
      const s = (await api('GET', '/api/sessions')).find(x => x.id === id) ?? (await api('GET', '/api/chats')).find(c => c.autoClosed === id); // a worker Relay closed
      if (!s) throw new Error('No such session');
      return (await api('GET', `/api/review/diff?worktree=${q(s.cwd)}`)).text;
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
      return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
    } catch (e) {
      return reply({ content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return error(-32601, `Method not found: ${method}`);
}
