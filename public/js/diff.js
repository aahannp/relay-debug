// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT © 2026 T3 Tools Inc. See NOTICE.
// The right-hand diff panel (#diffPanel) and the thread details popover. The panel shows what the current thread's
// folder changed, as one stacked diff (T3's DiffPanel + StyledDiffCodeView), in plain HTML rather than Monaco.
// Thread details shows its branch with Commit / Merge / Discard, the same calls the Review view makes.
import { state, api, h, icon, on, emit, guard, actions, copy, shortBranch, baseName, ltr } from './ui.js';
import { commit, merge, discard } from './review.js';

const WIDTH = 'agent-desk:diff-w';
const MIN = 360;
const SHEET = '(max-width: 980px)';
let panel, body, statEl, handle;
let open = false;
let wrap = false;
let folded = new Set(); // paths of collapsed files
let current = { review: null, item: null, files: [] };
let loading = 0; // so a slow answer for the last thread never replaces the current one's

// ---------- The current thread ----------
// The focused pane, or in thread mode the one maximised pane; with none, the project's main folder.
function thread() {
  const id = actions.focusedSession?.() ?? document.querySelector('.pane.max')?.dataset.id ?? null;
  return state.sessions.find(s => s.id === id) ?? null;
}

// Review's entry for a folder: the worktree it is, or holds it (an agent may cd into a subfolder).
const itemFor = (review, dir) => review.items.find(i => i.path === dir)
  ?? review.items.filter(i => dir.startsWith(`${i.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]
  ?? review.items.find(i => i.main) ?? null;

async function loadThread() {
  const s = thread();
  const project = s?.project ?? state.project;
  if (!project) return { review: { git: false, items: [] }, item: null };
  const review = await api('GET', `/api/review?project=${encodeURIComponent(project)}`);
  return { review, item: review.git ? itemFor(review, s?.cwd ?? project) : null };
}

// ---------- Parsing git's unified diff ----------
// Files: { path, status: 'A'|'D'|'M', binary, add, del, hunks: [{ gap, lines: [{ kind: 'add'|'del'|'ctx', n, text }] }] }
// `gap` is how many unchanged lines come before the hunk.
export function parseDiff(text) {
  const files = [];
  let f = null, hunk = null, oldN = 0, newN = 0, lastEnd = 1;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      f = { path: line.replace(/^diff --git a\/.* b\//, ''), status: 'M', binary: false, add: 0, del: 0, hunks: [] };
      files.push(f);
      hunk = null;
      lastEnd = 1;
    } else if (!f) continue;
    else if (!hunk && line.startsWith('new file mode')) f.status = 'A';
    else if (!hunk && line.startsWith('deleted file mode')) f.status = 'D';
    else if (!hunk && line.startsWith('Binary files')) f.binary = true;
    else if (!hunk && line.startsWith('+++ ') && line !== '+++ /dev/null') f.path = line.slice(4).replace(/^b\//, '');
    else if (!hunk && line.startsWith('--- ') && f.status === 'D') f.path = line.slice(4).replace(/^a\//, '');
    else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (!m) continue;
      [oldN, newN] = [Number(m[1]), Number(m[2])];
      hunk = { gap: Math.max(0, (f.status === 'D' ? oldN : newN) - lastEnd), lines: [] };
      f.hunks.push(hunk);
    } else if (hunk && line.startsWith('+')) { hunk.lines.push({ kind: 'add', n: newN++, text: line.slice(1) }); f.add++; }
    else if (hunk && line.startsWith('-')) { hunk.lines.push({ kind: 'del', n: oldN++, text: line.slice(1) }); f.del++; }
    else if (hunk && line.startsWith(' ')) { hunk.lines.push({ kind: 'ctx', n: newN++, text: line.slice(1) }); oldN++; }
    if (hunk) lastEnd = f.status === 'D' ? oldN : newN;
  }
  return files;
}

// ---------- The panel ----------
const savedWidth = () => { try { return Number(localStorage.getItem(WIDTH)) || 540; } catch { return 540; } };
// T3: at least 360px, at most 70% of the window and never leaving the chat under 360px.
const maxWidth = () => Math.max(MIN, Math.min(innerWidth * 0.7, innerWidth - (document.querySelector('.side')?.offsetWidth ?? 0) - MIN));
function setWidth(px, save = false) {
  const w = Math.round(Math.min(maxWidth(), Math.max(MIN, px)));
  document.querySelector('.app').style.setProperty('--diff-w', `${w}px`);
  handle.setAttribute('aria-valuenow', w);
  handle.setAttribute('aria-valuemax', Math.round(maxWidth()));
  if (save) try { localStorage.setItem(WIDTH, String(w)); } catch {}
}

function toggle(force) {
  open = typeof force === 'boolean' ? force : !open;
  panel.hidden = !open;
  emit('diff', open); // the header's PanelRight button shows it pressed
  if (open) { setWidth(savedWidth()); if (!current.review) render(); load(); }
  if (open && matchMedia(SHEET).matches) panel.focus(); // the sheet covers the chat, so it takes focus and Escape closes it
}

const load = guard(async () => {
  const mine = ++loading;
  const next = await loadThread();
  if (mine !== loading) return;
  const diff = next.item ? (await api('GET', `/api/review/diff?worktree=${encodeURIComponent(next.item.path)}`)).text : '';
  if (mine !== loading) return;
  if (next.item?.path !== current.item?.path) folded = new Set();
  current = { ...next, files: parseDiff(diff), cut: /\n… \(diff cut at \d+ characters\)$/.test(diff) };
  render();
});

function render() {
  const { review, item, files } = current;
  statEl.replaceChildren(...(item?.files.length ? [h('span', { class: 'a' }, `+${item.add}`), h('span', { class: 'd' }, `−${item.del}`)] : []));
  const empty = text => body.replaceChildren(h('div', { class: 'diff-empty' }, text));
  if (!review) return empty('Loading…');
  if (!review.git) return empty("This project isn't a git repository, so there are no changes to show.");
  if (!files.length) return empty('No changes in this thread yet.');
  body.replaceChildren(...files.map(fileView), current.cut ? h('div', { class: 'diff-empty' }, 'The rest of the diff is cut off. Open Review to see every file.') : '');
}

function fileView(f) {
  const tone = { A: 'new', D: 'gone', M: 'mod' }[f.status];
  const fold = h('button', { class: 'diff-fold', 'aria-expanded': String(!folded.has(f.path)), 'aria-label': `Collapse ${f.path}`, onClick: () => {
    folded.has(f.path) ? folded.delete(f.path) : folded.add(f.path);
    sec.classList.toggle('folded', folded.has(f.path));
    fold.setAttribute('aria-expanded', String(!folded.has(f.path)));
  } }, icon('chevronDown', 16));
  const copyBtn = h('button', { class: 'icon-btn sm', title: 'Copy path', 'aria-label': `Copy ${f.path}`, onClick: async () => {
    await copy(f.path, 'Path copied');
    copyBtn.replaceChildren(icon('check', 12));
    setTimeout(() => copyBtn.replaceChildren(icon('copy', 12)), 1200);
  } }, icon('copy', 12));
  const sec = h('section', { class: `diff-file${folded.has(f.path) ? ' folded' : ''}` },
    h('div', { class: 'diff-file-head' }, fold,
      h('button', { class: `diff-path ${tone}`, title: `Open ${f.path}`, disabled: f.status === 'D', onClick: () => actions.openFile(`${current.item.path}/${f.path}`) }, ltr(f.path)),
      h('span', { class: 'stat' }, f.add ? h('span', { class: 'a' }, `+${f.add}`) : null, f.del ? h('span', { class: 'd' }, `−${f.del}`) : null),
      copyBtn),
    h('div', { class: 'diff-lines' }, h('div', { class: 'diff-rows' },
      f.binary ? h('div', { class: 'diff-gap' }, 'Binary file, not shown') : f.hunks.flatMap(hunk => [
        hunk.gap > 0 && h('div', { class: 'diff-gap' }, `${hunk.gap} unmodified line${hunk.gap === 1 ? '' : 's'}`),
        ...hunk.lines.map(l => h('div', { class: `dl ${l.kind}` }, h('span', { class: 'ln' }, l.n), h('span', { class: 'code' }, l.text || ' '))),
      ]))));
  return sec;
}

function collapseAll() {
  const all = current.files.every(f => folded.has(f.path));
  folded = all ? new Set() : new Set(current.files.map(f => f.path));
  render();
}

// The 8px edge on the panel's left: drag it, or focus it and use the arrow keys.
function resizer() {
  handle = h('div', { class: 'diff-resize', role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical', 'aria-label': 'Resize the diff panel', 'aria-valuemin': MIN,
    onPointerdown: e => {
      handle.setPointerCapture(e.pointerId);
      const move = ev => setWidth(innerWidth - ev.clientX);
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', () => { handle.removeEventListener('pointermove', move); setWidth(panel.offsetWidth, true); }, { once: true });
    },
    onKeydown: e => {
      const step = { ArrowLeft: 16, ArrowRight: -16 }[e.key];
      if (step) { e.preventDefault(); setWidth(panel.offsetWidth + step, true); }
    } });
  return handle;
}

// ---------- Thread details ----------
let closeDetails = null;

const threadDetails = guard(async anchor => {
  if (closeDetails) return closeDetails();
  closeDetails = () => {}; // a second click while it loads closes nothing yet
  const { review, item } = await loadThread().catch(e => { closeDetails = null; throw e; });
  const card = h('div', { class: 'thread-details', role: 'dialog', 'aria-label': 'Thread details' });
  const done = async act => { closeDetails(); await act(item); if (open) load(); };
  const running = item?.session && !item.session.exited;
  const section = (label, ...rows) => h('section', { class: 'td-section' }, h('div', { class: 'td-label' }, label), ...rows);
  card.append(...(!item ? [section('Thread', h('p', { class: 'td-note' }, review.git ? 'No folder for this thread.' : "This project isn't a git repository, so there's no branch to commit or merge."))] : [
    section('Thread',
      h('div', { class: 'td-branch', title: item.path }, icon('branch', 14), h('span', { class: 'td-name' }, item.main ? item.branch : shortBranch(item.branch)),
        !item.main && item.base && h('span', { class: 'td-sub' }, `from ${item.base}`)),
      h('button', { class: 'td-row', onClick: () => { closeDetails(); actions.browseFolder(item.path); } }, icon('folder', 14), h('span', {}, 'Open in Files'), h('span', { class: 'td-sub' }, baseName(item.path)))),
    section('Git',
      h('div', { class: 'td-actions' },
        h('button', { class: 'btn xs primary', disabled: !item.files.length, onClick: () => done(commit) }, icon('gitCommit', 13), 'Commit'),
        !item.main && h('button', { class: 'btn xs', disabled: !item.files.length || running, title: running ? 'Wait for the agent to finish first' : `Merge into ${item.base}`, onClick: () => done(merge) }, icon('merge', 13), 'Merge'),
        !item.main && h('button', { class: 'btn xs danger', disabled: !item.recorded, title: item.recorded ? '' : "Relay didn't make this worktree and no agent edited it, so it won't delete it", onClick: () => done(discard) }, icon('trash', 13), 'Discard')),
      h('button', { class: 'td-row', onClick: () => { closeDetails(); toggle(true); } }, icon('fileDiff', 14), h('span', {}, 'Changes'),
        h('span', { class: 'stat' }, h('span', { class: 'a' }, `+${item.add}`), ' ', h('span', { class: 'd' }, `−${item.del}`)))),
  ]));
  document.body.append(card);
  const r = anchor?.getBoundingClientRect() ?? { bottom: 46, right: innerWidth - 12 };
  card.style.top = `${r.bottom + 6}px`;
  card.style.left = `${Math.max(8, Math.min(r.right - card.offsetWidth, innerWidth - card.offsetWidth - 8))}px`;
  const outside = e => !card.contains(e.target) && !anchor?.contains(e.target) && closeDetails();
  const onKey = e => e.key === 'Escape' && (e.stopPropagation(), closeDetails(), anchor?.focus());
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', onKey, true);
  closeDetails = () => {
    card.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    closeDetails = null;
  };
  card.querySelector('button:not(:disabled)')?.focus();
});

export function mount(el) {
  panel = el;
  statEl = h('span', { class: 'stat diff-total' });
  body = h('div', { class: 'diff-body' });
  const wrapBtn = h('button', { class: 'icon-btn sm', title: 'Wrap lines', 'aria-pressed': 'false', onClick: () => {
    wrap = !wrap;
    body.classList.toggle('wrap', wrap);
    wrapBtn.setAttribute('aria-pressed', String(wrap));
  } }, icon('textWrap', 14));
  el.setAttribute('aria-label', 'Diff');
  el.tabIndex = -1;
  el.append(resizer(),
    h('div', { class: 'diff-tabs', role: 'tablist' },
      h('div', { class: 'diff-tab', role: 'tab', 'aria-selected': 'true' }, icon('fileDiff', 12), 'Diff',
        h('button', { class: 'diff-tab-x', title: 'Close (⌘D)', 'aria-label': 'Close the diff panel', onClick: () => toggle(false) }, icon('x', 12)))),
    h('div', { class: 'diff-bar' },
      h('span', { class: 'diff-scope' }, 'Changes'), h('span', { class: 'grow' }), statEl,
      h('button', { class: 'icon-btn sm', title: 'Refresh', 'aria-label': 'Refresh', onClick: () => load() }, icon('refresh', 14)),
      h('button', { class: 'icon-btn sm', title: 'Collapse or expand all files', 'aria-label': 'Collapse or expand all files', onClick: collapseAll }, icon('chevronsDownUp', 14)),
      wrapBtn),
    body);
  el.addEventListener('keydown', e => {
    if (e.key === 'Escape' && matchMedia(SHEET).matches) { e.stopPropagation(); toggle(false); }
  });

  actions.toggleDiff = toggle;
  actions.diffOpen = () => open;
  actions.threadDetails = threadDetails;

  // ⌘D, except in the code editor, where it selects the next match.
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd' && !e.target.closest?.('.monaco-editor')) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }
  }, true);

  // Follow the thread: another pane focused, its agent finished a turn, or another project.
  let shown = null;
  document.addEventListener('focusin', () => {
    const id = thread()?.id ?? null;
    if (open && id !== shown) load();
    shown = id;
  });
  let timer;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => open && load(), 800); };
  on('sessions', later);
  on('project', later);
  addEventListener('resize', () => open && setWidth(savedWidth()));
}
