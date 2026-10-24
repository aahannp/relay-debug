// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT © 2026 T3 Tools Inc. See NOTICE.
// The terminal drawer under the chat (#drawer), after T3's ThreadTerminalDrawer: each thread has its own shells, started
// in the thread's folder (or worktree) with POST /api/sessions { alongside }. They're ordinary terminal panes, docked
// here with actions.dockPane, and stay mounted (just hidden) while you're on another thread or the drawer is closed.
import { state, actions, api, guard, h, icon, on, toast, command } from './ui.js';

const HEIGHT = 'agent-desk:drawer-h';
const OPEN = 'agent-desk:drawer-open'; // the chats whose drawer is open
const MIN = 180;
const stored = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const opened = new Set(stored(OPEN, []));
const active = new Map(); // chat id -> the shell shown in its drawer
const starting = new Set(); // chats whose first shell is on its way
const failed = new Set(); // chats whose last shell failed to start: no retry on every focus change until ⌘J or New terminal
let root, host, cluster, side, list;
let thread = null; // the chat id of the thread whose drawer shows
let height = stored(HEIGHT, 280);

const clamp = px => Math.round(Math.min(Math.max(px, MIN), Math.max(MIN, innerHeight * 0.75)));
const threadSession = chat => state.sessions.find(s => s.chatId === chat && !s.exited) ?? state.sessions.find(s => s.chatId === chat);
const shellsOf = chat => state.sessions.filter(s => s.drawerOf === chat);
// The thread you're on: the one whose chat (or drawer) has focus. Anything else, like a grid shell, keeps the last one.
function currentThread() {
  const s = state.sessions.find(x => x.id === actions.focusedSession?.());
  const chat = s?.drawerOf ?? (s?.kind === 'agent' ? s.chatId : null);
  return chat ?? (threadSession(thread) ? thread : null);
}

export function mount(el) {
  root = el;
  host = h('div', { class: 'drawer-terms' });
  const btn = (name, label, onClick) => h('button', { type: 'button', class: 'drawer-btn', title: label, 'aria-label': label, onClick }, icon(name, 13));
  const tools = () => [btn('plus', 'New Terminal', () => { failed.delete(thread); addShell(thread); }), btn('trash', 'Close Terminal', () => closeShell(active.get(thread)))];
  cluster = h('div', { class: 'drawer-cluster' }, ...tools().flatMap((b, i) => (i ? [h('span', { class: 'drawer-sep' }), b] : [b])));
  list = h('div', { class: 'drawer-list', role: 'tablist', 'aria-label': 'Terminals', 'aria-orientation': 'vertical' });
  side = h('aside', { class: 'drawer-side' }, h('div', { class: 'drawer-side-head' }, ...tools()), list);
  const grip = h('div', { class: 'drawer-grip', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize the terminal', tabindex: 0 });
  resizable(grip);
  root.setAttribute('aria-label', 'Terminal');
  root.append(grip, cluster, h('div', { class: 'drawer-body' }, host, side));
  root.style.height = `${clamp(height)}px`;

  actions.toggleDrawer = toggle;
  command('Toggle terminal', toggle, { icon: 'terminalSquare', sub: '⌘J' });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') { e.preventDefault(); e.stopPropagation(); toggle(); }
  }, true);
  // Focus moving to another thread's pane switches drawers (agents.js marks the pane focused on focusin first).
  document.addEventListener('focusin', () => render());
  on('sessions', () => render());
  addEventListener('resize', () => { root.style.height = `${clamp(height)}px`; });
}

function toggle() {
  const chat = currentThread();
  if (!chat) return toast('Open a thread first, then ⌘J opens its terminal');
  const open = !opened.has(chat);
  failed.delete(chat);
  opened[open ? 'add' : 'delete'](chat);
  store(OPEN, [...opened]);
  if (!open && root.contains(document.activeElement)) {
    const s = threadSession(chat);
    if (s) actions.focusSession(s.id); // back to the chat, not lost on the page
  }
  render(open);
}

function render(focus = false) {
  thread = currentThread();
  const open = Boolean(thread && opened.has(thread));
  root.hidden = !open;
  if (!open) return;
  const shells = shellsOf(thread);
  if (!shells.length) return failed.has(thread) || addShell(thread);
  if (!shells.some(s => s.id === active.get(thread))) active.set(thread, shells.at(-1).id);
  const current = active.get(thread);
  for (const s of shells) actions.dockPane(s, host, focus && s.id === current);
  // Every drawer's panes live in this one host; only the current thread's chosen shell shows.
  for (const el of host.children) el.classList.toggle('drawer-off', el.dataset.id !== current);
  const many = shells.length > 1;
  cluster.hidden = many;
  side.hidden = !many;
  // T3's rows: the terminal icon turns into an X on hover (or focus) and closes that terminal; the name picks it.
  list.replaceChildren(...(many ? shells.map((s, i) => h('div', { class: 'drawer-tab', role: 'presentation', 'aria-selected': String(s.id === current) },
    h('button', { type: 'button', class: 'drawer-tab-close', title: `Close Terminal ${i + 1}`, 'aria-label': `Close Terminal ${i + 1}`, onClick: () => closeShell(s.id) },
      icon('terminalSquare', 12), icon('x', 12)),
    h('button', { type: 'button', role: 'tab', class: 'drawer-tab-name', 'aria-selected': String(s.id === current), title: s.cwd,
      onClick: () => { active.set(thread, s.id); render(true); } }, h('span', {}, `Terminal ${i + 1}`)))) : []));
}

const addShell = guard(async chat => {
  const s = threadSession(chat);
  if (!s || starting.has(chat)) return;
  starting.add(chat);
  try {
    const shell = await api('POST', '/api/sessions', { kind: 'shell', project: s.project, alongside: s.id, name: 'Terminal' });
    active.set(chat, shell.id);
    await actions.refresh('sessions');
  } catch (e) {
    failed.add(chat);
    throw e;
  } finally {
    starting.delete(chat);
  }
  render(true);
});

// Like T3, closing a terminal doesn't ask. Closing the last one closes the drawer; the next ⌘J starts a fresh shell.
const closeShell = guard(async id => {
  if (!id) return;
  const chat = thread;
  await api('DELETE', `/api/sessions/${id}`);
  if (active.get(chat) === id) active.delete(chat); // closing another row keeps the one you're on
  if (shellsOf(chat).length <= 1) {
    opened.delete(chat);
    store(OPEN, [...opened]);
  }
  await actions.refresh('sessions');
  render(true);
});

// Drag the top edge (or use the arrow keys on it): 180px up to 75% of the window, remembered in this browser.
function resizable(grip) {
  const set = px => { height = clamp(px); root.style.height = `${height}px`; };
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const [y0, h0] = [e.clientY, root.offsetHeight];
    const move = ev => set(h0 + y0 - ev.clientY);
    const up = () => { grip.removeEventListener('pointermove', move); store(HEIGHT, height); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('lostpointercapture', up, { once: true });
  });
  grip.addEventListener('keydown', e => {
    const step = { ArrowUp: 20, ArrowDown: -20 }[e.key];
    if (!step) return;
    e.preventDefault();
    set(height + step);
    store(HEIGHT, height);
  });
}
