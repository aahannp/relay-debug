// Screenshots view: capture the screen, paste or drop an image, mark it up, save it into the project,
// and hand its path to an agent so it can look at it.
import { state, api, h, icon, on, toast, guard, actions, menu, baseName, copy, ago } from './ui.js';

const COLORS = ['#f87171', '#facc15', '#22d3ee', '#4ade80', '#ffffff', '#111111'];
const TOOLS = [['arrow', 'arrow', 'Arrow'], ['box', 'box', 'Box'], ['pen', 'pen', 'Draw'], ['text', 'text', 'Text']];
let canvas, ctx, wrap, placeholder, gallery, saveBtn;
let image = null;
let shapes = [];
let drawing = null;
let tool = 'arrow';
let color = COLORS[0];
const toolButtons = {};
const swatchButtons = [];

export function mount(el) {
  canvas = h('canvas', { hidden: true });
  ctx = canvas.getContext('2d');
  placeholder = h('div', { class: 'empty-card' },
    h('div', { class: 'art' }, icon('camera', 34)),
    h('h2', {}, 'Show an agent what you mean'),
    h('p', {}, 'Capture your screen, paste an image with ⌘V, or drop a file here. Mark it up, then send it: the agent gets the file path and looks at the picture.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onClick: () => capture() }, icon('monitor', 15), 'Capture screen'),
      h('button', { class: 'btn', onClick: () => picker.click() }, icon('image', 15), 'Open image')));
  const picker = h('input', { type: 'file', accept: 'image/*', hidden: true, onChange: () => picker.files[0] && loadBlob(picker.files[0]) });
  wrap = h('div', {
    class: 'canvas-wrap',
    onDragover: e => { e.preventDefault(); wrap.classList.add('drop'); },
    onDragleave: () => wrap.classList.remove('drop'),
    onDrop: e => {
      e.preventDefault();
      wrap.classList.remove('drop');
      const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
      if (file) loadBlob(file);
    },
  }, placeholder, canvas, picker);

  for (const [id, name, label] of TOOLS) {
    toolButtons[id] = h('button', { class: `btn sm ghost tool${tool === id ? ' on' : ''}`, title: label, onClick: () => setTool(id) }, icon(name, 14), label);
  }
  const swatches = h('div', { class: 'swatches' }, COLORS.map(c => {
    const b = h('button', { style: { background: c }, title: c, class: c === color ? 'on' : '', onClick: () => { color = c; swatchButtons.forEach(x => x.classList.toggle('on', x === b)); } });
    swatchButtons.push(b);
    return b;
  }));
  saveBtn = h('button', { class: 'btn sm primary', onClick: e => saveAndSend(e.currentTarget) }, icon('send', 13), 'Save and send');
  const bar = h('div', { class: 'shot-tools' },
    h('button', { class: 'btn sm', onClick: () => capture() }, icon('monitor', 13), 'Capture'),
    h('button', { class: 'btn sm', onClick: () => picker.click() }, icon('image', 13), 'Open'),
    h('span', { class: 'sep' }), ...Object.values(toolButtons), h('span', { class: 'sep' }), swatches, h('span', { class: 'sep' }),
    h('button', { class: 'icon-btn', title: 'Undo', onClick: () => { shapes.pop(); redraw(); } }, icon('undo', 15)),
    h('button', { class: 'icon-btn', title: 'Start over', onClick: () => setImage(null) }, icon('trash', 15)),
    h('span', { class: 'grow' }), saveBtn);
  gallery = h('div', { class: 'gallery' });
  el.append(h('div', { class: 'shots' }, h('div', { class: 'shot-stage' }, bar, wrap), gallery));

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', moveTo);
  canvas.addEventListener('pointerup', up);
  document.addEventListener('paste', e => {
    if (actions.currentView() !== 'shots') return;
    const file = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'))?.getAsFile();
    if (file) {
      e.preventDefault();
      loadBlob(file);
    }
  });
  on('project', loadGallery);
}

export const show = () => loadGallery();
export const toolbar = () => [h('button', { class: 'btn sm', onClick: () => capture() }, icon('monitor', 13), 'Capture screen')];

function setTool(id) {
  tool = id;
  for (const [key, b] of Object.entries(toolButtons)) b.classList.toggle('on', key === id);
}

// ---------- Getting an image ----------
async function loadBlob(blob) {
  setImage(await createImageBitmap(blob));
}

function setImage(img) {
  image = img;
  shapes = [];
  canvas.hidden = !img;
  placeholder.hidden = Boolean(img);
  if (img) {
    canvas.width = img.width;
    canvas.height = img.height;
    redraw();
  }
}

const capture = async () => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast(`Screen capture failed: ${e.message}`, 'error');
    return;
  }
  const video = h('video', { muted: true, playsInline: true });
  video.srcObject = stream;
  await video.play();
  await new Promise(resolve => setTimeout(resolve, 300)); // let a real frame arrive
  const frame = new OffscreenCanvas(video.videoWidth, video.videoHeight);
  frame.getContext('2d').drawImage(video, 0, 0);
  stream.getTracks().forEach(t => t.stop());
  setImage(await createImageBitmap(frame));
  actions.showView('shots');
};
actions.captureScreen = capture;

// ---------- Drawing ----------
const lineWidth = () => Math.max(3, Math.round(canvas.width / 320));
const point = e => {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
};

function down(e) {
  if (!image) return;
  const p = point(e);
  if (tool === 'text') return textEntry(e, p);
  canvas.setPointerCapture(e.pointerId);
  drawing = { type: tool, color, w: lineWidth(), from: p, to: p, points: [p] };
}

function moveTo(e) {
  if (!drawing) return;
  const p = point(e);
  drawing.to = p;
  if (drawing.type === 'pen') drawing.points.push(p);
  redraw();
}

function up() {
  if (!drawing) return;
  const { from, to, type } = drawing;
  if (type === 'pen' || Math.hypot(to.x - from.x, to.y - from.y) > 4) shapes.push(drawing);
  drawing = null;
  redraw();
}

// Electron has no prompt(), so text goes in a small box placed where you clicked.
function textEntry(e, p) {
  const r = wrap.getBoundingClientRect();
  const input = h('input', { class: 'text-entry', placeholder: 'Type, then Enter', style: { left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top - 14}px` } });
  const done = commit => {
    if (commit && input.value.trim()) shapes.push({ type: 'text', color, text: input.value.trim(), at: p, size: lineWidth() * 7 });
    input.remove();
    redraw();
  };
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
  wrap.append(input);
  input.focus();
}

function redraw() {
  if (!image) return;
  ctx.drawImage(image, 0, 0);
  for (const s of drawing ? [...shapes, drawing] : shapes) paint(s);
}

function paint(s) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineWidth = s.w;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0, 0, 0, .35)';
  ctx.shadowBlur = (s.w || 4) * 1.5;
  if (s.type === 'pen') {
    ctx.beginPath();
    s.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  } else if (s.type === 'box') {
    ctx.beginPath();
    ctx.roundRect(Math.min(s.from.x, s.to.x), Math.min(s.from.y, s.to.y), Math.abs(s.to.x - s.from.x), Math.abs(s.to.y - s.from.y), s.w * 2);
    ctx.stroke();
  } else if (s.type === 'arrow') {
    const angle = Math.atan2(s.to.y - s.from.y, s.to.x - s.from.x);
    const head = s.w * 4.5;
    ctx.beginPath();
    ctx.moveTo(s.from.x, s.from.y);
    ctx.lineTo(s.to.x - Math.cos(angle) * head * 0.6, s.to.y - Math.sin(angle) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.to.x, s.to.y);
    ctx.lineTo(s.to.x - head * Math.cos(angle - 0.45), s.to.y - head * Math.sin(angle - 0.45));
    ctx.lineTo(s.to.x - head * Math.cos(angle + 0.45), s.to.y - head * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fill();
  } else if (s.type === 'text') {
    ctx.font = `700 ${s.size}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.shadowBlur = 0;
    ctx.lineWidth = s.size / 5;
    ctx.strokeStyle = s.color === '#111111' ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.7)';
    ctx.strokeText(s.text, s.at.x, s.at.y);
    ctx.fillText(s.text, s.at.x, s.at.y);
  }
  ctx.restore();
}

// ---------- Saving and sending ----------
const save = guard(async () => {
  if (!image) throw new Error('Capture, paste or open an image first');
  if (!state.project) throw new Error('Add a project folder first');
  const { path } = await api('POST', '/api/shots', { project: state.project, dataUrl: canvas.toDataURL('image/png') });
  loadGallery();
  return path;
});

function sendTo(s, path) {
  actions.typeInto(s.id, `"${path}" `);
  actions.focusSession(s.id);
  toast(`${s.name} has the screenshot. Say what you want and press Enter.`, 'ok');
}

function sendMenu(anchor, getPath) {
  const agents = actions.runningAgents().filter(s => s.kind === 'agent');
  menu(anchor, [
    { heading: agents.length ? 'Send to' : 'No agents running' },
    ...agents.map(s => ({ label: s.name, icon: 'terminal', sub: s.agent, onClick: async () => { const p = await getPath(); if (p) sendTo(s, p); } })),
    'sep',
    { label: 'Copy the file path', icon: 'copy', onClick: async () => { const p = await getPath(); if (p) copy(p); } },
  ], { align: 'right' });
}
const saveAndSend = anchor => {
  if (!image) return toast('Capture, paste or open an image first', 'error');
  sendMenu(anchor, save);
};

const loadGallery = guard(async () => {
  if (!gallery || !state.project) return;
  const shots = await api('GET', `/api/shots?project=${encodeURIComponent(state.project)}`);
  gallery.replaceChildren(h('div', { class: 'section-label' }, 'Saved in this project'),
    ...(shots.length ? shots.map(s => h('button', { class: 'thumb', title: s.path, onClick: e => menu(e.currentTarget, [
      { label: 'Mark up again', icon: 'pen', onClick: guard(async () => loadBlob(await (await fetch(`/api/fs/raw?path=${encodeURIComponent(s.path)}`)).blob())) },
      'sep',
      ...actions.runningAgents().filter(x => x.kind === 'agent').map(x => ({ label: `Send to ${x.name}`, icon: 'send', onClick: () => sendTo(x, s.path) })),
      { label: 'Copy the file path', icon: 'copy', onClick: () => copy(s.path) },
    ]) }, h('img', { src: `/api/fs/raw?path=${encodeURIComponent(s.path)}`, alt: '', loading: 'lazy' }), h('span', {}, `${baseName(s.path)} · ${ago(s.at)}`)))
      : [h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Screenshots you save land in .agent-desk/shots inside the project, kept out of git.')]));
});
