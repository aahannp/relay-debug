// The composer of a chat view (chat.js): the message box, the Stop and Send buttons and the bar shown while Claude asks something.
// The page above hears 'sent' on `el` after a message goes out, so it can scroll to the end.
import { h, icon } from './ui.js';

// Control characters out (newlines and tabs stay), so a paste can't end the paste brackets early (as lib/sessions.mjs does).
const CONTROL = /\x1b|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function composer(p) {
  const barText = h('span', { class: 'grow' });
  const bar = h('div', { class: 'chat-bar', role: 'status', hidden: true },
    icon('alert', 14), barText,
    h('button', { class: 'btn xs', onClick: () => p.showChat(false) }, icon('terminal', 12), 'Open Terminal'));
  const input = h('textarea', { class: 'chat-input', rows: 1, 'aria-label': 'Message Claude', onKeydown: e => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); p.send('\x1b'); } // interrupts Claude, as in the terminal
  } });
  const stop = h('button', { class: 'icon-btn', title: 'Stop Claude (Esc)', 'aria-label': 'Stop Claude', hidden: true, onClick: () => p.send('\x1b') }, icon('stop', 14));
  const send = h('button', { class: 'icon-btn', title: 'Send (Enter; Shift+Enter for a new line)', 'aria-label': 'Send', onClick: () => submit() }, icon('send', 14));
  const el = h('div', { class: 'chat-composer' }, bar, h('div', { class: 'chat-compose' }, input, stop, send));

  // Typed into the terminal as a paste, then Enter on its own: Claude Code treats one big chunk as a paste.
  function submit() {
    const text = input.value.replace(CONTROL, '').trim();
    if (!text || input.disabled || p.ws?.readyState !== WebSocket.OPEN) return;
    p.send(p.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text.replace(/\s*\n\s*/g, ' '));
    setTimeout(() => p.send('\r'), 150);
    input.value = '';
    el.dispatchEvent(new Event('sent'));
  }

  return {
    el,
    focus: () => input.focus(),
    // You can't answer a menu from here: typing "1" into a permission prompt would pick an option.
    // `pending` is the tool still waiting for its result (or null); `menu` is the menu on Claude's screen (or null).
    update({ status, exited, prompting, menu, pending }) {
      input.disabled = send.disabled = exited || prompting;
      input.placeholder = exited ? 'This agent has exited' : prompting ? 'Answer in the terminal' : 'Message Claude';
      bar.hidden = !prompting || exited;
      barText.textContent = pending?.ask ? 'Answer the question above in the terminal' : 'Claude is asking something in the terminal';
      stop.hidden = status !== 'working';
    },
    setMeter() {}, // ponytail: the context ring comes with the composer card
  };
}
