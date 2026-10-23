// Review view: what each agent's worktree changed, as side-by-side diffs, then commit, merge or discard.
import { state, api, h, icon, on, toast, guard, actions, confirmDialog, askText, shortBranch, baseName, ltr } from './ui.js';
import { loadMonaco, editorOptions } from './monaco.js';

let data = { git: true, items: [] };
let selected = null; // worktree path
let file = null;
let diff = null;
let sideBySide = true;
let listEl, actionsEl, filesEl, headEl, hostEl;

export function mount(el) {
  listEl = h('div', { class: 'wt-list' });
  actionsEl = h('div', { class: 'wt-actions' });
  filesEl = h('div', { class: 'file-list' });
  headEl = h('div', { class: 'diff-head' });
  hostEl = h('div', { class: 'diff-host' });
  el.append(h('div', { class: 'review' }, listEl, h('div', { class: 'wt-files' }, actionsEl, filesEl), h('div', {}, headEl, hostEl)));
  on('project', () => { selected = null; file = null; if (actions.currentView() === 'review') load(); });
  for (const kind of ['tasks', 'projects']) on(kind, () => actions.currentView() === 'review' && load());
}

export const show = () => load();
export const toolbar = () => [h('button', { class: 'btn sm', onClick: () => load() }, icon('refresh', 13), 'Refresh')];

actions.reviewWorktree = path => {
  selected = path;
  file = null;
  actions.showView('review');
};

const load = guard(async () => {
  if (!state.project) return render();
  data = await api('GET', `/api/review?project=${encodeURIComponent(state.project)}`);
  if (!data.items.some(i => i.path === selected)) {
    selected = (data.items.find(i => !i.main && i.files.length) || data.items.find(i => i.files.length) || data.items[0])?.path ?? null;
    file = null;
  }
  render();
});

const item = () => data.items.find(i => i.path === selected);

function render() {
  if (!data.git) {
    listEl.replaceChildren(...data.elsewhere?.length ? [
      h('div', { class: 'section-label', style: { margin: '2px 4px 4px' } }, 'Agents in this project changed these repos'),
      ...data.elsewhere.map(r => h('button', { class: 'wt', title: r.root, onClick: () => actions.openProject(r.root) },
        h('div', { class: 'wt-top' }, icon('folder', 13), h('span', { class: 'wt-branch' }, r.name)), h('div', { class: 'wt-task' }, 'Open its review'))),
    ] : [h('div', { class: 'pane-empty' }, 'This project is not a git repository, so there is nothing to review. Run git init in a shell to turn on worktrees and review.')]);
    actionsEl.replaceChildren();
    filesEl.replaceChildren();
    headEl.replaceChildren();
    diff?.setModel(null); // or the last project's diff stays on screen
    hostEl.querySelector('.pane-empty')?.remove();
    return;
  }
  const agentItems = data.items.filter(i => !i.main);
  listEl.replaceChildren(
    h('div', { class: 'section-label', style: { margin: '2px 4px 4px' } }, 'Main folder'),
    ...data.items.filter(i => i.main).map(card),
    h('div', { class: 'section-label', style: { margin: '14px 4px 4px' } }, `Agent worktrees · ${agentItems.length}`),
    ...(agentItems.length ? agentItems.map(card) : [h('div', { class: 'pane-empty', style: { padding: '12px' } }, 'No worktrees yet. Run a task with “Own git worktree” on and its work shows up here.')]));
  renderActions();
  renderFiles();
  if (!file) {
    const first = item()?.files[0];
    if (first) showDiff(first);
    else emptyDiff();
  }
}

function card(i) {
  const s = i.session;
  return h('button', { class: `wt${i.path === selected ? ' active' : ''}`, onClick: () => { selected = i.path; file = null; render(); } },
    h('div', { class: 'wt-top' },
      s ? h('span', { class: `dot ${actions.statusOf(s)}` }) : icon(i.main ? 'folder' : 'branch', 13),
      h('span', { class: 'wt-branch' }, i.main ? i.branch : shortBranch(i.branch)), h('span', { class: 'grow' }),
      h('span', { class: 'stat' }, h('span', { class: 'a' }, `+${i.add}`), ' ', h('span', { class: 'd' }, `−${i.del}`))),
    h('div', { class: 'wt-task', title: i.path }, i.main ? 'Changes not committed yet' : [baseName(i.path), i.task?.title ?? (i.base && `from ${i.base}`), i.by && `by ${i.by}`].filter(Boolean).join(' · ')),
    h('div', { class: 'row', style: { gap: '6px' } },
      h('span', { class: 'chip' }, `${i.files.length} file${i.files.length === 1 ? '' : 's'}`),
      i.task && h('span', { class: 'chip' }, i.task.status === 'review' ? 'ready for review' : i.task.status),
      s && h('span', { class: 'chip' }, `${s.kind === 'shell' ? 'shell' : 'agent'} ${s.exited ? 'finished' : 'running'}`)));
}

function renderActions() {
  const i = item();
  if (!i) return actionsEl.replaceChildren();
  const hasChanges = i.files.length > 0;
  actionsEl.replaceChildren(...[
    !i.main && h('button', { class: 'btn sm primary', disabled: !hasChanges || (i.session && !i.session.exited), title: i.session && !i.session.exited ? 'Wait for the agent to finish first' : '', onClick: () => merge(i) }, icon('merge', 13), `Merge into ${i.base}`),
    h('button', { class: 'btn sm', disabled: !hasChanges, onClick: () => commit(i) }, icon('check', 13), 'Commit'),
    i.session && h('button', { class: 'btn sm', onClick: () => actions.focusSession(i.session.id) }, icon('terminal', 13), 'Terminal'),
    h('button', { class: 'btn sm', onClick: () => actions.browseFolder(i.path) }, icon('folder', 13), 'Files'),
    !i.main && h('button', { class: 'btn sm danger', disabled: !i.recorded, title: i.recorded ? '' : "Relay didn't make this worktree and no agent edited it, so it won't delete it", onClick: () => discard(i) }, icon('trash', 13), 'Discard'),
  ].filter(Boolean));
}

function renderFiles() {
  const i = item();
  if (!i) return filesEl.replaceChildren(h('div', { class: 'pane-empty' }, 'Pick a worktree on the left'));
  filesEl.replaceChildren(...(i.files.length ? i.files.map(f => h('button', { class: `file-row${f.path === file ? ' active' : ''}`, title: f.path, onClick: () => showDiff(f) },
    h('span', { class: `st st-${f.status[0]}` }, f.status[0]),
    h('span', { class: 'fname' }, ltr(f.path)),
    h('span', { class: 'stat' }, h('span', { class: 'a' }, `+${f.add}`), ' ', h('span', { class: 'd' }, `−${f.del}`))))
    : [h('div', { class: 'pane-empty' }, i.main ? 'No uncommitted changes in the main folder.' : 'No changes in this worktree yet.')]));
}

function emptyDiff() {
  headEl.replaceChildren(h('span', { class: 'muted' }, 'No file selected'));
  diff?.setModel(null);
  if (!hostEl.querySelector('.pane-empty')) hostEl.append(h('div', { class: 'pane-empty', style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' } }, 'Pick a changed file to see its diff'));
}

const languageFor = (monaco, path) => monaco.languages.getLanguages().find(l => l.extensions?.includes(`.${path.split('.').pop()}`))?.id ?? 'plaintext';

const showDiff = guard(async f => {
  file = f.path;
  renderFiles();
  const monaco = await loadMonaco();
  const { original, modified } = await api('GET', `/api/review/file?worktree=${encodeURIComponent(selected)}&file=${encodeURIComponent(f.path)}`);
  hostEl.querySelector('.pane-empty')?.remove();
  diff ||= monaco.editor.createDiffEditor(hostEl, { ...editorOptions(), readOnly: true, originalEditable: false, renderSideBySide: sideBySide, minimap: { enabled: false } });
  const old = diff.getModel();
  const language = languageFor(monaco, f.path);
  diff.setModel({ original: monaco.editor.createModel(original, language), modified: monaco.editor.createModel(modified, language) });
  old?.original.dispose();
  old?.modified.dispose();
  headEl.replaceChildren(
    h('span', { class: `st st-${f.status[0]}`, style: { font: '700 11px var(--mono)' } }, f.status[0]),
    h('code', {}, f.path), h('span', { class: 'grow' }),
    h('span', { class: 'stat' }, h('span', { class: 'a' }, `+${f.add}`), ' ', h('span', { class: 'd' }, `−${f.del}`)),
    h('button', { class: 'btn sm', onClick: () => { sideBySide = !sideBySide; diff.updateOptions({ renderSideBySide: sideBySide }); } }, icon('layers', 13), sideBySide ? 'Inline' : 'Side by side'),
    h('button', { class: 'btn sm', onClick: () => actions.openFile(`${selected}/${f.path}`) }, icon('pen', 13), 'Edit'));
});

// ---------- Commit, merge, discard (the diff panel's thread details use these too) ----------
export const commit = guard(async i => {
  const message = await askText('Commit these changes', { label: 'Commit message', value: i.task?.title ?? (i.main ? '' : `Work from ${shortBranch(i.branch)}`), ok: 'Commit' });
  if (!message) return;
  const res = await api('POST', '/api/review/commit', { worktree: i.path, message });
  toast(res.committed ? 'Committed' : 'Nothing to commit', 'ok');
  load();
});

export const merge = guard(async i => {
  const ok = await confirmDialog(`Merge ${shortBranch(i.branch)} into ${i.base}?`,
    `Relay commits anything left uncommitted in the worktree, then runs git merge in your main folder (not on GitHub). If there's a conflict, nothing changes and you'll be told how to resolve it. ${i.files.length} file${i.files.length === 1 ? '' : 's'}: ${i.files.slice(0, 8).map(f => f.path).join(', ')}${i.files.length > 8 ? ', …' : ''}.`, { label: 'Merge' });
  if (!ok) return;
  await api('POST', '/api/review/commit', { worktree: i.path, message: i.task?.title ?? `Work from ${shortBranch(i.branch)}` });
  const res = await api('POST', '/api/review/merge', { worktree: i.path });
  toast(`Merged ${shortBranch(res.merged)} into ${res.into}`, 'ok');
  file = null;
  load();
});

export const discard = guard(async i => {
  const ok = await confirmDialog(`Discard ${shortBranch(i.branch)}?`,
    `This deletes the worktree folder and the branch ${i.branch}, including any work in it that wasn't merged. It can't be undone.`, { label: 'Discard', danger: true });
  if (!ok) return;
  await api('POST', '/api/review/remove', { worktree: i.path });
  toast('Worktree discarded', 'ok');
  selected = null;
  file = null;
  load();
});
