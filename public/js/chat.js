// Chat view of a Claude pane: the same conversation as its terminal, read from Claude Code's transcript.
// The terminal stays mounted underneath, so switching back is instant and Claude's screen is never disturbed.
// The server sends only what's new ({ sid, size, reset, prompting, items }); the page only appends.
import { api, h, icon, markdown, on } from './ui.js';
import { loadMonaco } from './monaco.js';

const MAX_ROWS = 400;
const LANGS = { js: 'javascript', ts: 'typescript', sh: 'shell', bash: 'shell', zsh: 'shell', py: 'python' };
// Control characters out (newlines and tabs stay), so a paste can't end the paste brackets early (as lib/sessions.mjs does).
const CONTROL = /\x1b|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
// "Ran `npm test`": the label's backticks become code.
const label = text => text.split('`').map((t, i) => (i % 2 ? h('code', {}, t) : t));

// Code blocks with a language get Monaco's colours, loaded only when the first one shows up. monaco.editor.colorize
// leaves the theme alone (colorizeElement sets its own, 'vs' by default, on every editor), so the blocks are coloured
// again on a theme change, after monaco.js has redefined 'desk'.
const sources = new WeakMap(); // <code> -> [its text, its language]
let watching = false;
function colorize(blocks) {
  if (!blocks.length) return;
  loadMonaco().then(monaco => {
    if (!watching) {
      watching = true;
      on('theme', () => colorize(document.querySelectorAll('.chat pre[data-lang]')));
    }
    for (const pre of blocks) {
      const code = pre.querySelector('code') ?? pre;
      const lang = pre.dataset.lang.toLowerCase();
      if (!sources.has(code)) sources.set(code, [code.textContent, LANGS[lang] ?? lang]);
      monaco.editor.colorize(...sources.get(code), {}).then(html => { code.innerHTML = html; }, () => {});
    }
  }).catch(() => {}); // plain text is fine
}

export function chatView(p) {
  let sid = null; // which Claude conversation we're showing; a /clear or fork changes it and the server says reset
  let after = 0; // how far into its transcript we've read, in bytes
  let shown = false;
  let timer = 0;
  let busy = false;
  let again = false;
  let last = 0;
  let prompting = false;
  let status = '';
  const seen = new Set(); // item keys already on screen
  const tools = new Map(); // tool id -> its row, for the result that follows
  let asking = null; // the id of a question card still waiting for its answer

  const list = h('div', { class: 'chat-list', role: 'log', 'aria-label': 'Conversation' });
  const hint = h('div', { class: 'chat-hint' }, 'Nothing here yet.');
  const working = h('div', { class: 'chat-working', hidden: true }, h('span', { class: 'dot' }), 'Claude is working…');
  const scroller = h('div', { class: 'chat-scroll', onScroll: () => { if (atBottom()) more.hidden = true; } }, hint, list, working);
  const more = h('button', { class: 'btn xs chat-more', hidden: true, onClick: () => toEnd() }, '↓ New messages');
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
  const el = h('div', { class: 'chat' }, scroller, more, bar, h('div', { class: 'chat-compose' }, input, stop, send));

  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  const toEnd = () => { scroller.scrollTop = scroller.scrollHeight; more.hidden = true; };

  // Typed into the terminal as a paste, then Enter on its own: Claude Code treats one big chunk as a paste.
  function submit() {
    const text = input.value.replace(CONTROL, '').trim();
    if (!text || input.disabled || p.ws?.readyState !== WebSocket.OPEN) return;
    p.send(p.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text.replace(/\s*\n\s*/g, ' '));
    setTimeout(() => p.send('\r'), 150);
    input.value = '';
    toEnd();
  }

  // You can't answer a menu from here: typing "1" into a permission prompt would pick an option.
  function lock() {
    const exited = p.session.exited;
    input.disabled = send.disabled = exited || prompting;
    input.placeholder = exited ? 'This agent has exited' : prompting ? 'Answer in the terminal' : 'Message Claude';
    bar.hidden = !prompting || exited;
    barText.textContent = asking ? 'Answer the question above in the terminal' : 'Claude is asking something in the terminal';
    working.hidden = stop.hidden = status !== 'working';
  }

  // At most one request every 500 ms while output streams in, plus one after the last chunk.
  function poke() {
    if (!shown) return;
    if (busy) { again = true; return; }
    if (!timer) timer = setTimeout(pull, Math.max(0, last + 500 - Date.now()));
  }

  async function pull() {
    timer = 0;
    busy = true;
    last = Date.now();
    try {
      const r = await api('GET', `/api/sessions/${p.id}/transcript?sid=${encodeURIComponent(sid ?? '')}&after=${after}`);
      if (r.reset) {
        list.replaceChildren();
        seen.clear();
        tools.clear();
        asking = null;
      }
      sid = r.sid;
      after = r.size;
      prompting = r.prompting;
      add(r.items, r.reset);
      lock();
      hint.textContent = 'Nothing here yet.';
    } catch (e) {
      hint.textContent = `Couldn't read the conversation: ${e.message}`;
    } finally {
      hint.hidden = list.childElementCount > 0;
      busy = false;
      if (again) { again = false; poke(); }
    }
  }

  function add(items, reset) {
    const stick = reset || atBottom();
    let added = false;
    for (const it of items) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      if (it.kind === 'result') { attach(it); continue; }
      const row = rowOf(it);
      if (!row) continue;
      list.append(row);
      colorize(row.querySelectorAll('pre[data-lang]'));
      added = true;
    }
    // ponytail: the oldest rows go past MAX_ROWS and `seen` keeps every key; add "load earlier" (?before=) when asked.
    while (list.childElementCount > MAX_ROWS) {
      const old = list.firstElementChild;
      if (old.dataset.tool) tools.delete(old.dataset.tool);
      old.remove();
    }
    if (stick) toEnd();
    else if (added) more.hidden = false;
  }

  function rowOf(it) {
    switch (it.kind) {
      case 'user': return h('div', { class: 'chat-user' }, h('div', { class: 'chat-bubble' }, it.text,
        it.images > 0 && h('span', { class: 'chat-images' }, ` + ${it.images} image${it.images === 1 ? '' : 's'}`)));
      case 'command': return h('div', { class: 'chat-note' }, h('code', {}, it.text));
      case 'note': return h('div', { class: 'chat-note' }, it.text);
      case 'text': return h('div', { class: 'chat-text md' }, markdown(it.text));
      case 'thinking': return h('details', { class: 'chat-fold' }, h('summary', {}, 'Thinking'), h('div', { class: 'chat-thought' }, it.text));
      case 'compact': return h('details', { class: 'chat-compact' }, h('summary', {}, 'Conversation compacted'), h('div', { class: 'md' }, markdown(it.text)));
      case 'tool': {
        const mark = h('span', { class: 'chat-mark' });
        const body = h('div', { class: 'chat-tool-body' }, it.detail && h('pre', {}, it.detail));
        const ask = it.ask?.map(q => askCard(q, body));
        if (ask) asking = it.id;
        tools.set(it.id, { mark, body, ask });
        return h('details', { class: `chat-fold chat-tool${ask ? ' chat-ask' : ''}`, open: Boolean(ask), 'data-tool': it.id },
          h('summary', {}, h('span', { class: 'chat-label' }, label(it.label)), mark), body);
      }
      default: return null; // a kind this page doesn't know yet
    }
  }

  // One of AskUserQuestion's questions, with its options numbered as the terminal numbers them.
  // ponytail: answered in the terminal; make the options buttons that type their number when asked
  function askCard(q, body) {
    const options = q.options.map(o => h('li', {}, h('span', { class: 'chat-ask-label' }, o.label),
      o.description && h('span', { class: 'chat-ask-desc' }, o.description)));
    const answer = h('div', { class: 'chat-ask-answer', hidden: true });
    body.append(h('div', { class: 'chat-ask-q' },
      q.header && h('div', { class: 'chat-ask-head' }, q.header, q.multiSelect && ' · pick any'),
      h('div', { class: 'chat-ask-text' }, q.question), h('ol', {}, options), answer));
    return { q, options, answer };
  }

  // A tool's result ticks or crosses its row; a result whose tool isn't shown is dropped.
  // A question card shows what was picked instead of the raw result.
  function attach(it) {
    const t = tools.get(it.id);
    if (!t) return;
    if (asking === it.id) { asking = null; lock(); }
    t.mark.textContent = it.error ? '✗' : '✓';
    t.mark.classList.toggle('bad', it.error);
    t.mark.setAttribute('aria-label', it.error ? 'failed' : 'done');
    if (t.ask && it.answers) {
      for (const { q, options, answer } of t.ask) {
        const picked = it.answers[q.question];
        if (picked === undefined) continue;
        const labels = picked.split(', ');
        q.options.forEach((o, i) => options[i].classList.toggle('picked', labels.includes(o.label)));
        answer.textContent = `Answered: ${picked}`;
        answer.hidden = false;
      }
      return;
    }
    t.body.append(h('pre', { class: it.error ? 'bad' : '' }, it.text || '(no output)'));
    if (it.images > 0) t.body.append(h('div', { class: 'chat-images' }, `${it.images} image${it.images === 1 ? '' : 's'}`));
  }

  return {
    el,
    show() { shown = true; lock(); poke(); requestAnimationFrame(toEnd); },
    hide() { shown = false; },
    poke,
    focus: () => input.focus(),
    // The pane's status each second: shows "working…" and the Stop button, and reads once more when Claude goes idle.
    setStatus(now) {
      if (now === status) return;
      const was = status;
      status = now;
      lock();
      if (was === 'working') poke();
    },
  };
}
