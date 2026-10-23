// The app shell: navigation, projects, live updates from the server, the layout and shortcuts.
import { state, api, h, icon, avatar, on, emit, toast, guard, actions, command, menu, modal, askText, confirmDialog, ago, baseName, ltr, projectSessions, projectTasks, projectChats, gridSessions, openSpaces, spaceSummary, chatTitle, DRAG, STATUS_LABEL } from './ui.js';
import { applyTheme } from './themes.js';
import * as agents from './agents.js';
import * as board from './board.js';
import * as files from './files.js';
import * as review from './review.js';
import * as graph from './graph.js';
import * as artifacts from './artifacts.js';
import * as shots from './shots.js';
import * as spend from './spend.js';
import * as settings from './settings.js';
import * as palette from './palette.js';
import * as diff from './diff.js';
import * as drawer from './drawer.js';
import './voice.js';
import './cursor.js';
import './updates.js';

if (navigator.userAgent.includes('Electron')) document.documentElement.classList.add('is-app');

const VIEWS = [
  { id: 'agents', label: 'Agents', icon: 'terminal', module: agents, hint: 'Every agent and shell, side by side' },
  { id: 'board', label: 'Board', icon: 'board', module: board, hint: 'Plan tasks and hand them to agents' },
  { id: 'files', label: 'Files', icon: 'file', module: files, hint: 'Browse and edit the project' },
  { id: 'review', label: 'Review', icon: 'branch', module: review, hint: 'Check what agents changed, then merge it' },
  { id: 'artifacts', label: 'Artifacts', icon: 'layers', module: artifacts, hint: 'Pages and reports your agents made' },
  { id: 'shots', label: 'Screenshots', icon: 'camera', module: shots, hint: 'Capture, mark up and hand to an agent' },
  { id: 'graph', label: 'Graph', icon: 'graph', module: graph, hint: 'Who is doing what, and who is talking to whom' },
  { id: 'spend', label: 'Spend', icon: 'dollar', module: spend, hint: 'What Claude Code cost each day, and where it went' },
  { id: 'settings', label: 'Settings', icon: 'settings', module: settings, hint: 'Themes, agents, voice and MCP' },
];
const $ = id => document.getElementById(id);
let current = '';
let live = false; // is the event stream from the server connected

// ---------- Live data ----------
const loaders = {
  sessions: async () => { state.sessions = await api('GET', '/api/sessions'); },
  tasks: async () => { state.tasks = await api('GET', '/api/tasks'); },
  projects: async () => { state.projects = await api('GET', '/api/projects'); },
  settings: async () => { state.settings = await api('GET', '/api/settings'); },
  chats: async () => { state.chats = await api('GET', '/api/chats'); },
  artifacts: async () => { [state.artifacts, state.artifactFolders] = await Promise.all([api('GET', '/api/artifacts'), api('GET', '/api/artifact-folders')]); },
  specialists: async () => { state.specialists = await api('GET', '/api/specialists'); },
};

// Refetch one kind of data. If more changes arrive mid-fetch, fetch once more so nothing stale sticks.
const inflight = new Map();
function refresh(kind) {
  const running = inflight.get(kind);
  if (running) {
    running.again = true;
    return running.promise;
  }
  const entry = { again: false };
  entry.promise = (async () => {
    do {
      entry.again = false;
      await loaders[kind]();
    } while (entry.again);
    inflight.delete(kind);
    loaded(kind);
  })().catch(e => {
    inflight.delete(kind);
    console.error(e);
  });
  inflight.set(kind, entry);
  return entry.promise;
}
actions.refresh = refresh;

function loaded(kind) {
  if (kind === 'settings' || kind === 'projects') {
    const before = state.project;
    pickProject();
    if (kind === 'settings') applyTheme();
    if (before !== state.project) emit('project');
  }
  emit(kind);
  renderChrome();
  if (!state.projects.length) showWelcome();
}

function listen() {
  const events = new EventSource('/api/events');
  events.onmessage = e => {
    const event = JSON.parse(e.data);
    if (['voice', 'update-progress', 'update-ready', 'agent-message', 'specialist-changed', 'groups', 'meter'].includes(event.type)) emit(event.type, event);
    else if (loaders[event.type]) refresh(event.type);
  };
  events.onopen = () => {
    live = true;
    Object.keys(loaders).forEach(refresh); // after a reconnect, catch up on everything
  };
  events.onerror = () => { live = false; renderStatus(); };
}

actions.setSetting = guard(async patch => {
  state.settings = await api('PATCH', '/api/settings', patch);
  loaded('settings');
});

// ---------- Views ----------
function showView(id) {
  const view = VIEWS.find(v => v.id === id) || VIEWS[0];
  if (current !== view.id) VIEWS.find(v => v.id === current)?.module.hide?.();
  current = view.id;
  for (const v of VIEWS) {
    $(`view-${v.id}`).classList.toggle('active', v.id === view.id);
    $(`nav-${v.id}`).classList.toggle('active', v.id === view.id);
  }
  renderToolbar();
  view.module.show?.();
}
actions.showView = showView;
actions.currentView = () => current;

// The top bar: on the left a view's own title() (a breadcrumb) or else its icon, name and hint; on the right its toolbar().
const crumbs = [...$('crumbs').children];
function renderToolbar() {
  const view = VIEWS.find(v => v.id === current);
  if (!view) return;
  const title = view.module.title?.();
  if (title) $('crumbs').replaceChildren(...[title].flat());
  else {
    $('crumbs').replaceChildren(...crumbs);
    $('viewIcon').replaceChildren(icon(view.icon, 16));
    $('viewTitle').textContent = view.label;
    $('viewHint').textContent = view.hint;
  }
  $('viewActions').replaceChildren(...(view.module.toolbar?.() ?? []));
}
actions.renderToolbar = renderToolbar;

// Thread (one chat at a time, like T3) or grid (every pane side by side). Kept per window in localStorage, since the
// server's settings drop keys they don't know.
const LAYOUT = 'agent-desk:layout';
state.layout = (() => { try { return localStorage.getItem(LAYOUT) === 'grid' ? 'grid' : 'thread'; } catch { return 'thread'; } })();
function setLayout(layout) {
  state.layout = layout === 'grid' ? 'grid' : 'thread';
  try { localStorage.setItem(LAYOUT, state.layout); } catch {}
  applyLayout();
  emit('layout', state.layout);
}
const applyLayout = () => {
  const app = document.querySelector('.app');
  app.classList.toggle('layout-thread', state.layout === 'thread');
  app.classList.toggle('layout-grid', state.layout === 'grid');
};
actions.setLayout = setLayout;
applyLayout();

// Hiding the sidebar gives the panes the whole window. ⌘B, the button in the top bar, or Settings.
function applySidebar() {
  const hidden = state.settings.sidebarHidden === true;
  document.querySelector('.app').classList.toggle('no-side', hidden);
  $('sideToggle').replaceChildren(icon('sidebar', 16));
  $('sideToggle').title = `${hidden ? 'Show' : 'Hide'} the sidebar (⌘B)`;
}
const toggleSidebar = () => actions.setSetting({ sidebarHidden: state.settings.sidebarHidden !== true });
actions.toggleSidebar = toggleSidebar;
on('settings', applySidebar);
on('settings', renderToolbar);
on('project', renderToolbar);

// ---------- Sidebar ----------
function renderChrome() {
  const project = state.projects.find(p => p.path === state.project);
  document.title = project ? `${project.name} · Relay` : 'Relay';

  const sessions = gridSessions();
  const live = sessions.filter(s => !s.exited);
  const waiting = sessions.filter(s => s.status === 'needs-input').length;
  const counts = {
    agents: waiting ? h('span', { class: 'count attn', title: 'Waiting for you' }, waiting) : live.length ? h('span', { class: 'count' }, live.length) : null,
    board: (() => { const n = projectTasks().filter(t => t.status !== 'done').length; return n ? h('span', { class: 'count' }, n) : null; })(),
    review: (() => { const n = projectTasks().filter(t => t.status === 'review').length; return n ? h('span', { class: 'count attn' }, n) : null; })(),
  };
  for (const v of VIEWS) {
    const btn = $(`nav-${v.id}`);
    btn.querySelector('.count')?.remove();
    if (counts[v.id]) btn.append(counts[v.id]);
  }

  renderSpaces();
  renderChats(sessions);
  renderStatus();
}

// Spaces: every project folder, with who's running in it. Click one to go there; open it to see its agents.
const EXPANDED = 'agent-desk:expanded-spaces';
const expanded = new Set((() => { try { return JSON.parse(localStorage.getItem(EXPANDED)) ?? []; } catch { return []; } })());
let revealSpace = null; // a space to scroll into view on the next build: the one just opened, or the current one at start
const AGENT_CHATS = 'agent-desk:agent-started-chats-open';
let agentChatsOpen = (() => { try { return localStorage.getItem(AGENT_CHATS) === '1'; } catch { return false; } })();
const toggleExpanded = path => {
  expanded.has(path) ? expanded.delete(path) : (expanded.add(path), (revealSpace = path));
  try { localStorage.setItem(EXPANDED, JSON.stringify([...expanded])); } catch {}
  renderChrome(); // Chats too: it leaves out what the current space now shows
};
// Chats an agent started and you haven't typed in: they stay off the left, except in one folded group.
const chatOf = s => state.chats.find(c => c.id === s.chatId);
const byAgent = s => { const c = chatOf(s); return Boolean(c?.startedBy && !c.talked); };
const showsAgentsOf = path => path === state.project && expanded.has(path);

let spacesShown = '';
function renderSpaces() {
  const el = $('spaces');
  const list = state.projects.map(p => {
    const agents = state.sessions.filter(s => s.project === p.path && !s.exited && !s.artifactId && !s.drawerOf);
    return { p, agents, shown: agents.filter(s => !byAgent(s)), statuses: agents.map(s => actions.statusOf?.(s) ?? s.status) };
  });
  // This runs every second: rebuild only on a real change (a rebuild mid-click loses the click), and keep keyboard focus.
  const open = openSpaces();
  const now = JSON.stringify([open, [...expanded], list.map(d => [d.p.path, d.p.name, d.statuses, d.agents.map(s => [s.id, chatTitle(s), s.cwd, byAgent(s)])])]);
  if (now === spacesShown) return;
  if (!spacesShown) revealSpace = state.project;
  spacesShown = now;
  const focused = el.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const scrolled = el.scrollTop; // emptying the list would reset it
  el.replaceChildren(...list.map(({ p, agents, shown, statuses }, i) => {
    const waiting = statuses.filter(x => x === 'needs-input').length;
    const isOpen = expanded.has(p.path);
    const current = p.path === state.project;
    const beside = open.includes(p.path);
    const summary = spaceSummary(agents.length, waiting);
    return h('div', { class: `space${current ? ' current' : ''}${beside ? ' beside' : ''}`, role: 'listitem', 'data-path': p.path },
      h('div', { class: 'space-row' },
        h('button', { class: `icon-btn sm space-chev${isOpen ? ' open' : ''}`, 'data-key': `chev:${p.path}`, 'aria-expanded': String(isOpen), 'aria-controls': `space-${i}`,
          'aria-label': `Show agents in ${p.name}`, title: isOpen ? 'Hide agents' : 'Show agents', onClick: () => toggleExpanded(p.path) }, icon('chevronRight', 12)),
        h('button', { class: 'space-main', 'data-key': `main:${p.path}`, 'aria-current': current ? 'true' : null, title: `${ltr(p.path.replace(state.info.home, '~'))}\n⌘-click to show it beside the others`,
          'aria-label': `${p.name}, ${summary}`, onClick: e => (e.metaKey || e.ctrlKey ? toggleBeside(p.path) : switchProject(p.path)), onContextmenu: e => spaceMenu(e, p) },
          h('span', { class: `dot ${waiting ? 'needs-input' : statuses.includes('working') ? 'working' : statuses.length ? 'idle' : 'exited'}` }),
          h('span', { class: 'space-name' }, p.name),
          h('span', { class: `space-sum${waiting ? ' attn' : ''}` }, summary)),
        h('button', { class: 'icon-btn sm space-beside', 'data-key': `beside:${p.path}`, 'aria-pressed': String(beside), hidden: current && open.length < 2,
          'aria-label': `Show ${p.name} beside`, title: beside ? `Hide ${p.name} from the grid` : `Show ${p.name} beside the others in the grid`,
          onClick: () => toggleBeside(p.path) }, icon('stack', 13)),
        h('button', { class: 'icon-btn sm', 'data-key': `add:${p.path}`, 'aria-label': `New agent in ${p.name}`, title: `New agent in ${p.name}`,
          onClick: () => actions.newSession({ project: p.path }) }, icon('plus', 13))),
      h('div', { class: 'space-agents', id: `space-${i}`, hidden: !isOpen },
        ...(shown.length ? agents.map((s, j) => !byAgent(s) && h('button', { class: 'run-item', 'data-key': `agent:${s.id}`, title: s.cwd, onClick: () => actions.focusSession(s.id) },
          h('span', { class: `dot ${statuses[j]}`, title: STATUS_LABEL[statuses[j]] ?? '' }), avatar(s, true), h('span', { class: 'name' }, chatTitle(s)))).filter(Boolean)
          : [h('div', { class: 'run-empty' }, 'Nothing running')])));
  }), h('button', { class: 'run-item space-new', 'data-key': 'new', onClick: () => addProject() }, icon('plus', 13), h('span', { class: 'name' }, 'New space')));
  el.scrollTop = scrolled;
  if (focused) el.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  const show = revealSpace && el.querySelector(`.space[data-path="${CSS.escape(revealSpace)}"]`);
  revealSpace = null;
  if (show) { // as much of it as fits, never scrolling its header out of view
    const top = show.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTop = Math.min(top, Math.max(el.scrollTop, top + show.offsetHeight - el.clientHeight));
  }
}

function spaceMenu(e, p) {
  e.preventDefault();
  menu(e.currentTarget, [
    { label: 'New agent here', icon: 'plus', onClick: () => actions.newSession({ project: p.path }) },
    { label: 'Shell here', icon: 'terminal', onClick: () => actions.newSession({ project: p.path, kind: 'shell' }) },
    'sep',
    { label: 'Remove from the list', icon: 'x', onClick: () => removeProject(p.path) },
  ]);
}

// Sidebar chats: what's open now, then earlier chats you can click or drag into the grid to pick up again.
let sidebarDrag = false; // rebuilding the list mid-drag would detach the dragged button and lose its dragend

function renderChats(unordered) {
  if (sidebarDrag) return;
  const order = actions.paneOrder?.() ?? [];
  const listed = unordered.filter(s => !s.exited && !s.artifactId && showsAgentsOf(s.project) && !byAgent(s));
  const unlisted = unordered.filter(s => !listed.includes(s));
  const sessions = unlisted.filter(s => !byAgent(s)).sort((a, b) => (order.indexOf(a.id) + 1 || Infinity) - (order.indexOf(b.id) + 1 || Infinity));
  const openIds = new Set(unordered.map(s => s.chatId).filter(Boolean)); // all of them: a listed agent's chat isn't "Recent" either
  const recent = projectChats().filter(c => !openIds.has(c.id) && !(c.startedBy && !c.talked)).slice(0, 40);
  const drag = (type, id) => e => {
    e.dataTransfer.setData(type, id);
    e.dataTransfer.effectAllowed = 'move';
    sidebarDrag = true;
    e.currentTarget.addEventListener('dragend', () => { sidebarDrag = false; renderChrome(); }, { once: true });
  };
  const item = s => h('button', {
    class: `run-item${actions.isHidden?.(s.id) ? ' off' : ''}`, title: actions.isHidden?.(s.id) ? 'Hidden from the grid. Click to show it.' : s.cwd,
    'aria-label': actions.isHidden?.(s.id) ? `${chatTitle(s)}, hidden` : null, draggable: true, onDragstart: drag(DRAG.pane, s.id),
    onClick: () => actions.focusSession(s.id),
    onContextmenu: e => s.chatId && chatMenu(e, state.chats.find(c => c.id === s.chatId)),
  }, h('span', { class: `dot ${actions.statusOf?.(s) ?? s.status}` }), avatar(s, true), h('span', { class: 'name' }, chatTitle(s)), actions.isHidden?.(s.id) && icon('eyeOff', 12));
  const open = sessions.map(item);
  const earlierItem = c => h('button', {
    class: `run-item chat${c.folderMissing ? ' gone' : ''}`, draggable: !c.folderMissing, onDragstart: drag(DRAG.chat, c.id),
    title: c.folderMissing ? `Its folder is gone: ${c.cwd}` : `Click or drag into the grid to ${c.resumable ? 'pick this chat up again' : 'start it again'}`,
    onClick: () => !c.folderMissing && actions.openChat(c.id),
    onContextmenu: e => chatMenu(e, c),
  }, h('span', { class: 'dot exited' }), avatar(c, true), h('span', { class: 'name' }, c.title), h('span', { class: 'when' }, ago(c.lastActiveAt).replace(' ago', '')));
  const earlier = recent.map(earlierItem);
  const agentOnes = [
    ...unlisted.filter(byAgent).map(item),
    ...projectChats().filter(c => c.startedBy && !c.talked && !openIds.has(c.id)).slice(0, 40).map(earlierItem),
  ];
  $('running').replaceChildren(
    ...(open.length ? open : [h('div', { class: 'run-empty' }, listed.length ? `Open ones are under ${baseName(state.project)}` : 'Nothing open')]),
    ...(earlier.length ? [h('div', { class: 'side-label sub' }, 'Recent'), ...earlier] : []),
    ...(agentOnes.length ? [
      h('button', { class: 'side-label sub side-fold', 'aria-expanded': String(agentChatsOpen), onClick: () => {
        agentChatsOpen = !agentChatsOpen;
        try { localStorage.setItem(AGENT_CHATS, agentChatsOpen ? '1' : '0'); } catch {}
        renderChrome();
      } }, `${agentChatsOpen ? '▾' : '▸'} Started by agents (${agentOnes.length})`),
      ...(agentChatsOpen ? agentOnes : []),
    ] : []));
}

function chatMenu(e, chat) {
  if (!chat) return;
  e.preventDefault();
  menu(e.currentTarget, [
    { label: chat.running ? 'Show' : 'Open', icon: 'play', disabled: chat.folderMissing, onClick: () => actions.openChat(chat.id) },
    { label: 'Rename…', icon: 'pen', onClick: guard(async () => {
      const title = await askText('Rename chat', { value: chat.title, ok: 'Rename', label: 'Leave it empty to use Claude\'s own title' });
      if (title !== null) await api('PATCH', `/api/chats/${encodeURIComponent(chat.id)}`, { title });
    }) },
    'sep',
    { label: 'Remove from the list', icon: 'trash', onClick: guard(async () => {
      if (chat.running && !(await confirmDialog(`Stop and remove "${chat.title}"?`, 'The agent is still running. This stops it and takes the chat off the list.', { label: 'Stop and remove', danger: true }))) return;
      await api('DELETE', `/api/chats/${encodeURIComponent(chat.id)}`);
      toast('Removed. Claude\'s own copy of the conversation is untouched.', 'ok');
    }) },
  ]);
}

// The thin bar along the bottom: connection, what's running, and the guardrails in force.
const PERMISSION_NAMES = { default: 'Ask me', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan only' };
function renderStatus() {
  const sessions = gridSessions();
  const running = sessions.filter(s => !s.exited);
  const waiting = sessions.filter(s => s.status === 'needs-input');
  const busy = running.filter(s => actions.statusOf?.(s) === 'working');
  $('statusBar').replaceChildren(...[
    h('span', {}, h('i', { class: `live-dot${live ? '' : ' off'}` }), live ? 'Live' : 'Reconnecting…'),
    h('span', {}, icon('terminal', 12), `${running.length} running`),
    busy.length > 0 && h('span', {}, icon('zap', 12), `${busy.length} ${STATUS_LABEL.working.toLowerCase()}`),
    waiting.length > 0 && h('span', { class: 'warn' }, icon('alert', 12), `${waiting.length} waiting for you`),
    h('span', {}, icon('board', 12), `${projectTasks().filter(t => t.status === 'doing').length} in progress`),
    h('span', { class: 'grow' }),
    h('span', { title: 'What Claude agents may do without asking' }, icon('shield', 12), PERMISSION_NAMES[state.settings.permissionMode] ?? 'Ask me'),
    h('span', {}, icon('sparkles', 12), state.theme?.name ?? ''),
    h('span', {}, h('kbd', {}, '⌘K'), 'commands'),
  ].filter(Boolean));
}
on('tick', renderChrome);
on('project', renderChrome); // the new space lights up at once, not after the settings round trip

function buildSidebar() {
  $('nav').replaceChildren(...VIEWS.map((v, i) => h('button', { class: 'nav-item', id: `nav-${v.id}`, title: `${v.label} (⌘${i + 1})`, onClick: () => showView(v.id) },
    icon(v.icon), h('span', {}, v.label))));
  const voice = $('voiceBtn');
  voice.querySelector('.mic').replaceWith(icon('mic', 15));
  voice.onclick = () => actions.toggleVoice();
  const paletteBtn = $('paletteBtn');
  paletteBtn.querySelector('.search').replaceWith(icon('search', 15));
  paletteBtn.onclick = () => actions.openPalette();
}

// ---------- Projects ----------
// Each window keeps its own project in its address (?project=), so reloads keep it and windows don't follow each
// other. lastProject is only where the next window or launch starts.
function pickProject(path = state.project || new URLSearchParams(location.search).get('project')) {
  const known = p => p && state.projects.some(x => x.path === p);
  state.project = [path, state.settings.lastProject, state.projects[0]?.path].find(known) || '';
  const url = new URL(location.href);
  url.searchParams.set('project', state.project);
  history.replaceState(null, '', url);
}
// The spaces open side by side in the Agents grid; the first is the current one (Board, Review and new agents use it).
function showSpaces(list) {
  const before = state.project;
  pickProject(list[0]);
  const open = [...new Set([state.project, ...list])];
  state.settings.openSpaces = open; // now, so the grid redraws once with the new project; the server keeps it
  if (before !== state.project) emit('project');
  actions.setSetting({ lastProject: state.project, openSpaces: open }); // re-renders the sidebar too
}
actions.showSpaces = showSpaces;
const switchProject = path => showSpaces([path]); // a plain click on a space: just that one
actions.switchProject = switchProject;
// Show a space beside the open ones, or hide it again (the last one stays).
function toggleBeside(path) {
  const open = openSpaces();
  if (!open.includes(path)) showSpaces([...open, path]);
  else if (open.length > 1) showSpaces(open.filter(p => p !== path));
}

// A folder input that suggests folders as you type.
function folderField(onSubmit) {
  const input = h('input', { class: 'input mono', placeholder: '~/code/my-app', spellcheck: false, value: '~/' });
  const list = h('div', { class: 'suggest' });
  const suggest = async () => {
    const found = await api('GET', `/api/fs/suggest?prefix=${encodeURIComponent(input.value)}`).catch(() => []);
    list.replaceChildren(...found.slice(0, 12).map(p => h('button', { onClick: () => { input.value = `${p}/`; input.focus(); suggest(); } }, baseName(p))));
  };
  input.addEventListener('input', suggest);
  input.addEventListener('keydown', e => e.key === 'Enter' && onSubmit(input.value));
  setTimeout(suggest);
  return { input, el: h('div', {}, input, list) };
}

const openProject = guard(async path => {
  const { path: added } = await api('POST', '/api/projects', { path: path.replace(/\/+$/, '') || path });
  await Promise.all([refresh('projects'), refresh('settings')]);
  switchProject(added);
  document.querySelector('.welcome')?.remove();
  toast(`Opened ${baseName(state.project)}`, 'ok');
  return true;
});
actions.openProject = openProject;

// Adding a folder switches to it; `then` gets its path (the Agents menu starts an agent there).
function addProject(then) {
  let close;
  const add = async value => Boolean(await openProject(value)) && (then?.(state.project), true);
  const field = folderField(async value => (await add(value)) && close());
  close = modal({
    title: 'Add a project folder', width: 520,
    body: [h('p', { class: 'muted' }, 'Agents start in this folder. A git repository lets each agent work in its own worktree.'), field.el],
    actions: [{ label: 'Cancel' }, { label: 'Add project', primary: true, onClick: () => add(field.input.value) }],
  });
}
actions.addProject = addProject;

const removeProject = guard(async (path = state.project) => {
  await api('DELETE', `/api/projects?path=${encodeURIComponent(path)}`);
  toast('Removed from the list. No files were touched.', 'ok');
});
actions.removeProject = removeProject;

// A new chat in a project. For now the same as a new agent; the thread view may replace it.
actions.newChat ??= project => actions.newSession({ project });

function showWelcome() {
  if (document.querySelector('.welcome')) return;
  const field = folderField(openProject);
  const feature = (name, text) => h('span', {}, icon(name, 14), text);
  document.body.append(h('div', { class: 'welcome' }, h('div', { class: 'welcome-card' },
    document.querySelector('.logo').cloneNode(true),
    h('h1', {}, 'Run a team of ', h('em', {}, 'coding agents'), '.'),
    h('p', {}, 'Relay runs Claude Code and other coding agents side by side, each in a real terminal using your own login. Pick the project folder to start.'),
    field.el,
    h('div', { class: 'row', style: { marginTop: '16px' } }, h('button', { class: 'btn primary', onClick: () => openProject(field.input.value) }, icon('folder', 15), 'Open folder')),
    h('div', { class: 'features' },
      feature('terminal', 'Up to 16 agents at once'), feature('star', 'A lead agent that splits the work'),
      feature('board', 'Task board agents update'), feature('branch', 'Worktrees, diffs and merge'),
      feature('mic', 'Voice input'), feature('camera', 'Screenshots for agents')))));
  setTimeout(() => field.input.focus());
}

document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && !e.shiftKey && key === 'k') { e.preventDefault(); e.stopPropagation(); actions.openPalette(); }
  else if (mod && e.shiftKey && key === 'm') { e.preventDefault(); e.stopPropagation(); actions.toggleVoice(); }
  else if (mod && !e.shiftKey && !e.altKey && key === 'b') { e.preventDefault(); e.stopPropagation(); toggleSidebar(); }
  else if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); showView(VIEWS[Number(e.key) - 1].id); }
}, true);

command('New task', () => { showView('board'); actions.newTask?.(); }, { icon: 'plus' });
command('Show or hide the sidebar', () => toggleSidebar(), { icon: 'sidebar', sub: '⌘B' });
$('sideToggle').addEventListener('click', () => toggleSidebar());
command('New space (add a project folder)', () => addProject(), { icon: 'folder' });

// ---------- Start ----------
(async () => {
  applyTheme();
  [state.info, state.agents] = await Promise.all([api('GET', '/api/info'), api('GET', '/api/agents')]);
  await Promise.all(Object.values(loaders).map(load => load()));
  pickProject();
  applyTheme();

  const views = $('views');
  for (const v of VIEWS) {
    const section = h('section', { class: 'view', id: `view-${v.id}` });
    views.append(section);
    v.module.mount(section);
  }
  palette.mount(VIEWS);
  diff.mount($('diffPanel'));
  drawer.mount($('drawer'));
  buildSidebar();
  showView('agents');
  for (const kind of ['project', 'settings', 'projects', 'tasks', 'sessions', 'chats', 'artifacts', 'specialists']) emit(kind);
  renderChrome();
  listen();
  setInterval(() => refresh('sessions'), 4000); // keeps "working / idle" fresh for the board and agents
  setInterval(() => refresh('chats'), 15000); // picks up the titles Claude gives chats as they go
  if (!state.projects.length) showWelcome();
})().catch(e => toast(`Relay could not start: ${e.message}`, 'error'));
