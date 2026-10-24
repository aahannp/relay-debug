// The custom cursor: a dot on the pointer and a ring that follows it, growing over anything clickable.
// Over text (terminals, the editor, inputs, the screenshot canvas) it steps aside so the normal cursor works.
// Kept fast: the dot moves inside the input event itself, the ring only animates transform (no layout),
// and nothing runs while the pointer is still.
import { state, on } from './ui.js';

const CLICKABLE = 'button, a, select, label.toggle, .card, .wt, .thumb, .theme-card, .tab, .tree-row, .file-row, .block-row, .menu-item, .run-item, .nav-item, [draggable="true"]';
const TEXT = 'input, textarea, [contenteditable], .xterm, .monaco-editor, iframe, canvas';
const FOLLOW = 0.5; // share of the gap the ring closes per 60 Hz frame: higher feels tighter, lower floatier
const SCALE = { normal: 1, hover: 1.5, press: 0.75, drag: 1.8 };

const dot = Object.assign(document.createElement('div'), { className: 'cursor-dot' });
const ring = Object.assign(document.createElement('div'), { className: 'cursor-ring' });
document.body.append(dot, ring);

let x = -100;
let y = -100;
let rx = -100;
let ry = -100;
let scale = 1;
let hovering = false;
let pressed = false;
let dragging = false;
let lastEl = null;
let lastFrame = 0;
let raf = 0;

const motionOk = () => !matchMedia('(prefers-reduced-motion: reduce)').matches && matchMedia('(pointer: fine)').matches;
const apply = () => document.documentElement.classList.toggle('fancy-cursor', state.settings.fancyCursor === true && motionOk());
on('settings', apply);
apply();

const goal = () => (dragging ? SCALE.drag : pressed ? SCALE.press : hovering ? SCALE.hover : SCALE.normal);

// Only look at what's under the pointer when that element changes, not on every move.
function look(el) {
  if (el === lastEl) return;
  lastEl = el;
  const away = Boolean(el?.closest?.(TEXT));
  hovering = !away && Boolean(el?.closest?.(CLICKABLE));
  for (const node of [dot, ring]) {
    node.classList.toggle('away', away);
    node.classList.toggle('hover', hovering);
  }
}

function move(e) {
  x = e.clientX;
  y = e.clientY;
  if (rx < 0) { rx = x; ry = y; }
  look(e.target);
  dot.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${hovering ? 0.7 : 1})`;
  wake();
}

function wake() {
  if (raf) return;
  lastFrame = performance.now();
  raf = requestAnimationFrame(frame);
}

// The same feel on 60 Hz and 120 Hz screens: the catch-up step depends on time, not on frame count.
function frame(now) {
  const k = 1 - (1 - FOLLOW) ** (Math.min(now - lastFrame, 64) / 16.67);
  lastFrame = now;
  rx += (x - rx) * k;
  ry += (y - ry) * k;
  scale += (goal() - scale) * k;
  ring.style.transform = `translate3d(${rx}px, ${ry}px, 0) scale(${scale})`;
  const settled = Math.abs(x - rx) < 0.1 && Math.abs(y - ry) < 0.1 && Math.abs(goal() - scale) < 0.005;
  raf = settled ? 0 : requestAnimationFrame(frame);
}

// pointerrawupdate arrives as soon as the hardware reports, a little before pointermove.
addEventListener('onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove', move, { passive: true });
document.addEventListener('dragover', move); // pointer events pause while dragging
addEventListener('pointerdown', () => { pressed = true; ring.classList.add('press'); wake(); });
addEventListener('pointerup', () => { pressed = false; ring.classList.remove('press'); wake(); });
document.addEventListener('dragstart', () => { dragging = true; ring.classList.add('drag'); wake(); });
document.addEventListener('dragend', () => { dragging = false; ring.classList.remove('drag'); wake(); });
document.documentElement.addEventListener('mouseleave', () => {
  lastEl = null;
  dot.classList.add('away');
  ring.classList.add('away');
});
