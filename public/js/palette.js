// The command palette (⌘K): commands, views, agents, spaces and themes in one searchable list.
import { state, h, icon, actions, commands, openSpaces, gridSessions, baseName } from './ui.js';
import { THEMES } from './themes.js';

let VIEWS = [];
export function mount(views) {
  VIEWS = views;
  actions.openPalette = openPalette;
}

function openPalette() {
  if (document.querySelector('.palette')) return;
  const input = h('input', { placeholder: 'Search commands, agents, themes and projects…', spellcheck: false });
  const list = h('div', { class: 'list' });
  let items = [];
  let selected = 0;
  const all = () => [
    ...commands,
    ...VIEWS.map((v, i) => ({ title: `Go to ${v.label}`, icon: v.icon, sub: `⌘${i + 1}`, run: () => actions.showView(v.id) })),
    ...gridSessions().map(s => ({ title: `Show ${s.name}`, icon: 'terminal', sub: s.agent || s.kind, run: () => actions.focusSession(s.id) })),
    ...(state.projects.length > 1 ? [{ title: 'Show every space side by side', icon: 'stack', run: () => actions.showSpaces([state.project, ...state.projects.map(p => p.path)]) }] : []),
    ...(openSpaces().length > 1 ? [{ title: 'Show only this space', icon: 'folder', run: () => actions.switchProject(state.project) }] : []),
    ...state.projects.filter(p => p.path !== state.project).map(p => ({ title: `Switch to ${p.name}`, icon: 'folder', sub: p.path.replace(state.info.home, '~'), run: () => actions.switchProject(p.path) })),
    ...(state.project ? [{ title: `Remove ${baseName(state.project)} from the spaces`, icon: 'x', sub: 'No files are touched', run: () => actions.removeProject() }] : []),
    ...Object.entries(THEMES).map(([id, t]) => ({ title: `Theme: ${t.name}`, icon: 'sparkles', run: () => actions.setSetting({ theme: id }) })),
  ];
  const select = i => {
    list.children[selected]?.classList.remove('sel');
    selected = i;
    list.children[selected]?.classList.add('sel');
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  };
  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    items = all().filter(c => words.every(w => `${c.title} ${c.sub || ''}`.toLowerCase().includes(w))).slice(0, 80);
    list.replaceChildren(...(items.length ? items.map((c, i) => h('button', { class: 'menu-item', onMousemove: () => selected !== i && select(i), onClick: () => run(c) },
      icon(c.icon || 'chevronRight', 15), h('span', {}, c.title), c.sub && h('span', { class: 'sub' }, c.sub))) : [h('div', { class: 'empty' }, 'Nothing matches')]));
    select(0);
  };
  const close = () => overlay.remove();
  const run = c => { close(); c.run(); };
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(selected + 1, items.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(selected - 1, 0)); }
    if (e.key === 'Enter' && items[selected]) run(items[selected]);
    if (e.key === 'Escape') close();
  });
  const overlay = h('div', { class: 'overlay', onMousedown: e => e.target === overlay && close() }, h('div', { class: 'modal palette' },
    h('div', { class: 'pal-input' }, icon('search', 18), input, h('kbd', {}, 'esc')), list,
    h('div', { class: 'pal-foot' }, h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), 'move'), h('span', {}, h('kbd', {}, '↵'), 'run'), h('span', { class: 'grow' }), h('span', {}, 'Relay'))));
  document.body.append(overlay);
  render();
  input.focus();
}
