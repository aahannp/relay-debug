// Files view: browse the project (or an agent's worktree) and edit files in Monaco.
import { state, api, h, icon, on, toast, guard, actions, command, confirmDialog, baseName, shortBranch } from './ui.js';
import { loadMonaco, editorOptions } from './monaco.js';

let rootDir = '';
const expanded = new Set();
const listings = new Map(); // folder -> its entries
const tabs = []; // { path, model, saved }
let active = null;
let editor = null;
let treeEl, tabsEl, hostEl, statusEl, rootSelect, emptyEl;

export function mount(el) {
  rootSelect = h('select', { class: 'input', style: { flex: 1, height: '30px', padding: '0 8px' }, onChange: () => setRoot(rootSelect.value) });
  treeEl = h('div', { class: 'tree' });
  tabsEl = h('div', { class: 'tabs' });
  hostEl = h('div', { class: 'editor-host' });
  statusEl = h('div', { class: 'editor-status' });
  emptyEl = h('div', { class: 'empty-state' }, h('div', { class: 'empty-card' },
    h('div', { class: 'art' }, icon('file', 34)), h('h2', {}, 'Pick a file'),
    h('p', {}, 'Open a file from the tree to read or edit it, and press ⌘S to save. Switch the folder at the top left to look inside an agent\'s worktree.')));
  hostEl.append(emptyEl);
  el.append(h('div', { class: 'files' },
    h('div', { class: 'tree-pane' },
      h('div', { class: 'tree-head' }, rootSelect, h('button', { class: 'icon-btn', title: 'Refresh', onClick: () => { listings.clear(); renderTree(); } }, icon('refresh', 14))),
      treeEl),
    h('div', { class: 'editor-pane' }, tabsEl, hostEl, statusEl)));
  on('project', () => setRoot(state.project));
  on('sessions', renderRoots);
  on('settings', () => editor?.updateOptions({ fontSize: Number(state.settings.fontSize) || 13 }));
}

export function show() {
  if (!rootDir) setRoot(state.project);
  renderRoots();
  listings.clear();
  renderTree();
  reloadUnchanged();
}

export const toolbar = () => [
  active && h('button', { class: 'btn sm', onClick: save }, icon('save', 13), 'Save'),
  h('button', { class: 'btn sm', onClick: () => actions.newSession({ kind: 'shell' }) }, icon('terminal', 13), 'Shell here'),
].filter(Boolean);

command('Save file', () => save(), { icon: 'save', sub: '⌘S' });

// ---------- Tree ----------
function renderRoots() {
  if (!rootSelect || !state.project) return;
  const options = [{ path: state.project, label: `${baseName(state.project)} · main folder` }];
  const add = (path, branch) => path && !options.some(o => o.path === path) && options.push({ path, label: `${shortBranch(branch)} · worktree` });
  for (const s of state.sessions) if (s.project === state.project && s.worktree) add(s.worktree.path, s.worktree.branch);
  for (const t of state.tasks) if (t.project === state.project) add(t.worktreePath, t.branch);
  if (rootDir && !options.some(o => o.path === rootDir)) options.push({ path: rootDir, label: baseName(rootDir) });
  rootSelect.replaceChildren(...options.map(o => h('option', { value: o.path, selected: o.path === rootDir }, o.label)));
}

function setRoot(dir) {
  rootDir = dir;
  expanded.clear();
  listings.clear();
  renderRoots();
  renderTree();
}
actions.browseFolder = dir => {
  actions.showView('files');
  setRoot(dir);
};

async function renderTree() {
  if (!treeEl) return;
  if (!rootDir) return treeEl.replaceChildren(h('div', { class: 'pane-empty' }, 'No project open'));
  const rows = [];
  const walk = async (dir, depth) => {
    if (!listings.has(dir)) listings.set(dir, await api('GET', `/api/fs/list?path=${encodeURIComponent(dir)}`));
    for (const entry of listings.get(dir)) {
      rows.push(h('button', {
        class: `tree-row${entry.dir ? ' dir' : ''}${active?.path === entry.path ? ' active' : ''}`, title: entry.path,
        style: { paddingLeft: `${8 + depth * 14 + (entry.dir ? 0 : 16)}px` },
        onClick: () => (entry.dir ? toggle(entry.path) : open(entry.path)),
      }, entry.dir && icon(expanded.has(entry.path) ? 'chevron' : 'chevronRight', 12), icon(entry.dir ? 'folder' : 'file', 13), h('span', { class: 'name' }, entry.name)));
      if (entry.dir && expanded.has(entry.path)) await walk(entry.path, depth + 1);
    }
  };
  try {
    await walk(rootDir, 0);
    treeEl.replaceChildren(...(rows.length ? rows : [h('div', { class: 'pane-empty' }, 'This folder is empty')]));
  } catch (e) {
    treeEl.replaceChildren(h('div', { class: 'pane-empty' }, e.message));
  }
}

function toggle(dir) {
  if (expanded.has(dir)) expanded.delete(dir);
  else expanded.add(dir);
  renderTree();
}

// ---------- Editor ----------
const dirty = tab => tab.model.getAlternativeVersionId() !== tab.saved;

const open = guard(async path => {
  const monaco = await loadMonaco();
  if (!editor) {
    editor = monaco.editor.create(hostEl, editorOptions());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
    editor.onDidChangeCursorPosition(renderStatus);
  }
  let tab = tabs.find(t => t.path === path);
  if (!tab) {
    const { content } = await api('GET', `/api/fs/file?path=${encodeURIComponent(path)}`);
    const model = monaco.editor.createModel(content, undefined, monaco.Uri.file(path));
    tab = { path, model, saved: model.getAlternativeVersionId() };
    model.onDidChangeContent(renderTabs);
    tabs.push(tab);
  }
  activate(tab);
});
actions.openFile = path => {
  actions.showView('files');
  open(path);
};

function activate(tab) {
  active = tab;
  emptyEl.hidden = Boolean(tab);
  editor?.setModel(tab?.model ?? null);
  renderTabs();
  renderStatus();
  renderTree();
  actions.renderToolbar?.();
  if (tab) editor.focus();
}

const save = guard(async () => {
  if (!active) return;
  await api('PUT', '/api/fs/file', { path: active.path, content: active.model.getValue() });
  active.saved = active.model.getAlternativeVersionId();
  renderTabs();
  renderStatus();
  toast(`Saved ${baseName(active.path)}`, 'ok');
});

async function closeTab(tab) {
  if (dirty(tab) && !(await confirmDialog(`Close ${baseName(tab.path)}?`, 'It has changes you haven\'t saved.', { label: 'Close without saving', danger: true }))) return;
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  if (active === tab) activate(tabs[i] || tabs[i - 1] || null);
  tab.model.dispose();
  renderTabs();
}

function renderTabs() {
  tabsEl.replaceChildren(...tabs.map(tab => h('div', { class: `tab${tab === active ? ' active' : ''}`, title: tab.path, onClick: () => activate(tab) },
    h('span', {}, baseName(tab.path)),
    dirty(tab) ? h('span', { class: 'dirty', title: 'Not saved' }) : null,
    h('button', { class: 'icon-btn sm', title: 'Close', onClick: e => { e.stopPropagation(); closeTab(tab); } }, icon('x', 12)))));
}

function renderStatus() {
  if (!active) return statusEl.replaceChildren();
  const pos = editor.getPosition();
  statusEl.replaceChildren(...[
    h('span', {}, active.path.replace(`${rootDir}/`, '')), h('span', { class: 'grow' }),
    h('span', {}, active.model.getLanguageId()),
    pos && h('span', {}, `Ln ${pos.lineNumber}, Col ${pos.column}`),
    h('span', { style: { color: dirty(active) ? 'var(--warn)' : '' } }, dirty(active) ? 'Unsaved' : 'Saved'),
  ].filter(Boolean));
}

// Agents change files while you look away. Refresh any open file you haven't edited.
async function reloadUnchanged() {
  for (const tab of tabs) {
    if (dirty(tab)) continue;
    const res = await api('GET', `/api/fs/file?path=${encodeURIComponent(tab.path)}`).catch(() => null);
    if (res && res.content !== tab.model.getValue()) {
      tab.model.setValue(res.content);
      tab.saved = tab.model.getAlternativeVersionId();
    }
  }
  renderTabs();
}
