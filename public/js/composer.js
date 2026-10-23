// The composer of a chat view (chat.js): the message card with its context ring and Send/Stop button, and the
// panel docked above it while Claude asks something, whose options you can pick from here.
// The page above hears 'sent' on `el` after a message goes out, so it can scroll to the end.
// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT): ComposerPendingApprovalPanel,
// ComposerPendingUserInputPanel, ComposerPrimaryActions and ContextWindowMeter.
import { api, h, icon, meterView } from './ui.js';

// Control characters out (newlines and tabs stay), so a paste can't end the paste brackets early (as lib/sessions.mjs does).
const CONTROL = /\x1b|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const APPROVAL = { Bash: 'Command approval', Edit: 'File change approval', MultiEdit: 'File change approval', Write: 'File change approval',
  NotebookEdit: 'File change approval', Read: 'File read approval' };
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// What the docked panel shows for the menu on Claude's screen (menuOf in lib/sessions.mjs: { lines, multi,
// options: [{ n, label, current, typed }] }, or null) and the tool waiting for its result ({ id, name, detail, ask },
// or null). The pending tool is the one asking: Claude Code writes its tool_use line before it runs it.
// Options always come off the screen, never the transcript. A multi-select menu and a "Type something" row
// need typing, so they're left to the terminal (the server refuses them too).
export function panelOf(menu, pending) {
  const terminal = (title, body) => ({ kind: 'terminal', title, body, options: [] });
  if (!menu?.options?.length) return terminal('Claude is asking something', 'Answer it in the terminal.');
  const options = menu.options.filter(o => !o.typed).map(({ n, label }) => ({ n, label }));
  // Several questions show one at a time: the one on screen is the one whose text is above its own options.
  // None matching is a step of their own, such as "Review your answers" (which repeats the questions), shown as a plain menu.
  const screen = squash(menu.lines?.join(' '));
  const mine = q => options.some(o => q.options?.some(x => squash(x.label) === squash(o.label)));
  const i = pending?.ask?.findIndex(q => q.question && screen.includes(squash(q.question)) && mine(q)) ?? -1;
  if (i >= 0) {
    const q = pending.ask[i];
    const step = pending.ask.length > 1 ? `${i + 1}/${pending.ask.length}` : '';
    if (q.multiSelect || menu.multi) return { ...terminal(q.header || 'Question', `${q.question}\nThis one takes several answers: pick them in the terminal.`), step };
    const describe = o => q.options?.find(x => squash(x.label) === squash(o.label))?.description;
    const own = options.map(o => ({ ...o, description: squash(describe(o)) === squash(o.label) ? undefined : describe(o) })); // none when it only repeats the label
    return { kind: 'question', title: q.header || 'Question', body: q.question, step, options: own };
  }
  if (menu.multi) return terminal('Claude is asking', 'This one takes several answers: pick them in the terminal.');
  if (pending && !pending.ask) return { kind: 'approval', title: APPROVAL[pending.name] ?? 'Tool approval', body: pending.detail || pending.name, options };
  return { kind: 'menu', title: 'Claude is asking', body: (menu.lines ?? []).join('\n'), options };
}

// T3 Code's ring: a 24-unit circle, r 9.75, stroke 3, started at 12 o'clock.
const R = 9.75;
const CIRCLE = 2 * Math.PI * R;
const svg = (tag, attrs) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

export function composer(p) {
  let panel = null; // what the docked panel shows, or null
  let shown = ''; // the menu it was built from, so a feed read with the same menu leaves it alone
  let choosing = false;
  let working = false;

  const dock = h('div', { class: 'chat-dock', hidden: true });
  const input = h('textarea', { class: 'chat-input', rows: 1, 'aria-label': 'Message Claude', onInput: () => buttons(), onKeydown: e => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); p.send('\x1b'); } // interrupts Claude, as in the terminal
  } });
  const arc = svg('circle', { cx: 12, cy: 12, r: R, class: 'chat-ring-arc', 'stroke-dasharray': CIRCLE, 'stroke-dashoffset': CIRCLE });
  const rings = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  rings.append(svg('circle', { cx: 12, cy: 12, r: R, class: 'chat-ring-track' }), arc);
  const ring = h('span', { class: 'chat-ring', role: 'img', tabindex: 0, hidden: true }, rings);
  const hint = h('span', { class: 'chat-key-hint', hidden: true }, 'Esc to stop');
  const stop = h('button', { class: 'chat-go', title: 'Stop Claude (Esc)', 'aria-label': 'Stop Claude', hidden: true, onClick: () => p.send('\x1b') },
    h('span', { class: 'chat-go-stop' }));
  const send = h('button', { class: 'chat-go', title: 'Send (Enter; Shift+Enter for a new line)', 'aria-label': 'Send', disabled: true, onClick: () => submit(),
    innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>' });
  const card = h('div', { class: 'chat-card' }, input,
    h('div', { class: 'chat-controls' }, ring, hint, h('span', { class: 'grow' }), stop, send));
  const el = h('div', { class: 'chat-composer' }, dock, card);

  // Keys 1–9 pick an option while focus is anywhere in this chat view but a text field. They go through /choose,
  // never into the terminal: the server checks the option is still on screen and moves Claude's cursor to it.
  document.addEventListener('keydown', e => {
    if (!panel?.options.length || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || !/^[1-9]$/.test(e.key)) return;
    if (!(el.parentElement ?? el).contains(e.target) || e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const o = panel.options.find(x => x.n === Number(e.key));
    if (!o) return;
    e.preventDefault();
    choose(o);
  });

  async function choose(o) {
    if (choosing) return;
    choosing = true;
    dock.classList.add('busy');
    try {
      await api('POST', `/api/sessions/${p.id}/choose`, { n: o.n, label: o.label });
    } catch (e) {
      // A 409 is "The menu changed": the read below brings the new one, and a new menu redraws the panel.
      choosing = false;
      dock.classList.remove('busy');
      dock.querySelector('.chat-dock-error')?.replaceChildren(e.message);
    }
    p.chat?.poke();
  }

  function buttons() {
    const empty = !input.value.trim();
    stop.hidden = !(working && empty);
    send.hidden = !stop.hidden;
    send.disabled = empty || input.disabled;
  }

  function render(next) {
    panel = next;
    choosing = false;
    dock.classList.remove('busy');
    dock.hidden = !panel;
    if (!panel) return dock.replaceChildren();
    dock.dataset.kind = panel.kind;
    dock.replaceChildren(h('div', { class: 'chat-dock-head' },
      h('span', { class: 'chat-dock-title' }, panel.title), panel.step && h('span', { class: 'chat-dock-step' }, panel.step),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn xs', onClick: () => p.showChat(false) }, icon('terminal', 12), 'Open Terminal')),
    panel.body && h(panel.kind === 'approval' ? 'pre' : 'div', { class: 'chat-dock-body', tabindex: 0 }, panel.body),
    panel.options.length > 0 && h('div', { class: 'chat-dock-options' }, panel.options.map(o =>
      h('button', { class: 'chat-option', onClick: () => choose(o) },
        h('span', { class: 'chat-option-text' }, h('span', {}, o.label), o.description && h('span', { class: 'chat-option-desc' }, o.description)),
        o.n <= 9 && h('kbd', {}, String(o.n))))),
    h('div', { class: 'chat-dock-error', role: 'alert' }));
    dock.setAttribute('aria-label', panel.title);
  }

  // While a panel is up the input is off, so focus goes to the panel's first option, where 1–9 work.
  const focus = () => (input.disabled ? dock.querySelector('.chat-option') ?? dock.querySelector('button') : input)?.focus();

  return {
    el,
    focus,
    // `pending` is the tool still waiting for its result (or null); `menu` is the menu on Claude's screen (or null).
    update({ status, exited, prompting, menu, pending }) {
      const had = el.contains(document.activeElement);
      const up = prompting && !exited;
      input.disabled = exited || prompting;
      input.placeholder = exited ? 'This agent has exited' : prompting ? 'Choose an option above' : 'Message Claude';
      working = status === 'working' && !exited;
      hint.hidden = !working;
      buttons();
      const key = up ? JSON.stringify([menu, pending?.id]) : '';
      if (key === shown) return;
      shown = key;
      render(up ? panelOf(menu, pending) : null);
      if (had && up) focus();
    },
    // The pane's context meter (meterView in ui.js) as a ring: dim, amber over 70%, full text colour over 90%.
    setMeter(m) {
      ring.hidden = !m;
      if (!m) return;
      const v = meterView(m);
      arc.setAttribute('stroke-dashoffset', CIRCLE * (1 - Math.min(v.pct, 100) / 100));
      ring.className = `chat-ring ${v.level}`;
      ring.title = v.details;
      ring.setAttribute('aria-label', `Context window ${v.pct}% used${v.cost && `, ${v.cost} so far`}`);
    },
  };

  // Typed into the terminal as a paste, then Enter on its own: Claude Code treats one big chunk as a paste.
  // A slash command other than /compact or /clear draws its own screen, which only the terminal shows.
  function submit() {
    const text = input.value.replace(CONTROL, '').trim();
    if (!text || input.disabled || p.ws?.readyState !== WebSocket.OPEN) return;
    p.send(p.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text.replace(/\s*\n\s*/g, ' '));
    setTimeout(() => p.send('\r'), 150);
    input.value = '';
    buttons();
    el.dispatchEvent(new Event('sent'));
    if (/^\/(?!(compact|clear)\b)\S/.test(text)) p.showChat(false);
  }
}
