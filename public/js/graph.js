// Graph view: who is doing what. Each agent or shell is a node, messages between them are edges, and named groups
// are soft bubbles around their members. A small force layout places them, then settles and stops; dragging pins a node.
// The layout lives in world coordinates; one transform on the world layer pans and zooms it, like a map.
import { state, api, h, icon, avatar, on, toast, guard, actions, modal, confirmDialog, menu, ago, agentLabel, chatTitle, baseName, projectSessions, markdown, MONO, STATUS_LABEL, TEAM_COLORS } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
};
const still = matchMedia('(prefers-reduced-motion: reduce)');
const FRESH = 2 * 60_000; // an edge with a message this recent glows
const PAD = 50; // how far a group's bubble reaches past its members
const ZOOM = [0.3, 3];

let root, stage, world, zoomLabel, hullLayer, edgeLayer, pulseLayer, nodeLayer, labelLayer, lassoEl, tipEl, legendEl, selBar, panel;
let messages = [];
let groups = [];
let spaces = []; // with "All spaces" on, one bubble per project folder: { project, name, color, ids }
let allSpaces = false;
let showExited = false;
let nodes = []; // the sessions on the graph
let edges = []; // { kind: 'message' | 'started', a, b, ... }
let shape = ''; // which nodes, edges and groups there are, so only a real change re-runs the layout
let size = { width: 0, height: 0 };
let alpha = 0; // how much the layout still moves; it stops when this runs out
let running = false;
let dragging = null;
let suppressClick = false;
let open = null; // { kind: 'node' | 'group', id }
let poll = null;
let mirror = null; // the open node's live screen: { id, term, ws, box, ... }
const pos = new Map(); // session id -> { x, y, vx, vy, pinned }
const nodeEls = new Map();
const selected = new Set();
const pulses = []; // messages travelling along their edge: { from, to, start, el }
let view = { x: 0, y: 0, k: 1 }; // the camera: a world point (x, y) shows at (x * k + view.x, y * k + view.y)
let aim = null; // a view the camera is gliding to
let manual = false; // you've panned or zoomed, so the camera stops framing the graph by itself
let follow = false; // keep framing the graph while its layout settles
const views = new Map(); // project (or '*' for all spaces) -> { view, manual }, for this session
let viewScope = '';

const isShown = () => actions.currentView?.() === 'graph';
const keyOf = s => s.chatId || s.id; // a group keeps an agent across restarts by its chat
const byId = id => state.sessions.find(s => s.id === id);
const nameOf = id => (s => (s ? chatTitle(s) + (allSpaces ? ` (${spaceName(s)})` : '') : 'An agent'))(byId(id));
const groupsOf = s => groups.filter(g => g.members.includes(keyOf(s)));
const scope = () => (allSpaces ? '*' : state.project);
const bubbles = () => (allSpaces ? spaces : groups);
const spaceName = s => (p => p?.name ?? baseName(s.project))(state.projects.find(p => p.path === s.project));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function mount(el) {
  hullLayer = svg('g');
  edgeLayer = svg('g');
  pulseLayer = svg('g');
  const drawing = svg('svg', { class: 'graph-svg' });
  drawing.append(hullLayer, edgeLayer, pulseLayer);
  nodeLayer = h('div', { class: 'graph-nodes', onFocusin: e => e.target.matches(':focus-visible') && reveal(e.target.dataset.id) }); // tabbed to
  labelLayer = h('div', { class: 'graph-labels' });
  lassoEl = h('div', { class: 'graph-lasso', hidden: true });
  tipEl = h('div', { class: 'graph-tip', role: 'tooltip', hidden: true });
  world = h('div', { class: 'graph-world' }, drawing, labelLayer, nodeLayer);
  stage = h('div', { class: 'graph-stage', tabIndex: 0, 'aria-label': 'Graph. Arrow keys pan, plus and minus zoom, 0 fits it all in view.',
    onPointerdown: e => (e.shiftKey ? lasso(e) : pan(e)), onKeydown: keys }, world, lassoEl, tipEl);
  stage.addEventListener('wheel', wheel, { passive: false });
  zoomLabel = h('span', { class: 'graph-zoom-k', 'aria-live': 'polite' }, '100%');
  const zoomBtn = (label, title, run, child) => h('button', { class: 'icon-btn', title, 'aria-label': label, onClick: run }, child);
  const zoomBar = h('div', { class: 'graph-zoom', role: 'group', 'aria-label': 'Zoom' },
    zoomBtn('Zoom out', 'Zoom out (−)', () => zoomBy(1 / 1.25), '−'), zoomLabel, zoomBtn('Zoom in', 'Zoom in (+)', () => zoomBy(1.25), '+'),
    h('button', { class: 'btn xs', title: 'Fit everything in view (0)', onClick: () => fitNow() }, 'Fit'));
  legendEl = h('div', { class: 'graph-legend' });
  selBar = h('div', { class: 'graph-selbar', hidden: true });
  root = h('div', { class: 'graph' }, stage, legendEl, zoomBar, selBar);
  el.append(root);
  // Focusing a node that's out of view must not scroll these (they hide overflow, but can still scroll): the camera moves instead.
  root.addEventListener('scroll', e => (e.target === root || e.target === stage) && e.target.scrollTo(0, 0), true);

  on('project', () => scope() !== viewScope && rescope());
  on('sessions', () => isShown() && render());
  on('theme', () => mirror && (mirror.term.options.theme = state.termTheme));
  on('tasks', () => open?.kind === 'node' && isShown() && refreshNode(false));
  on('groups', () => isShown() && loadGroups());
  on('agent-message', e => {
    if ((!allSpaces && e.project !== state.project) || !e.toId) return;
    messages.push({ at: e.at, project: e.project, fromId: e.fromId, fromName: e.fromName, toId: e.toId, toName: e.toName, via: e.via });
    if (!isShown()) return;
    render();
    if (e.fromId) pulse(e.fromId, e.toId);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !isShown() || document.querySelector('.overlay, .menu')) return;
    if (open) closePanel(true);
    else if (selected.size) setSelection([]);
  });
  new ResizeObserver(() => {
    if (!isShown()) return;
    measure();
    follow = !manual;
    heat(0.3);
  }).observe(stage);
}

// Switching project, or turning "All spaces" on or off: each keeps its own camera.
function rescope() {
  views.set(viewScope, { view, manual });
  viewScope = scope();
  ({ view, manual } = views.get(viewScope) ?? { view: { x: 0, y: 0, k: 1 }, manual: false });
  aim = null;
  applyView();
  messages = [];
  groups = [];
  nodes = []; // and edges: the running layout must not look up positions that were just cleared
  edges = [];
  pos.clear();
  selected.clear();
  closePanel();
  if (isShown()) load();
}

export const show = () => {
  viewScope ||= scope();
  measure();
  load();
  if (open?.kind === 'node' && !mirror && byId(open.id)) screenOf(byId(open.id));
};
export const hide = () => dropMirror();

export const toolbar = () => [
  h('label', { class: 'toggle', title: 'Show every project folder at once, each as a bubble, with the asks between them' },
    h('input', { type: 'checkbox', checked: allSpaces, onChange: e => { allSpaces = e.target.checked; rescope(); } }), h('span', {}, 'All spaces')),
  h('label', { class: 'toggle', title: 'Show agents and shells that have finished, dimmed' },
    h('input', { type: 'checkbox', checked: showExited, onChange: e => { showExited = e.target.checked; render(); } }), h('span', {}, 'Show exited')),
  h('button', { class: 'btn sm', title: 'Unpin every node and lay them out again', onClick: relayout }, icon('refresh', 13), 'Re-layout'),
];

const load = guard(async () => {
  if (allSpaces) {
    messages = await api('GET', '/api/messages?all=1');
    return render();
  }
  if (!state.project) return render();
  const q = `?project=${encodeURIComponent(state.project)}`;
  [messages, groups] = await Promise.all([api('GET', `/api/messages${q}`), api('GET', `/api/groups${q}`)]);
  render();
});
const loadGroups = guard(async () => {
  if (allSpaces) return; // groups belong to one project
  groups = await api('GET', `/api/groups?project=${encodeURIComponent(state.project)}`);
  render();
  if (open?.kind === 'group') groups.some(g => g.id === open.id) ? groupPanel() : closePanel();
  else if (open?.kind === 'node') refreshNode(false);
});

function measure() {
  size = { width: stage.clientWidth, height: stage.clientHeight };
}

// ---------- What's on the graph ----------
function render() {
  if (!root) return;
  nodes = (allSpaces ? state.sessions : projectSessions()).filter(s => (s.kind === 'agent' || s.kind === 'shell') && !s.artifactId && (showExited || !s.exited));
  spaces = allSpaces ? state.projects.map((p, i) => ({ project: p.path, name: p.name, color: TEAM_COLORS[i % TEAM_COLORS.length], ids: nodes.filter(s => s.project === p.path).map(s => s.id) })) : [];
  const ids = new Set(nodes.map(s => s.id));
  for (const id of pos.keys()) if (!ids.has(id)) pos.delete(id);
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
  for (const s of nodes) if (!pos.has(s.id)) pos.set(s.id, spawn(s));

  // One edge per pair that talked, counted both ways, and a dashed one from whoever started an agent.
  const pairs = new Map();
  for (const m of messages) {
    if (!ids.has(m.fromId) || !ids.has(m.toId) || m.fromId === m.toId) continue;
    const key = [m.fromId, m.toId].sort().join(' ');
    const e = pairs.get(key) ?? { kind: 'message', key, a: m.fromId, b: m.toId, count: 0, last: null, ways: new Map() };
    const way = `${m.fromId} ${m.toId}`;
    const w = e.ways.get(way) ?? { from: m.fromId, to: m.toId, count: 0, at: 0 };
    w.count++;
    w.at = Math.max(w.at, m.at);
    e.ways.set(way, w);
    e.count++;
    if (!e.last || m.at >= e.last.at) e.last = m;
    pairs.set(key, e);
  }
  edges = [...pairs.values(), ...nodes.filter(s => ids.has(s.startedBy?.id)).map(s => ({ kind: 'started', key: `started ${s.id}`, a: s.startedBy.id, b: s.id }))];

  drawNodes();
  drawEdges();
  drawHulls();
  drawLegend();
  drawSelBar();
  if (open?.kind === 'node') refreshNode(false);
  if (!nodes.length && !stage.querySelector('.pane-empty')) {
    stage.append(h('div', { class: 'pane-empty graph-empty' }, allSpaces ? 'Nothing running in any space.' : 'Nothing running in this project. Start an agent or a shell and it shows up here.'));
  } else if (nodes.length) stage.querySelector('.graph-empty')?.remove();

  const now = [nodes.map(s => s.id).join(), edges.map(e => e.key).join(), bubbles().map(g => g.ids?.join() ?? g.members.join()).join('|')].join('/');
  if (now !== shape) {
    shape = now;
    follow = !manual;
    heat(1);
  } else place();
}

// Where a node settles: the middle, or with "All spaces" on, its space's spot on a ring around the middle.
function home(s) {
  const cx = size.width / 2 || 400;
  const cy = size.height / 2 || 300;
  const live = spaces.filter(d => d.ids.length);
  const i = live.findIndex(d => d.project === s.project);
  if (live.length < 2 || i < 0) return { cx, cy };
  const r = 120 + 90 * live.length;
  const a = (i / live.length) * 2 * Math.PI - Math.PI / 2;
  return { cx: cx + Math.cos(a) * r, cy: cy + Math.sin(a) * r };
}

// A new node starts next to whoever started it, the lead in the middle, anyone else near the middle.
function spawn(s) {
  const near = pos.get(s.startedBy?.id);
  const { cx, cy } = home(s);
  const jitter = r => (Math.random() - 0.5) * r;
  if (s.role === 'lead') return { x: cx, y: cy, vx: 0, vy: 0, pinned: false };
  return near ? { x: near.x + jitter(120), y: near.y + 60 + jitter(60), vx: 0, vy: 0, pinned: false } : { x: cx + jitter(240), y: cy + jitter(180), vx: 0, vy: 0, pinned: false };
}

function drawNodes() {
  for (const [id, el] of nodeEls) if (!pos.has(id)) { el.remove(); nodeEls.delete(id); }
  for (const s of nodes) {
    let el = nodeEls.get(s.id);
    if (!el) {
      el = h('button', { class: 'gnode', 'data-id': s.id, onPointerdown: e => grab(e, s.id), onDblclick: () => unpin(s.id),
        onClick: e => {
          if (suppressClick) return (suppressClick = false);
          if (e.shiftKey) toggleSelect(s.id);
          else openNode(s.id);
        },
        onKeydown: e => {
          if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); toggleSelect(s.id); }
        } });
      nodeEls.set(s.id, el);
      nodeLayer.append(el);
    }
    const status = actions.statusOf(s);
    const title = chatTitle(s);
    const lead = s.role === 'lead';
    const sub = lead ? 'lead' : s.specialist ? (s.specialist.name === title ? s.specialist.role.split(/[:,]/)[0] : s.specialist.name) : s.kind === 'shell' ? 'shell' : agentLabel(s.agent);
    el.className = `gnode${lead ? ' lead' : ''}${s.exited ? ' exited' : ''}${selected.has(s.id) ? ' selected' : ''}${pos.get(s.id).pinned ? ' pinned' : ''}`;
    el.setAttribute('aria-label', `${title}${allSpaces ? ` in ${spaceName(s)}` : ''}, ${STATUS_LABEL[status]?.toLowerCase() ?? status}${lead ? ', lead' : ''}${selected.has(s.id) ? ', selected' : ''}`);
    el.title = `${title}\nClick for details · Shift-click to select · Drag to pin, double-click to unpin`;
    el.replaceChildren(
      h('span', { class: 'gnode-face' }, avatar(s), h('span', { class: `dot ${status}` })),
      h('span', { class: 'gnode-name' }, title),
      h('span', { class: 'gnode-sub' }, sub));
  }
}

function drawEdges() {
  edgeLayer.replaceChildren();
  for (const e of edges) {
    const fresh = e.kind === 'message' && Date.now() - e.last.at < FRESH;
    const cross = byId(e.a)?.project !== byId(e.b)?.project;
    e.line = svg('path', { class: `graph-edge ${e.kind}${cross ? ' cross' : ''}${fresh ? ' fresh' : ''}${fresh && e.last.fromId !== e.a ? ' rev' : ''}` });
    const hit = svg('path', { class: 'graph-hit' });
    const tip = e.kind === 'started' ? `${nameOf(e.a)} started ${nameOf(e.b)}`
      : [...e.ways.values()].map(w => `${nameOf(w.from)} → ${nameOf(w.to)} · ${plural(w.count, 'message')} · last ${ago(w.at)}`).join('\n');
    hit.addEventListener('pointerenter', ev => showTip(ev, tip));
    hit.addEventListener('pointermove', ev => showTip(ev, tip));
    hit.addEventListener('pointerleave', () => (tipEl.hidden = true));
    const g = svg('g', { class: 'graph-link' });
    g.append(e.line, hit);
    e.hit = hit;
    if (e.kind === 'message') {
      const label = String(e.count);
      e.badge = svg('g', { class: `graph-count${fresh ? ' fresh' : ''}` });
      const w = 10 + label.length * 6.5;
      e.badge.append(svg('rect', { x: -w / 2, y: -8, width: w, height: 16, rx: 8 }), Object.assign(svg('text'), { textContent: label }));
      g.append(e.badge);
    }
    edgeLayer.append(g);
  }
}

function showTip(ev, text) {
  const box = stage.getBoundingClientRect();
  tipEl.textContent = text;
  tipEl.hidden = false;
  tipEl.style.transform = `translate(${Math.min(ev.clientX - box.left + 14, box.width - tipEl.offsetWidth - 8)}px, ${ev.clientY - box.top + 14}px)`;
}

function drawHulls() {
  hullLayer.replaceChildren();
  labelLayer.replaceChildren();
  for (const g of bubbles()) {
    if (!allSpaces) g.ids = nodes.filter(s => g.members.includes(keyOf(s))).map(s => s.id);
    if (!g.ids.length) continue;
    g.hull = svg('path', { class: 'graph-hull', fill: g.color, stroke: g.color, 'stroke-width': PAD * 2 });
    hullLayer.append(g.hull);
    g.label = allSpaces
      ? h('button', { class: 'graph-group-label', style: `--g: ${g.color}`, title: `Go to ${g.name}`, 'aria-label': `${g.name}, ${plural(g.ids.length, 'agent')}. Go to this space.`,
        onClick: () => actions.switchProject(g.project) }, g.name, h('span', { class: 'n' }, g.ids.length))
      : h('button', { class: 'graph-group-label', style: `--g: ${g.color}`, title: `Show the ${g.name} group`, onClick: () => openGroup(g.id) },
        g.name, h('span', { class: 'n' }, g.ids.length));
    labelLayer.append(g.label);
  }
}

function drawLegend() {
  const dot = (status, label) => h('span', {}, h('i', { class: `dot ${status}` }), label);
  legendEl.replaceChildren(
    dot('working', 'Working'), dot('idle', 'Idle'), dot('needs-input', 'Needs you'), dot('exited', 'Exited'),
    h('span', { class: 'sep' }),
    h('span', { class: 'line' }, h('i', { class: 'solid' }), 'Messages'), h('span', { class: 'line' }, h('i', { class: 'dashed' }), 'Started'),
    allSpaces ? h('span', { class: 'line' }, h('i', { class: 'dotted' }), 'Between spaces') : '',
    h('span', { class: 'sep' }),
    h('span', { class: 'graph-hint' }, 'Drag to pan · Pinch or ⌘-scroll to zoom · Shift-drag to select'),
    groups.length > 0 ? h('span', { class: 'sep' }) : '',
    ...groups.map(g => h('button', { class: 'graph-chip', style: `--g: ${g.color}`, onClick: () => openGroup(g.id) }, g.name)));
}

function drawSelBar() {
  selBar.hidden = !selected.size || allSpaces; // groups belong to one project
  if (!selected.size) return selBar.replaceChildren();
  const ids = [...selected];
  selBar.replaceChildren(
    h('span', {}, `${selected.size} selected`),
    h('button', { class: 'btn sm primary', onClick: () => makeGroup(ids) }, icon('plus', 13), 'Make a group'),
    groups.length > 0 && h('button', { class: 'btn sm', onClick: e => addToMenu(e.currentTarget, ids) }, 'Add to group', icon('chevron', 12)),
    h('button', { class: 'icon-btn', title: 'Clear the selection (Esc)', 'aria-label': 'Clear the selection', onClick: () => setSelection([]) }, icon('x', 14)));
}

// ---------- Layout: repulsion, edge springs, a pull toward each group, and the lead near the middle ----------
function tick() {
  const { width: W, height: H } = size;
  const list = nodes.map(s => [s, pos.get(s.id)]);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const p = list[i][1];
      const q = list[j][1];
      let dx = p.x - q.x;
      let dy = p.y - q.y;
      if (!dx && !dy) dx = Math.random() - 0.5;
      const d2 = Math.max(dx * dx + dy * dy, 400);
      const f = (36000 / d2) * alpha;
      const d = Math.sqrt(d2);
      p.vx += (dx / d) * f; p.vy += (dy / d) * f;
      q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
    }
  }
  for (const e of edges) {
    const p = pos.get(e.a);
    const q = pos.get(e.b);
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    const f = (d - (e.kind === 'started' ? 230 : 210)) * 0.03 * alpha;
    p.vx += (dx / d) * f; p.vy += (dy / d) * f;
    q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
  }
  for (const g of bubbles()) {
    const members = (g.ids ?? []).map(id => pos.get(id)).filter(Boolean);
    if (members.length < 2) continue;
    const cx = members.reduce((n, p) => n + p.x, 0) / members.length;
    const cy = members.reduce((n, p) => n + p.y, 0) / members.length;
    for (const p of members) { p.vx += (cx - p.x) * 0.04 * alpha; p.vy += (cy - p.y) * 0.04 * alpha; }
  }
  for (const [s, p] of list) {
    const k = (s.role === 'lead' ? 0.08 : allSpaces ? 0.03 : 0.012) * alpha;
    const { cx, cy } = allSpaces ? home(s) : { cx: W / 2, cy: H / 2 };
    p.vx += (cx - p.x) * k;
    p.vy += (cy - p.y) * k;
    if (p.pinned || dragging === s.id) { p.vx = p.vy = 0; continue; }
    p.vx *= 0.6;
    p.vy *= 0.6;
    p.x += p.vx;
    p.y += p.vy;
  }
}

function heat(a) {
  alpha = Math.max(alpha, a);
  if (!isShown() || !size.width) return;
  if (still.matches) { // no motion: settle at once
    for (let i = 0; i < 300 && alpha > 0.005; i++, alpha *= 0.97) tick();
    alpha = 0;
    if (follow) glideTo(fitView());
    follow = false;
    return place();
  }
  kick();
}

function kick() {
  if (running || !isShown()) return;
  running = true;
  requestAnimationFrame(frame);
}

function frame(now) {
  if (alpha > 0.005) {
    tick();
    alpha *= 0.97;
  } else alpha = 0;
  if (follow && !manual) aim = fitView(); // frame the graph as it settles
  if (!alpha) follow = false;
  glide();
  place();
  drawPulses(now);
  running = isShown() && (alpha > 0 || pulses.length > 0 || dragging !== null || aim !== null);
  if (running) requestAnimationFrame(frame);
}

function relayout() {
  for (const p of pos.values()) p.pinned = false;
  drawNodes();
  manual = false;
  follow = true;
  heat(1);
}

// ---------- The camera: pan, zoom and fit ----------
function applyView() {
  if (!world) return;
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  stage.style.backgroundPosition = `${view.x}px ${view.y}px`; // the dots move with the world
  stage.style.backgroundSize = `${24 * view.k}px ${24 * view.k}px`;
  zoomLabel.textContent = `${Math.round(view.k * 100)}%`;
}

// Each frame, a fraction of the way to where it's going; with reduced motion, straight there.
function glide() {
  if (!aim) return;
  const t = still.matches ? 1 : 0.2;
  view = { x: view.x + (aim.x - view.x) * t, y: view.y + (aim.y - view.y) * t, k: view.k + (aim.k - view.k) * t };
  if (Math.abs(aim.x - view.x) < 0.5 && Math.abs(aim.y - view.y) < 0.5 && Math.abs(aim.k - view.k) < 0.001) {
    view = aim;
    aim = null;
  }
  applyView();
}
function glideTo(v) {
  aim = v;
  if (still.matches) glide();
  else kick();
}

// The part of the canvas you can see: not under the side panel, and above the legend.
function room() {
  const right = panel ? panel.offsetLeft - 10 : size.width;
  return { left: 0, top: 44, right, bottom: size.height - 52 }; // below the zoom control
}

// Zoom by f, keeping the world point under (sx, sy) on the screen where it is.
function zoomed(f, sx, sy, from = view) {
  const k = Math.min(ZOOM[1], Math.max(ZOOM[0], from.k * f));
  return { k, x: sx - ((sx - from.x) * k) / from.k, y: sy - ((sy - from.y) * k) / from.k };
}
function zoomBy(f) {
  const r = room();
  manual = true;
  glideTo(zoomed(f, (r.left + r.right) / 2, (r.top + r.bottom) / 2, aim ?? view));
}
function panBy(dx, dy) {
  manual = true;
  aim = null;
  view = { ...view, x: view.x + dx, y: view.y + dy };
  applyView();
}

// The view that shows every node and group bubble, with some room around them. Never zoomed in past 100%.
function fitView() {
  const r = room();
  let box = null;
  const take = (l, t, rr, b) => (box = box ? { l: Math.min(box.l, l), t: Math.min(box.t, t), r: Math.max(box.r, rr), b: Math.max(box.b, b) } : { l, t, r: rr, b });
  for (const s of nodes) (p => p && take(p.x - 70, p.y - 32, p.x + 70, p.y + 62))(pos.get(s.id));
  for (const g of bubbles()) for (const id of g.ids ?? []) (p => p && take(p.x - PAD, p.y + 18 - PAD - 32, p.x + PAD, p.y + 18 + PAD))(pos.get(id));
  if (!box || r.right - r.left < 120) return { ...view };
  const k = Math.min(1, Math.max(ZOOM[0], Math.min((r.right - r.left - 48) / (box.r - box.l), (r.bottom - r.top - 48) / (box.b - box.t))));
  return { k, x: (r.left + r.right) / 2 - ((box.l + box.r) / 2) * k, y: (r.top + r.bottom) / 2 - ((box.t + box.b) / 2) * k };
}
const fitNow = () => {
  manual = false;
  glideTo(fitView());
};

// Brings a node into the part of the canvas you can see, when it's outside it.
function reveal(id) {
  const p = pos.get(id);
  if (!p) return;
  const r = room();
  const v = aim ?? view;
  const sx = p.x * v.k + v.x;
  const sy = p.y * v.k + v.y;
  if (sx > r.left + 80 && sx < r.right - 80 && sy > r.top + 50 && sy < r.bottom - 70) return;
  glideTo({ ...v, x: v.x + (r.left + r.right) / 2 - sx, y: v.y + (r.top + r.bottom) / 2 - sy });
}

// Two fingers or the wheel pan; a pinch (which arrives as ctrl+wheel) or ⌘/ctrl+wheel zooms around the pointer.
function wheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const box = stage.getBoundingClientRect();
    const dy = Math.max(-40, Math.min(40, e.deltaMode ? e.deltaY * 16 : e.deltaY));
    manual = true;
    aim = null;
    view = zoomed(Math.exp(-dy * 0.008), e.clientX - box.left, e.clientY - box.top);
    applyView();
  } else panBy(-(e.deltaMode ? e.deltaX * 16 : e.deltaX), -(e.deltaMode ? e.deltaY * 16 : e.deltaY));
}

// Dragging the empty canvas pans it. A click without a drag clears the selection, as before.
function pan(e) {
  if (e.button !== 0 || e.target.closest('.gnode, .graph-group-label, .pane-empty')) return;
  e.preventDefault(); // no text selection, and no stray focus
  stage.focus({ preventScroll: true });
  stage.setPointerCapture(e.pointerId);
  let last = { x: e.clientX, y: e.clientY };
  let moved = false;
  const move = ev => {
    if (!(ev.buttons & 1)) return end(); // the button came up somewhere we didn't hear about
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
    moved = true;
    stage.classList.add('panning');
    panBy(ev.clientX - last.x, ev.clientY - last.y);
    last = { x: ev.clientX, y: ev.clientY };
  };
  const end = () => {
    stage.removeEventListener('pointermove', move);
    stage.removeEventListener('pointerup', end);
    stage.removeEventListener('pointercancel', end);
    stage.classList.remove('panning');
    if (!moved) setSelection([]);
  };
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

function keys(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select')) return;
  const step = e.shiftKey ? 240 : 60;
  const go = { ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0), ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step),
    '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(1 / 1.25), _: () => zoomBy(1 / 1.25), 0: fitNow }[e.key];
  if (!go) return;
  e.preventDefault();
  go();
}

const unpin = id => {
  const p = pos.get(id);
  if (!p?.pinned) return;
  p.pinned = false;
  nodeEls.get(id)?.classList.remove('pinned');
  heat(0.4);
};

// Puts everything where the layout says.
function place() {
  for (const [id, el] of nodeEls) {
    const p = pos.get(id);
    if (p) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }
  for (const e of edges) {
    const p = pos.get(e.a);
    const q = pos.get(e.b);
    let d = `M${p.x},${p.y} L${q.x},${q.y}`;
    if (e.kind === 'started') { // a gentle curve, so it doesn't hide under a message edge between the same two
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const mx = (p.x + q.x) / 2 + ((q.y - p.y) / len) * 22;
      const my = (p.y + q.y) / 2 - ((q.x - p.x) / len) * 22;
      d = `M${p.x},${p.y} Q${mx},${my} ${q.x},${q.y}`;
    }
    e.line.setAttribute('d', d);
    e.hit.setAttribute('d', d);
    e.badge?.setAttribute('transform', `translate(${(p.x + q.x) / 2}, ${(p.y + q.y) / 2})`);
  }
  for (const g of bubbles()) {
    if (!g.hull) continue;
    const points = g.ids.map(id => pos.get(id)).filter(Boolean).map(p => [p.x, p.y + 18]); // a little low, to take in the name
    if (!points.length) continue;
    const hull = convexHull(points);
    g.hull.setAttribute('d', hull.length === 1 ? `M${hull[0][0]},${hull[0][1]} l0.01,0` : `M${hull.map(p => p.join(',')).join(' L')} Z`);
    const top = Math.min(...points.map(p => p[1])) - PAD - 18;
    const cx = points.reduce((n, p) => n + p[0], 0) / points.length;
    g.label.style.transform = `translate(${cx}px, ${top}px) translate(-50%, -50%)`;
  }
}

// Andrew's monotone chain. A thick round stroke on the hull turns it into a padded, rounded bubble.
function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = list => list.reduce((out, p) => {
    while (out.length >= 2 && cross(out.at(-2), out.at(-1), p) <= 0) out.pop();
    out.push(p);
    return out;
  }, []);
  const lower = half(pts);
  const upper = half([...pts].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// A message travelling from sender to receiver.
function pulse(from, to) {
  if (still.matches || !pos.has(from) || !pos.has(to)) return;
  const el = svg('circle', { class: 'graph-pulse', r: 5 });
  pulseLayer.append(el);
  pulses.push({ from, to, start: performance.now(), el });
  heat(0);
  if (!running) { running = true; requestAnimationFrame(frame); }
}

function drawPulses(now) {
  for (const p of [...pulses]) {
    const t = Math.min(1, (now - p.start) / 1100);
    const a = pos.get(p.from);
    const b = pos.get(p.to);
    if (t >= 1 || !a || !b) {
      p.el.remove();
      pulses.splice(pulses.indexOf(p), 1);
      continue;
    }
    const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    p.el.setAttribute('cx', a.x + (b.x - a.x) * k);
    p.el.setAttribute('cy', a.y + (b.y - a.y) * k);
  }
}

// ---------- Dragging, selecting and the lasso ----------
function grab(e, id) {
  if (e.button !== 0) return;
  e.stopPropagation(); // not a lasso
  const p = pos.get(id);
  const el = e.currentTarget;
  const start = { x: e.clientX, y: e.clientY, px: p.x, py: p.y };
  let moved = false;
  const move = ev => {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) {
      moved = true;
      dragging = id;
      follow = false; // the camera holds still under your hand
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging', 'pinned');
    }
    Object.assign(p, { x: start.px + dx / view.k, y: start.py + dy / view.k, vx: 0, vy: 0, pinned: true });
    heat(0.25);
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (!moved) return;
    dragging = null;
    suppressClick = true;
    setTimeout(() => (suppressClick = false)); // the click that ends a drag opens nothing
    el.classList.remove('dragging');
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

// Shift-dragging the empty canvas draws a box that selects the nodes inside it.
function lasso(e) {
  if (e.button !== 0 || e.target.closest('.gnode, .graph-group-label, .pane-empty')) return;
  e.preventDefault();
  const box = stage.getBoundingClientRect();
  const x0 = e.clientX - box.left;
  const y0 = e.clientY - box.top;
  let rect = null;
  const move = ev => {
    const x1 = ev.clientX - box.left;
    const y1 = ev.clientY - box.top;
    if (!rect && Math.hypot(x1 - x0, y1 - y0) < 4) return;
    rect = { left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1) };
    lassoEl.hidden = false;
    Object.assign(lassoEl.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px` });
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    lassoEl.hidden = true;
    if (!rect) return e.shiftKey || setSelection([]); // a click on empty space clears the selection
    const inside = nodes.filter(s => (p => (x => x >= rect.left && x <= rect.right)(p.x * view.k + view.x) && (y => y >= rect.top && y <= rect.bottom)(p.y * view.k + view.y))(pos.get(s.id))).map(s => s.id);
    setSelection(e.shiftKey ? [...selected, ...inside] : inside);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

function setSelection(ids) {
  selected.clear();
  for (const id of ids) selected.add(id);
  drawNodes();
  drawSelBar();
}
const toggleSelect = id => setSelection(selected.has(id) ? [...selected].filter(x => x !== id) : [...selected, id]);

// ---------- Groups ----------
function swatches(get, set) {
  const mark = () => buttons.forEach((b, i) => {
    b.classList.toggle('on', TEAM_COLORS[i] === get());
    b.setAttribute('aria-pressed', String(TEAM_COLORS[i] === get()));
  });
  const buttons = TEAM_COLORS.map(c => h('button', { type: 'button', style: { background: c }, 'aria-label': `Colour ${c}`, onClick: () => { set(c); mark(); } }));
  mark();
  return h('div', { class: 'swatches', role: 'group', 'aria-label': 'Colour' }, buttons);
}

function makeGroup(ids) {
  let color = TEAM_COLORS[groups.length % TEAM_COLORS.length];
  const name = h('input', { class: 'input', placeholder: 'tester', maxLength: 30 });
  const create = async () => {
    try {
      const members = ids.map(byId).filter(Boolean).map(keyOf);
      await api('POST', '/api/groups', { project: state.project, name: name.value, color, members });
      setSelection([]);
      await loadGroups();
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  };
  const close = modal({
    title: 'Make a group', width: 420,
    body: [h('label', { class: 'field' }, h('span', {}, 'Name'), name), h('div', { class: 'field' }, h('span', {}, 'Colour'), swatches(() => color, c => (color = c)))],
    actions: [{ label: 'Cancel' }, { label: `Group ${plural(ids.length, 'node')}`, primary: true, onClick: create }],
  });
  name.addEventListener('keydown', async e => e.key === 'Enter' && (await create()) !== false && close());
}

const patchGroup = guard(async (id, body) => {
  await api('PATCH', `/api/groups/${id}`, body);
  await loadGroups();
});

function addToMenu(anchor, ids) {
  const keys = ids.map(byId).filter(Boolean).map(keyOf);
  menu(anchor, [
    { heading: 'Add to group' },
    ...groups.map(g => ({ label: g.name, icon: keys.every(k => g.members.includes(k)) ? 'check' : 'layers',
      onClick: () => patchGroup(g.id, { members: [...new Set([...g.members, ...keys])] }) })),
    'sep',
    { label: 'New group…', icon: 'plus', onClick: () => makeGroup(ids) },
  ]);
}

// ---------- The side panel: one agent, or one group ----------
function closePanel(refocus = false) {
  const was = open;
  panel?.remove();
  panel = null;
  open = null;
  dropMirror();
  clearInterval(poll);
  poll = null;
  if (refocus && was?.kind === 'node') nodeEls.get(was.id)?.focus();
}

function frameFor(title, head, body, foot) {
  const again = panel?.getAttribute('aria-label') === title; // redrawn in place: no slide-in, and focus stays put
  const focused = again && document.activeElement?.getAttribute('aria-label');
  dropMirror();
  panel?.remove();
  panel = h('div', { class: `drawer graph-panel${again ? ' still' : ''}`, role: 'dialog', 'aria-label': title },
    h('div', { class: 'drawer-head' }, head, h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => closePanel(true) }, icon('x'))),
    h('div', { class: 'drawer-body' }, body), foot);
  root.append(panel);
  if (focused) [...panel.querySelectorAll('[aria-label]')].find(el => el.getAttribute('aria-label') === focused)?.focus();
}

let refs = {};
function openNode(id) {
  const s = byId(id);
  if (!s) return;
  open = { kind: 'node', id };
  const ask = s.kind === 'agent' && !s.exited;
  refs = {
    status: h('span', { class: 'chip' }),
    facts: h('div', { class: 'graph-facts' }),
    groups: h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }),
    screen: h('div', { class: 'graph-term', tabIndex: 0, title: 'Open its pane', 'aria-label': `${chatTitle(s)}'s screen. Enter opens its pane.`,
      onClick: () => actions.focusSession(s.id), onKeydown: e => e.key === 'Enter' && actions.focusSession(s.id) }),
    live: h('span', { class: 'graph-live' }),
    opened: new Set(), // long messages you've unfolded, by their text
    chat: h('div', { class: 'activity' }),
    input: ask && h('textarea', { class: 'input', rows: 2, placeholder: `Ask ${chatTitle(s)} something…`, 'aria-label': `Ask ${chatTitle(s)}`,
      onKeydown: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAsk(); } } }),
  };
  frameFor(chatTitle(s),
    [avatar(s), h('div', { class: 'graph-panel-title' }, h('b', {}, chatTitle(s)), refs.status)],
    [
      h('div', { class: 'actions-row' },
        h('button', { class: 'btn sm', onClick: () => actions.focusSession(s.id) }, icon('terminal', 13), 'Go to pane'),
        !allSpaces && h('button', { class: 'btn sm', onClick: e => addToMenu(e.currentTarget, [s.id]) }, icon('plus', 13), 'Add to group')),
      refs.facts,
      refs.groups,
      h('div', { class: 'graph-screen-head' }, h('span', { class: 'section-label' }, 'Screen'), refs.live, h('span', { class: 'grow' }),
        h('button', { class: 'btn xs', onClick: () => actions.focusSession(s.id) }, 'Open pane ↗')),
      refs.screen,
      s.kind === 'agent' && [h('div', { class: 'section-label', style: { marginTop: '20px' } }, 'Conversation'), refs.chat],
    ],
    ask && h('div', { class: 'graph-ask' }, refs.input,
      h('button', { class: 'btn primary', title: 'Send (Enter). Typed into its pane as you.', onClick: () => sendAsk() }, icon('send', 14), 'Ask')));
  (refs.input || panel.querySelector('.drawer-head .icon-btn')).focus();
  reveal(id); // not hidden behind the panel
  screenOf(s);
  refreshNode(true);
  clearInterval(poll);
  poll = setInterval(() => isShown() && open?.kind === 'node' && refreshNode(true), 6000); // the conversation; the screen is live
}

const sendAsk = guard(async () => {
  const text = refs.input.value.trim();
  if (!text || !open) return;
  await api('POST', `/api/sessions/${open.id}/input`, { text }); // no agent headers: it's typed as you, as in its pane
  refs.input.value = '';
  setTimeout(() => open?.kind === 'node' && refreshNode(true), 1500);
});

async function refreshNode(withChat) {
  const s = open && byId(open.id);
  if (!s) return closePanel();
  paintStatus(s);
  if (mirror?.id === s.id && s.exited) screenOf(s); // it just finished
  else if (mirror?.id === s.id && s.cols && (s.cols !== mirror.term.cols || s.rows !== mirror.term.rows)) {
    mirror.term.resize(s.cols, s.rows);
    mirror.fit();
  }
  const task = s.taskId && state.tasks.find(t => t.id === s.taskId);
  const fact = (label, ...value) => h('div', { class: 'graph-fact' }, h('span', { class: 'section-label' }, label), h('div', {}, ...value));
  refs.facts.replaceChildren(...[
    fact('Runs', s.kind === 'shell' ? 'Shell' : [agentLabel(s.agent), s.specialist && ` · ${s.specialist.name}`, s.role === 'lead' && ' · lead', ` · ${s.model || 'default model'}, ${s.effort || 'default'} effort`]),
    s.asked && fact('Asked', h('div', { class: 'graph-asked' }, s.asked)),
    task && fact('Task', h('button', { class: 'btn xs', onClick: () => actions.openTask(task.id) }, icon('board', 12), task.title), ' ', h('span', { class: 'chip' }, task.status)),
    s.startedBy && fact('Started by', s.startedBy.name),
  ].filter(Boolean));
  const mine = groupsOf(s);
  refs.groups.replaceChildren(...mine.map(g => h('button', { class: 'graph-chip', style: `--g: ${g.color}`, onClick: () => openGroup(g.id) }, g.name)));
  try {
    if (withChat && s.kind === 'agent') {
      const chat = await api('GET', `/api/sessions/${s.id}/chat?last=6`);
      const said = JSON.stringify(chat.messages ?? []);
      if (said === refs.said) return; // nothing new: leave what you unfolded or selected alone
      refs.said = said;
      refs.chat.replaceChildren(...(chat.messages?.length ? chat.messages.map(m => h('div', { class: 'note' },
        h('div', { class: 'who' }, h('b', {}, m.from === 'user' ? 'You (or another agent)' : chatTitle(s))), saidOf(m.text)))
        : [h('div', { class: 'muted' }, 'Nothing said yet.')]));
    }
  } catch {} // it stopped or went away; the next refresh catches up
}

// A message as Markdown, with its "(used <tool>)" lines as small chips. A long one folds to about 10 lines.
function saidOf(text) {
  const parts = [];
  let words = [];
  const flush = () => {
    if (words.join('').trim()) parts.push(...markdown(words.join('\n')));
    words = [];
  };
  for (const line of text.split('\n')) {
    const tool = line.match(/^\(used (.+)\)$/)?.[1];
    if (!tool) {
      words.push(line);
      continue;
    }
    flush();
    if (parts.at(-1)?.className !== 'said-tools') parts.push(h('div', { class: 'said-tools' }));
    parts.at(-1).append(h('span', { class: 'chip', title: tool }, tool.replace(/^mcp__.+?__/, '')));
  }
  flush();
  const open = refs.opened.has(text);
  const body = h('div', { class: `md said${open ? '' : ' folded'}` }, parts);
  const more = h('button', { class: 'linkish said-more', hidden: !open, 'aria-expanded': String(open), onClick: () => {
    const folded = body.classList.toggle('folded');
    folded ? refs.opened.delete(text) : refs.opened.add(text);
    more.textContent = folded ? 'Show more' : 'Show less';
    more.setAttribute('aria-expanded', String(!folded));
  } }, open ? 'Show less' : 'Show more');
  requestAnimationFrame(() => { // once laid out: a short one needs no fold, nor its fade
    if (open) return;
    more.hidden = body.scrollHeight <= body.clientHeight + 2;
    body.classList.toggle('folded', !more.hidden);
  });
  return [body, more];
}

function paintStatus(s) {
  const flowing = mirror?.id === s.id && mirror.quiet && actions.statusOf(s) === 'idle'; // its screen is moving; the pane may not have heard yet
  const status = flowing ? 'working' : actions.statusOf(s);
  refs.status.replaceChildren(h('span', { class: `dot ${status}` }), STATUS_LABEL[status] ?? status);
}

// ---------- Its screen: a small, read-only copy of its pane, live ----------
// Exactly the pty's columns and rows, because full-screen programs like Claude Code place text by position.
// The font shrinks (to 9px) to fit the columns in the panel, and the box shows 22 rows ending at the last line
// with anything on it, where the prompt and the latest output are (a shell's screen is mostly empty below that).
function screenOf(s) {
  dropMirror();
  const box = refs.screen;
  box.classList.toggle('done', s.exited);
  box.style.height = '';
  refs.live.className = `graph-live${s.exited ? ' done' : ''}`;
  refs.live.replaceChildren(h('i'), s.exited ? 'finished' : 'live');
  if (s.exited) {
    // Nothing more will happen: show how its screen ended, once.
    const text = h('pre', {}, 'Loading…');
    box.replaceChildren(text);
    api('GET', `/api/sessions/${s.id}/output?lines=25`).then(r => {
      text.textContent = r.text || '(nothing on screen)';
      box.scrollTop = box.scrollHeight;
    }, () => (text.textContent = '(its screen is gone)'));
    return;
  }
  box.replaceChildren();
  const term = new Terminal({
    fontFamily: MONO, fontSize: 11, lineHeight: 1.2, cols: s.cols || 120, rows: s.rows || 32, scrollback: 500,
    theme: state.termTheme, disableStdin: true, cursorBlink: false, cursorInactiveStyle: 'none',
  });
  term.open(box);
  term.textarea.tabIndex = -1; // the box takes focus, not xterm's hidden input
  const m = mirror = { id: s.id, term, box, follow: true, carry: 0 };
  const screen = box.querySelector('.xterm-screen');
  const rowPx = () => screen.offsetHeight / term.rows;
  const end = () => { // the box's scrollTop that puts the last used row at its bottom
    const buf = term.buffer.active;
    let last = buf.cursorY;
    for (let y = term.rows - 1; y > last; y--) if (buf.getLine(buf.viewportY + y)?.translateToString(true).trim()) { last = y; break; }
    return Math.max(0, Math.min((last + 1) * rowPx() - (box.clientHeight - parseFloat(getComputedStyle(box).paddingTop)), box.scrollHeight - box.clientHeight));
  };
  const atEnd = () => term.buffer.active.viewportY === term.buffer.active.baseY && box.scrollTop >= end() - 2;
  m.toEnd = () => { box.scrollTop = end(); };
  m.fit = () => {
    const css = getComputedStyle(box);
    const room = box.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    if (room <= 0) return;
    const perPx = screen.offsetWidth / term.cols / term.options.fontSize; // a column's width per px of font
    let size = Math.min(12, Math.max(9, Math.floor((room / term.cols / perPx) * 2) / 2));
    term.options.fontSize = size;
    while (size > 9 && screen.offsetWidth > room) term.options.fontSize = size -= 0.5; // rounding can leave it a hair wide
    box.style.height = `${Math.min(term.rows, 22) * rowPx() + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom) + (screen.offsetWidth > room ? 10 : 0)}px`;
    if (m.follow) m.toEnd();
  };
  m.ro = new ResizeObserver(() => requestAnimationFrame(() => mirror === m && m.fit())); // next frame: refitting resizes xterm, which it observes too
  m.ro.observe(box.parentElement); // the panel's width; the box's own height is set here
  term.onWriteParsed(() => m.follow && m.toEnd());
  // Follow the end as output arrives, unless you've scrolled up to read; scrolling back down follows again.
  box.addEventListener('scroll', () => (m.follow = atEnd()));
  // One scroll through all of it: going up, the box first moves to the top of the screen, then xterm goes back
  // through older lines; going down, the reverse. xterm never sees the wheel, so its own scrolling can't fight the box's.
  box.addEventListener('wheel', e => {
    e.preventDefault();
    e.stopPropagation();
    const row = rowPx();
    const dy = e.deltaMode ? e.deltaY * row : e.deltaY;
    box.scrollLeft += e.deltaMode ? e.deltaX * row : e.deltaX;
    const buf = term.buffer.active;
    if ((dy < 0 && box.scrollTop <= 0) || (dy > 0 && buf.viewportY < buf.baseY)) {
      m.carry += dy;
      const n = Math.trunc(m.carry / row);
      m.carry -= n * row;
      if (n) term.scrollLines(n);
      m.follow = atEnd();
    } else box.scrollTop += dy;
  }, { capture: true, passive: false });
  connectMirror(m);
}

// Only ever reads. A pane sends keystrokes and its size on this socket, and a size from this small copy would
// shrink the agent's real terminal and garble its pane, so nothing is ever sent.
function connectMirror(m) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?id=${m.id}`);
  let first = true;
  m.ws = ws;
  ws.onmessage = e => {
    if (first) {
      m.term.reset(); // each (re)connect brings a fresh copy of the whole screen
      first = false;
    } else busy(m);
    m.term.write(e.data);
  };
  ws.onclose = () => setTimeout(() => mirror === m && connectMirror(m), 1500);
}

// The "live" dot pulses while output is flowing.
function busy(m) {
  const paint = on => {
    refs.live.classList.toggle('busy', on);
    if (byId(m.id)) paintStatus(byId(m.id));
  };
  if (!m.quiet) paint(true);
  clearTimeout(m.quiet);
  m.quiet = setTimeout(() => {
    m.quiet = null;
    if (mirror === m) paint(false);
  }, 2500);
}

function dropMirror() {
  const m = mirror;
  if (!m) return;
  mirror = null;
  clearTimeout(m.quiet);
  m.ro.disconnect();
  m.ws.close();
  m.term.dispose();
}

function openGroup(id) {
  open = { kind: 'group', id };
  clearInterval(poll);
  groupPanel(true);
}

function groupPanel(focus = false) {
  const g = groups.find(x => x.id === open?.id);
  if (!g) return closePanel();
  const name = h('input', { class: 'input', value: g.name, maxLength: 30, 'aria-label': 'Group name',
    onKeydown: e => e.key === 'Enter' && e.target.blur(), onChange: e => e.target.value.trim() !== g.name && patchGroup(g.id, { name: e.target.value }) });
  const live = state.sessions.filter(s => s.project === state.project);
  const members = g.members.map(key => {
    const s = live.find(x => keyOf(x) === key && !x.exited) ?? live.find(x => keyOf(x) === key);
    const label = s ? chatTitle(s) : state.chats.find(c => c.id === key)?.title ?? 'Not running';
    const status = s ? actions.statusOf(s) : 'exited';
    return h('div', { class: 'graph-member' },
      s ? avatar(s, true) : h('span', { class: 'avatar sm shell' }, icon('terminal', 11)),
      s ? h('button', { class: 'linkish', onClick: () => openNode(s.id) }, label) : h('span', { class: 'muted' }, label),
      h('span', { class: 'grow' }),
      h('span', { class: 'chip' }, h('span', { class: `dot ${status}` }), s ? STATUS_LABEL[status] : 'Not running'),
      h('button', { class: 'icon-btn sm', title: `Take ${label} out of ${g.name}`, 'aria-label': `Remove ${label}`,
        onClick: () => patchGroup(g.id, { members: g.members.filter(m => m !== key) }) }, icon('x', 12)));
  });
  const adding = [...selected].map(byId).filter(s => s && !g.members.includes(keyOf(s)));
  frameFor(`${g.name} group`,
    [h('span', { class: 'graph-swatch', style: { background: g.color } }), h('div', { class: 'graph-panel-title' }, h('b', {}, g.name), h('span', { class: 'chip' }, plural(g.members.length, 'member')))],
    [
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('div', { class: 'field' }, h('span', {}, 'Colour'), swatches(() => g.color, c => patchGroup(g.id, { color: c }))),
      h('div', { class: 'section-label' }, 'Members'),
      members.length ? members : h('div', { class: 'muted' }, 'No one yet. Select nodes on the graph, then add them.'),
      adding.length > 0 && h('button', { class: 'btn sm', style: { marginTop: '10px' }, onClick: () => patchGroup(g.id, { members: [...g.members, ...adding.map(keyOf)] }) },
        icon('plus', 13), `Add the ${plural(adding.length, 'selected node')}`),
      h('div', { class: 'actions-row', style: { marginTop: '24px' } },
        h('button', { class: 'btn sm danger', onClick: guard(async () => {
          if (!(await confirmDialog(`Delete the ${g.name} group?`, 'Its members keep running. Only the group goes.', { label: 'Delete group', danger: true }))) return;
          await api('DELETE', `/api/groups/${g.id}`);
          closePanel();
          await loadGroups();
        }) }, icon('trash', 13), 'Delete group')),
    ]);
  if (focus) name.focus();
}
