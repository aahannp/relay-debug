// The app shell: the sidebar, projects, live updates from the server, the layout and shortcuts.
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
  if (!state.projects.length && state.layout !== 'thread') showWelcome(); // thread layout has its own empty state
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
  }
  renderToolbar();
  renderSide();
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

// ---------- Sidebar ----------
// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT © 2026 T3 Tools Inc. See NOTICE.
// T3's flat sidebar (components/Sidebar.tsx): a search row with a project filter, the open threads as cards, then the
// rest on folded shelves, a row of icons along the bottom, and a rail on its right edge that resizes it. ⌘B slides it
// off screen; the toggle stays fixed in the corner.
const side = document.querySelector('.side');
const sideBody = h('div', { class: 'side-body' });
const sideFoot = h('div', { class: 'side-foot' });
const verWrap = h('div', { class: 'side-ver' }, $('verPill')); // updates.js adds its DEBUG tag after the pill, so here too

function applySidebar() {
  const hidden = state.settings.sidebarHidden === true;
  document.querySelector('.app').classList.toggle('no-side', hidden);
  side.inert = hidden;
  $('sideToggle').replaceChildren(icon(hidden ? 'panelLeft' : 'panelLeftClose', 16));
  $('sideToggle').title = 'Toggle main sidebar (⌘B)';
  $('sideToggle').setAttribute('aria-label', 'Toggle main sidebar');
  $('sideToggle').setAttribute('aria-expanded', String(!hidden));
}
const toggleSidebar = () => actions.setSetting({ sidebarHidden: state.settings.sidebarHidden !== true });
actions.toggleSidebar = toggleSidebar;
on('settings', applySidebar);
on('settings', renderToolbar);
on('project', renderToolbar);

// Width: 256px, or what the rail was dragged to (208px up to the window less 640px). Double-click the rail to reset.
const SIDE_W = 'agent-desk:side-w';
const savedWidth = () => { try { return Number(localStorage.getItem(SIDE_W)) || 256; } catch { return 256; } };
const fitWidth = w => Math.round(Math.max(208, Math.min(w, innerWidth - 640)));
const setSideWidth = w => document.documentElement.style.setProperty('--side-w', `${fitWidth(w)}px`);
setSideWidth(savedWidth());
addEventListener('resize', () => setSideWidth(savedWidth()));
const rail = h('div', {
  class: 'side-rail', title: 'Drag to resize sidebar', 'aria-hidden': 'true',
  onPointerdown: e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const app = document.querySelector('.app');
    const from = side.offsetWidth - e.clientX;
    const move = ev => {
      setSideWidth(from + ev.clientX);
      try { localStorage.setItem(SIDE_W, String(fitWidth(from + ev.clientX))); } catch {}
    };
    rail.setPointerCapture(e.pointerId);
    app.classList.add('side-resizing');
    rail.addEventListener('pointermove', move);
    rail.addEventListener('lostpointercapture', () => { rail.removeEventListener('pointermove', move); app.classList.remove('side-resizing'); }, { once: true });
  },
  onDblclick: () => {
    try { localStorage.removeItem(SIDE_W); } catch {}
    setSideWidth(256);
  },
});

// The project filter: every thread, or one project's. Picking a project also makes it the current one.
const SCOPE = 'agent-desk:thread-scope';
let scope = (() => { try { return localStorage.getItem(SCOPE) ?? ''; } catch { return ''; } })();
const setScope = path => {
  scope = path;
  try { localStorage.setItem(SCOPE, scope); } catch {}
};
const scoped = () => (state.projects.some(p => p.path === scope) ? scope : '');
const inScope = path => (scoped() ? path === scoped() : state.projects.some(p => p.path === path));
on('project', () => scoped() && scoped() !== state.project && setScope(state.project)); // it follows the palette and ⌘-switches
const projectName = path => state.projects.find(p => p.path === path)?.name ?? baseName(path);
// T3's ProjectMonogram: the first letter on a faint square of its own colour.
const monogram = name => h('span', { class: 'monogram', 'aria-hidden': 'true' }, ([...String(name).trim()][0] ?? '?').toUpperCase());
// "now", "5m", "3h", "2d": T3's sidebar label, its " ago" trimmed.
const since = t => {
  if (!t) return '';
  const m = Math.floor((Date.now() - t) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

let query = ''; // the search box, lower-cased
const SHELVES = 'agent-desk:sidebar-shelves';
const shelves = (() => { try { return { settled: true, agents: false, ...JSON.parse(localStorage.getItem(SHELVES)) }; } catch { return { settled: true, agents: false }; } })();
const toggleShelf = key => {
  shelves[key] = !shelves[key];
  try { localStorage.setItem(SHELVES, JSON.stringify(shelves)); } catch {}
  renderSide();
};
const SETTLED_FIRST = 10, SETTLED_PAGE = 25; // T3's settled tail: 10, then 25 more a click
let settledShown = SETTLED_FIRST;
let section = 'general'; // the settings section the nav marks

// Chats an agent started and you haven't typed in: they stay on their own folded shelf.
const chatOf = s => state.chats.find(c => c.id === s.chatId);
const agentChat = c => Boolean(c?.startedBy && !c.talked);
const byAgent = s => agentChat(chatOf(s));

let sidebarDrag = false; // rebuilding the list mid-drag would detach the dragged row and lose its dragend
const drag = (type, id) => e => {
  e.dataTransfer.setData(type, id);
  e.dataTransfer.effectAllowed = 'move';
  sidebarDrag = true;
  e.currentTarget.addEventListener('dragend', () => { sidebarDrag = false; renderChrome(); }, { once: true });
};

// A thread in another project opens that project first, so its pane exists.
function openSession(s) {
  if (!openSpaces().includes(s.project)) {
    switchProject(s.project);
    return requestAnimationFrame(() => actions.focusSession(s.id));
  }
  actions.focusSession(s.id);
}
const who = s => s.specialist?.name ?? (s.role === 'lead' ? 'Lead' : s.kind === 'shell' ? 'Shell' : s.kind === 'browser' ? 'Browser' : state.agents.find(a => a.id === s.agent)?.name ?? s.agent);

// An open thread: T3's card row. Project and status on top, the title, then who runs it and on which branch.
function cardRow(s) {
  const status = actions.statusOf?.(s) ?? s.status;
  const off = actions.isHidden?.(s.id);
  const name = projectName(s.project);
  const current = actions.focusedSession?.() === s.id;
  const loud = status === 'working' || status === 'needs-input';
  return h('button', {
    class: `thread thread-card${current ? ' current' : ''}${off ? ' off' : ''}`, 'data-key': `s:${s.id}`, 'aria-current': current ? 'true' : null,
    'aria-label': `${chatTitle(s)}, ${name}, ${STATUS_LABEL[status] ?? status}${off ? ', hidden from the grid' : ''}`,
    title: off ? 'Hidden from the grid. Click to show it.' : s.cwd, draggable: true, onDragstart: drag(DRAG.pane, s.id),
    onClick: () => openSession(s), onContextmenu: e => chatMenu(e, chatOf(s)),
  },
    h('span', { class: 'thread-top' }, monogram(name), h('span', { class: 'thread-project' }, name),
      h('span', { class: `thread-status ${status}` }, h('span', { class: `dot ${status}` }), loud ? STATUS_LABEL[status] : since(chatOf(s)?.lastActiveAt ?? s.startedAt))),
    h('span', { class: 'thread-title' }, s.kind === 'shell' && icon('terminal', 13), h('span', {}, chatTitle(s))),
    h('span', { class: 'thread-meta' }, h('span', {}, who(s)), s.worktree?.branch && h('span', { class: 'thread-branch' }, icon('branch', 11), h('span', {}, s.worktree.branch)), off && icon('eyeOff', 12)));
}
// A slim row: an open thread on a shelf or in search results, or a closed one you can pick up again.
function slimSession(s) {
  const status = actions.statusOf?.(s) ?? s.status;
  return h('button', {
    class: 'thread slim', 'data-key': `s:${s.id}`, title: s.cwd, draggable: true, onDragstart: drag(DRAG.pane, s.id),
    onClick: () => openSession(s), onContextmenu: e => chatMenu(e, chatOf(s)),
  }, monogram(projectName(s.project)), h('span', { class: 'thread-title' }, chatTitle(s)), h('span', { class: `dot ${status}`, title: STATUS_LABEL[status] ?? '' }));
}
function slimChat(c) {
  return h('button', {
    class: `thread slim${c.folderMissing ? ' gone' : ''}`, 'data-key': `c:${c.id}`, draggable: !c.folderMissing, onDragstart: drag(DRAG.chat, c.id),
    title: c.folderMissing ? `Its folder is gone: ${c.cwd}` : `${c.title}\nClick or drag into the grid to ${c.resumable ? 'pick this thread up again' : 'start it again'}`,
    onClick: () => !c.folderMissing && actions.openChat(c.id), onContextmenu: e => chatMenu(e, c),
  }, monogram(projectName(c.project)), h('span', { class: 'thread-title' }, c.title), h('span', { class: 'thread-when' }, since(c.lastActiveAt)));
}
// T3's CollapsibleSectionHeader: a label, a hairline, a chevron.
const shelf = (key, label, count) => h('button', { class: 'shelf', 'data-key': `shelf:${key}`, 'aria-expanded': String(shelves[key]), onClick: () => toggleShelf(key) },
  h('span', {}, shelves[key] ? label : `${label} (${count})`), h('span', { class: 'shelf-rule', 'aria-hidden': 'true' }), icon('chevronDown', 12));

function threadList() {
  const order = actions.paneOrder?.() ?? [];
  const rank = s => order.indexOf(s.id) + 1 || Infinity;
  const open = state.sessions.filter(s => !s.exited && !s.artifactId && !s.drawerOf && inScope(s.project)).sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt);
  const openIds = new Set(state.sessions.map(s => s.chatId).filter(Boolean)); // a running chat isn't a closed one too
  const closed = state.chats.filter(c => !openIds.has(c.id) && inScope(c.project)).sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  if (query) {
    const hits = [...open.filter(s => chatTitle(s).toLowerCase().includes(query)).map(slimSession), ...closed.filter(c => c.title?.toLowerCase().includes(query)).map(slimChat)];
    return hits.length ? hits : [h('p', { class: 'side-empty', role: 'status' }, 'No threads found')];
  }
  const active = open.filter(s => !byAgent(s)).map(cardRow);
  const agents = [...open.filter(byAgent).map(slimSession), ...closed.filter(agentChat).map(slimChat)];
  const settled = closed.filter(c => !agentChat(c));
  if (!active.length && !agents.length && !settled.length) {
    return [h('div', { class: 'side-empty' }, state.projects.length ? (scoped() ? `No threads in ${projectName(scoped())} yet` : 'No threads yet') : [
      h('span', {}, 'No projects yet'),
      h('button', { class: 'side-empty-add', 'data-key': 'empty-add', onClick: () => addProject() }, icon('plus', 12), 'Add project'),
    ])];
  }
  const hidden = settled.length - settledShown;
  return [
    ...active,
    h('div', { class: 'shelves' },
      agents.length > 0 && [shelf('agents', 'Started by agents', agents.length), shelves.agents && agents],
      settled.length > 0 && [shelf('settled', 'Settled', settled.length), shelves.settled && [
        settled.slice(0, settledShown).map(slimChat),
        hidden > 0 && h('button', { class: 'thread slim more', 'data-key': 'more', onClick: () => { settledShown += SETTLED_PAGE; renderSide(); } },
          icon('plus', 16), `Show ${Math.min(hidden, SETTLED_PAGE)} more`),
      ]]),
  ];
}

// In Settings the list gives way to its sections (T3's settings sidebar), and the footer to Back. A search shows matching settings instead.
let setHits = null; // null: no query
const setKbd = h('kbd', { 'aria-hidden': 'true' }, '/');
const setSearch = h('input', {
  class: 'side-search-input', type: 'search', placeholder: 'Search', 'aria-label': 'Search settings', spellcheck: false,
  onInput: () => { const q = setSearch.value.trim().toLowerCase(); setHits = q ? settings.find(q) : null; setKbd.hidden = Boolean(setSearch.value); renderSide(); },
  onKeydown: e => {
    if (e.key === 'Escape' && setSearch.value) { e.preventDefault(); e.stopPropagation(); setSearch.value = ''; setSearch.dispatchEvent(new Event('input')); }
    else if (e.key === 'Enter') sideBody.querySelector('.side-row')?.click();
  },
});
const setHead = h('div', { class: 'side-head', hidden: true },
  h('div', { class: 'side-search', onClick: e => e.target === e.currentTarget && setSearch.focus() }, icon('search', 16), setSearch, setKbd));
document.addEventListener('keydown', e => { // "/" jumps to it, as in T3
  if (e.key !== '/' || e.metaKey || e.ctrlKey || current !== 'settings' || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  setSearch.focus();
});
const settingsHits = () => (setHits.length ? [h('nav', { class: 'side-sections', 'aria-label': 'Matching settings' }, setHits.map((x, i) => h('button', {
  class: 'side-row side-hit', 'data-key': `hit:${i}`, onClick: () => settings.reveal(x),
}, h('span', {}, x.title), h('span', { class: 'side-hit-sub' }, x.where))))] : [h('p', { class: 'side-empty', role: 'status' }, 'No settings found')]);
const settingsNav = () => (setHits ? settingsHits() : [h('nav', { class: 'side-sections', 'aria-label': 'Settings sections' }, settings.SECTIONS.map(x => h('button', {
  class: `side-row${x.id === section ? ' active' : ''}`, 'data-key': `section:${x.id}`, 'aria-current': x.id === section ? 'true' : null,
  onClick: () => { section = x.id; emit('settings:section', x.id); renderSide(); },
}, icon(x.icon, 16), h('span', {}, x.label))))]);

const footIcon = (name, label, onClick) => h('button', { class: 'icon-btn side-icon', 'data-key': `foot:${label}`, 'aria-label': label, title: label, onClick }, icon(name, 16));
function moreMenu(anchor) {
  const go = (id, ic) => ({ label: VIEWS.find(v => v.id === id).label, icon: ic, sub: `⌘${VIEWS.findIndex(v => v.id === id) + 1}`, onClick: () => showView(id) });
  menu(anchor, [
    go('review', 'branch'), go('files', 'file'), go('artifacts', 'layers'), go('shots', 'camera'), go('graph', 'graph'),
    'sep',
    state.layout === 'thread' ? { label: 'Grid view', icon: 'layoutGrid', onClick: () => actions.setLayout('grid') } : { label: 'Thread view', icon: 'squareMenu', onClick: () => actions.setLayout('thread') },
    { label: 'Voice input', icon: 'mic', sub: '⌘⇧M', onClick: () => actions.toggleVoice() },
    { label: 'Commands', icon: 'search', sub: '⌘K', onClick: () => actions.openPalette() },
  ]);
}
const footer = () => (current === 'agents' ? [
  footIcon('settings', 'Settings', () => showView('settings')),
  footIcon('board', 'Board', () => showView('board')),
  footIcon('chartBar', 'Usage', () => showView('spend')),
  footIcon('dots', 'More', e => moreMenu(e.currentTarget)),
] : [h('button', { class: 'side-row side-back', 'data-key': 'foot:back', onClick: () => showView('agents') }, icon('arrowLeft', 16), h('span', {}, 'Back'))]);

// This runs every second: rebuild only when what it shows changed (a rebuild mid-click loses the click), keeping focus.
let sideShown = '';
function renderSide() {
  if (sidebarDrag) return;
  sideHead.hidden = current === 'settings';
  setHead.hidden = current !== 'settings';
  const body = current === 'settings' ? settingsNav() : threadList();
  const foot = footer();
  const html = [...body, ...foot].map(n => n.outerHTML).join('');
  if (html === sideShown) return;
  sideShown = html;
  const focused = side.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const scrolled = sideBody.scrollTop;
  sideBody.replaceChildren(...body);
  sideFoot.replaceChildren(...foot, verWrap);
  sideBody.scrollTop = scrolled;
  if (focused) side.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

// The search row: T3's SidebarThreadHeader. Search, then the project filter, Add project and New thread.
const search = h('input', {
  class: 'side-search-input', type: 'search', placeholder: 'Search', 'aria-label': 'Search threads', spellcheck: false,
  onInput: () => { query = search.value.trim().toLowerCase(); clearSearch.hidden = !search.value; renderSide(); },
  onKeydown: e => {
    if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); clear(); }
    else if (e.key === 'Enter') sideBody.querySelector('.thread')?.click();
  },
});
const clear = () => { search.value = ''; query = ''; clearSearch.hidden = true; renderSide(); };
const clearSearch = h('button', { class: 'icon-btn side-clear', hidden: true, 'aria-label': 'Clear thread search', onClick: () => { clear(); search.focus(); } }, icon('x', 12));
const filterBtn = h('button', { class: 'icon-btn side-icon', 'aria-haspopup': 'menu', onClick: e => projectMenu(e.currentTarget) });
const addBtn = h('button', { class: 'icon-btn side-icon', 'aria-label': 'Add project', title: 'Add project', onClick: () => addProject() }, icon('folderPlus', 16));
const newBtn = h('button', { class: 'icon-btn side-icon', 'aria-label': 'New thread', title: 'New thread', onClick: () => actions.newChat(scoped() || state.project) }, icon('squarePen', 16));
const sideHead = h('div', { class: 'side-head' },
  h('div', { class: 'side-search', onClick: e => e.target === e.currentTarget && search.focus() }, icon('search', 16), search, clearSearch),
  h('div', { class: 'side-head-btns' }, filterBtn, addBtn, newBtn));
function renderHead() {
  const has = state.projects.length > 0;
  filterBtn.hidden = addBtn.hidden = !has;
  newBtn.disabled = !has;
  const name = scoped() && projectName(scoped());
  const label = name ? `Filter threads by project: ${name}` : 'Filter threads by project';
  if (filterBtn.title !== label) {
    filterBtn.title = label;
    filterBtn.setAttribute('aria-label', label);
    filterBtn.replaceChildren(name ? monogram(name) : icon('list', 16));
  }
}

// The filter's popup. Not ui.js's menu(): ⌘-click needs the click, to show a project beside the others in the grid.
function projectMenu(anchor) {
  document.querySelector('.menu')?.remove();
  const open = openSpaces();
  const close = () => { m.remove(); document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc, true); anchor.focus(); };
  const pick = (path, e) => {
    if (path && (e.metaKey || e.ctrlKey)) return toggleBeside(path);
    close();
    setScope(path);
    if (path) switchProject(path);
    renderHead();
    renderSide();
  };
  const item = (path, label, glyph, hint) => h('button', {
    class: `menu-item${scoped() === path ? ' sel' : ''}`, role: 'menuitemradio', 'aria-checked': String(scoped() === path), title: hint,
    onClick: e => pick(path, e), onContextmenu: e => path && spaceMenu(e, state.projects.find(p => p.path === path)),
  }, glyph, h('span', { class: 'grow' }, label), path && open.includes(path) && open.length > 1 && h('span', { class: 'sub', title: 'In the grid' }, icon('stack', 12)), scoped() === path && icon('check', 14));
  const m = h('div', { class: 'menu side-projects', role: 'menu', 'aria-label': 'Filter threads by project' },
    item('', 'All projects', icon('folder', 16)),
    h('div', { class: 'sep' }),
    state.projects.map(p => item(p.path, p.name, monogram(p.name), `${ltr(p.path.replace(state.info.home, '~'))}\n⌘-click to show it beside the others in the grid`)));
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 8)}px`;
  m.style.left = `${Math.max(8, Math.min(sideHead.getBoundingClientRect().left, innerWidth - m.offsetWidth - 8))}px`;
  const outside = e => !m.contains(e.target) && !document.querySelector('.menu:not(.side-projects)')?.contains(e.target) && close();
  const esc = e => e.key === 'Escape' && (e.stopPropagation(), close());
  setTimeout(() => { document.addEventListener('mousedown', outside); document.addEventListener('keydown', esc, true); });
  m.querySelector('.menu-item')?.focus();
}

function spaceMenu(e, p) {
  e.preventDefault();
  menu(e.currentTarget, [
    { label: 'New thread here', icon: 'squarePen', onClick: () => actions.newChat(p.path) },
    { label: 'Shell here', icon: 'terminal', onClick: () => actions.newSession({ project: p.path, kind: 'shell' }) },
    'sep',
    { label: 'Remove from the list', icon: 'x', onClick: () => removeProject(p.path) },
  ]);
}

function chatMenu(e, chat) {
  if (!chat) return;
  e.preventDefault();
  menu(e.currentTarget, [
    { label: chat.running ? 'Show' : 'Open', icon: 'play', disabled: chat.folderMissing, onClick: () => actions.openChat(chat.id) },
    { label: 'Rename…', icon: 'pen', onClick: guard(async () => {
      const title = await askText('Rename thread', { value: chat.title, ok: 'Rename', label: 'Leave it empty to use Claude\'s own title' });
      if (title !== null) await api('PATCH', `/api/chats/${encodeURIComponent(chat.id)}`, { title });
    }) },
    { label: 'Copy path', icon: 'copy', onClick: () => navigator.clipboard.writeText(chat.cwd ?? '').then(() => toast('Copied', 'ok')) },
    'sep',
    { label: 'Remove from the list', icon: 'trash', onClick: guard(async () => {
      if (chat.running && !(await confirmDialog(`Stop and remove "${chat.title}"?`, 'The agent is still running. This stops it and takes the thread off the list.', { label: 'Stop and remove', danger: true }))) return;
      await api('DELETE', `/api/chats/${encodeURIComponent(chat.id)}`);
      toast('Removed. Claude\'s own copy of the conversation is untouched.', 'ok');
    }) },
  ]);
}

// ---------- Chrome ----------
function renderChrome() {
  const project = state.projects.find(p => p.path === state.project);
  document.title = project ? `${project.name} · Relay` : 'Relay';
  renderHead();
  renderSide();
  renderStatus();
}

// The thin bar along the bottom (grid layout only; T3's thread layout has none): connection, what's running, guardrails.
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
on('project', renderChrome); // the new project lights up at once, not after the settings round trip
on('layout', renderSide);

function buildSidebar() {
  side.replaceChildren(side.querySelector('.side-top'), sideHead, setHead, sideBody, sideFoot, rail);
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
  if (!state.projects.length && state.layout !== 'thread') showWelcome(); // thread layout has its own empty state
})().catch(e => toast(`Relay could not start: ${e.message}`, 'error'));
