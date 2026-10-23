// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT © 2026 T3 Tools Inc. See NOTICE.
// The command palette (⌘K). With no query: Actions and Recent threads. Typing searches every action,
// project, page, theme and thread. Start with ">" to search actions only.
import { state, h, icon, actions, commands, openSpaces, gridSessions, baseName, ago, chatTitle } from './ui.js';
import { THEMES } from './themes.js';

let VIEWS = [];
export function mount(views) {
  VIEWS = views;
  actions.openPalette = openPalette;
}

const view = id => () => actions.showView(id);
const projectName = path => state.projects.find(p => p.path === path)?.name ?? baseName(path);

// The few actions shown with no query. One that wraps a registered command takes that command's place in search.
function topActions(used) {
  const cmd = (title, over) => {
    const c = commands.find(x => x.title === title);
    if (c) used.add(c);
    return c && { ...c, ...over };
  };
  const grid = state.layout === 'grid';
  return [
    { title: 'New thread', icon: 'squarePen', run: () => actions.newChat(state.project) },
    cmd('New shell', { icon: 'terminalSquare' }),
    cmd('New space (add a project folder)', { title: 'Add project', icon: 'folderPlus' }),
    { title: 'Toggle terminal', icon: 'panelBottom', kbd: '⌘J', run: () => actions.toggleDrawer() },
    { title: 'Toggle diff', icon: 'fileDiff', kbd: '⌘D', run: () => actions.toggleDiff() },
    { title: grid ? 'Thread view' : 'Grid view', icon: grid ? 'squareMenu' : 'layoutGrid', run: () => actions.setLayout(grid ? 'thread' : 'grid') },
    cmd('Toggle voice input', { title: 'Voice', icon: 'mic', kbd: '⌘⇧M', sub: '' }),
    { title: 'Usage', icon: 'chartBar', run: view('spend') },
    { title: 'Settings', icon: 'settings2', run: view('settings') },
  ].filter(Boolean);
}

// Every other registered command, and the project ones the old palette had. A "⌘B" hint shows as a shortcut.
const moreActions = used => [
  ...commands.filter(c => !used.has(c)).map(({ sub, ...c }) => (/^⌘/.test(sub ?? '') ? { ...c, kbd: sub } : { ...c, sub })),
  ...(state.projects.length > 1 ? [{ title: 'Show every project side by side', icon: 'stack', run: () => actions.showSpaces([state.project, ...state.projects.map(p => p.path)]) }] : []),
  ...(openSpaces().length > 1 ? [{ title: 'Show only this project', icon: 'folder', run: () => actions.switchProject(state.project) }] : []),
  ...(state.project ? [{ title: `Remove ${projectName(state.project)} from the projects`, icon: 'x', sub: 'No files are touched', run: () => actions.removeProject() }] : []),
];

// A thread is a chat: a running one is shown, a closed one starts again. One in a project not on screen switches there first.
const threadItem = c => ({
  title: c.title, icon: 'message', sub: [projectName(c.project), c.worktree?.branch && `#${c.worktree.branch}`].filter(Boolean).join(' · '),
  time: ago(c.lastActiveAt), terms: [c.agent, c.specialist?.name],
  run: () => {
    if (!openSpaces().includes(c.project)) actions.switchProject(c.project);
    actions.openChat(c.id);
  },
});
const chats = () => state.chats.filter(c => !c.artifactId); // newest first, from the server
const byAgent = c => c.startedBy && !c.talked; // left out of Recent, as the sidebar leaves them out

function groupsFor(query) {
  const used = new Set();
  const top = topActions(used);
  if (!query) return [['Actions', top], ['Recent threads', chats().filter(c => !byAgent(c)).slice(0, 8).map(threadItem)]];
  const all = [['Actions', [...top, ...moreActions(used)]]];
  if (query.startsWith('>')) return all;
  return [...all,
    ['Projects', state.projects.map(p => ({ title: p.name, icon: 'folder', sub: p.path.replace(state.info.home, '~'), run: () => actions.switchProject(p.path) }))],
    ['Pages', VIEWS.map((v, i) => ({ title: v.label, icon: v.icon, sub: v.hint, kbd: `⌘${i + 1}`, run: view(v.id) }))],
    ['Themes', Object.entries(THEMES).map(([id, t]) => ({ title: `Theme: ${t.name}`, icon: 'palette', sub: state.settings.theme === id ? 'Current theme' : '', run: () => actions.setSetting({ theme: id }) }))],
    ['Threads', [
      ...chats().map(threadItem),
      // shells and browser panes have no chat; the old palette listed every pane in the grid
      ...gridSessions().filter(s => !state.chats.some(c => c.id === s.chatId)).map(s => ({ title: chatTitle(s), icon: 'terminal', sub: s.agent || s.kind, run: () => actions.focusSession(s.id) })),
    ]],
  ];
}

// As T3 ranks it, roughly: every word must match somewhere; then a title that is the query, starts with it,
// or has each word at a word start comes first. Ties keep their order, so threads stay newest first.
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rank = (title, q, words) => {
  const t = title.toLowerCase();
  return t === q ? 3 : t.startsWith(q) ? 2 : words.every(w => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(w)}`, 'u').test(t)) ? 1 : 0;
};
function search(query) {
  const q = query.trim().replace(/^>/, '').trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  return groupsFor(query.trim()).map(([label, items]) => [label, !words.length ? items : items
    .filter(c => words.every(w => [c.title, c.sub, ...(c.terms ?? [])].join(' ').toLowerCase().includes(w)))
    .map((c, i) => ({ c, i, r: rank(c.title, q, words) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map(x => x.c)
    .slice(0, 50)]) // ponytail: no virtual list, so a group shows its best 50; virtualise if that hides real results
    .filter(([, items]) => items.length);
}

function openPalette() {
  if (document.querySelector('.palette')) return;
  const back = document.activeElement; // focus goes back here on close, as T3's dialog does
  const input = h('input', {
    placeholder: 'Search commands, projects, and threads...', spellcheck: false, autocomplete: 'off',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list', 'aria-label': 'Search commands, projects, and threads',
  });
  const list = h('div', { class: 'pal-list', id: 'pal-list', role: 'listbox', 'aria-label': 'Results' });
  let rows = [];
  let selected = 0;
  const select = i => {
    rows[selected]?.el.removeAttribute('data-active');
    rows[selected]?.el.setAttribute('aria-selected', 'false');
    selected = i;
    const row = rows[selected];
    if (!row) return input.removeAttribute('aria-activedescendant');
    row.el.setAttribute('data-active', '');
    row.el.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', row.el.id);
    row.el.scrollIntoView({ block: 'nearest' });
  };
  const item = c => {
    const i = rows.length;
    const el = h('div', {
      class: 'pal-item', id: `pal-item-${i}`, role: 'option', 'aria-selected': 'false',
      onMousemove: () => selected !== i && select(i), onMousedown: e => e.preventDefault(), onClick: () => run(c),
    },
    h('span', { class: 'pal-icon' }, icon(c.icon || 'chevronRight', 16)),
    c.sub
      ? h('span', { class: 'pal-text' }, h('span', { class: 'pal-title' }, c.title), h('span', { class: 'pal-sub' }, c.sub))
      : h('span', { class: 'pal-title' }, c.title),
    c.time && h('span', { class: 'pal-time' }, c.time),
    c.kbd && h('kbd', { class: 'pal-shortcut' }, c.kbd));
    rows.push({ el, c });
    return el;
  };
  const render = () => {
    rows = [];
    const groups = search(input.value);
    list.replaceChildren(...(groups.length
      ? groups.map(([label, items], g) => h('div', { class: 'pal-group', role: 'group', 'aria-labelledby': `pal-group-${g}` },
        h('div', { class: 'pal-heading', id: `pal-group-${g}` }, label), items.map(item)))
      : [h('div', { class: 'pal-empty' }, input.value.trim().startsWith('>') ? 'No matching actions.' : 'No matching commands, projects, or threads.')]));
    selected = 0;
    select(0);
  };
  const close = () => {
    overlay.remove();
    if (back?.isConnected) back.focus({ preventScroll: true });
  };
  const run = c => { close(); c.run(); };
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) select((selected + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === 'Enter' && rows[selected]) { e.preventDefault(); run(rows[selected].c); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } // not also the board's drawer
    else if (e.key === 'Tab') e.preventDefault(); // the input is the dialog's only stop
  });
  const keys = (chips, label) => h('span', { class: 'pal-keys' }, chips.map(k => h('kbd', {}, k)), h('span', {}, label));
  const overlay = h('div', { class: 'overlay pal-overlay', onMousedown: e => e.target === overlay && close() },
    h('div', { class: 'modal palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
      h('div', { class: 'pal-input' }, icon('search', 16), input),
      h('div', { class: 'pal-panel' }, list),
      h('div', { class: 'pal-foot' },
        keys([icon('arrowUp', 12), h('span', { class: 'pal-down' }, icon('arrowUp', 12))], 'Navigate'), keys(['Enter'], 'Select'), keys(['Esc'], 'Close'))));
  document.body.append(overlay);
  render();
  input.focus();
}
