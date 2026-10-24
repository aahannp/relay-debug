// Chat view of a Claude pane: the same conversation as its terminal, read from Claude Code's transcript.
// The terminal stays mounted underneath, so switching back is instant and Claude's screen is never disturbed.
// The server sends only what's new ({ sid, size, reset, prompting, menu, items }); the page only appends.
// Runs of tool calls fold into one work-log line (worklog.js), as in T3 Code; the composer floats over the list's foot.
// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT © 2026 T3 Tools Inc. See NOTICE.
import { api, copy, h, icon, markdown, on, state, actions, toast } from './ui.js';
import { loadMonaco } from './monaco.js';
import { composer } from './composer.js';
import { bucket, elapsed, summarize, startsAgent, startedId } from './worklog.js';

const MAX_ROWS = 400;
const LANGS = { js: 'javascript', ts: 'typescript', sh: 'shell', bash: 'shell', zsh: 'shell', py: 'python' };
// "Ran `npm test`": the label's backticks become code.
const label = text => text.split('`').map((t, i) => (i % 2 ? h('code', {}, t) : t));
// "[Message from leader (agent 15fd8a11)]\n…" (sessions.mjs sign()): who sent it goes above the bubble, not in it.
const SIGNED = /^\[(Message|Report|Question|Answer) from ([^\]\n]+)\]\n?/;
// T3's day-aware time: "4:12 PM" today, "yesterday at 4:12 PM", then "10/3 4:12 PM" (with the year when it isn't this one).
function clock(t) {
  const d = new Date(t);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days <= 0) return time;
  if (days === 1) return `yesterday at ${time}`;
  return `${d.toLocaleDateString([], { month: 'numeric', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })} ${time}`;
}
// T3's work-log row: an icon for the kind of work, its label, a chevron at the far right. A group of mixed work gets the hammer.
const KIND_ICONS = { read: 'eye', edit: 'squarePen', command: 'terminal', 'code-search': 'search', web: 'globe', agent: 'bot', other: 'wrench', reasoning: 'brain', mixed: 'hammer' };
const toolIcon = entry => KIND_ICONS[entry.kind === 'thinking' ? 'reasoning' : bucket(entry.name)];
// The thread a started session runs in, looked up on click: by then the chat list knows it, even if the worker closed its pane.
const openStarted = id => {
  const chat = state.chats.find(c => c.sessionId === id || c.autoClosed === id) ?? state.chats.find(c => c.id === state.sessions.find(s => s.id === id)?.chatId);
  if (chat) actions.openChat(chat.id);
  else toast('That thread is no longer on the list', 'error');
};
const summary = (entry, ...rest) => h('summary', {}, h('span', { class: 'chat-tool-icon' }, icon(toolIcon(entry), 16)), ...rest,
  h('span', { class: 'chat-chevron' }, icon('chevronRight', 12)));
const copyButton = (text, title = 'Copy') => h('button', { class: 'icon-btn chat-copy', title, 'aria-label': title, onClick: () => copy(text()) }, icon('copy', 12));

// A long message shows its first 11rem with a fade and "Show full message" below. Measured once it's laid out, so a hidden pane is fine;
// once it's known to be long it stays so, and the button toggles between the two.
const tall = new ResizeObserver(entries => {
  for (const { target } of entries) if (target.classList.contains('clamp')) target.classList.toggle('tall', target.scrollHeight > target.clientHeight + 1);
});

// Markdown, each code block in a card with its language, a wrap toggle and a copy button.
function md(text) {
  const el = h('div', { class: 'md' }, markdown(text));
  for (const pre of el.querySelectorAll('pre')) {
    const card = h('div', { class: 'chat-code' });
    const wrap = h('button', { type: 'button', class: 'icon-btn', title: 'Wrap lines', 'aria-label': 'Wrap lines', 'aria-pressed': 'false', onClick: () => {
      wrap.setAttribute('aria-pressed', String(card.classList.toggle('wrap')));
    } }, icon('textWrap', 12));
    pre.replaceWith(card);
    card.append(h('div', { class: 'chat-code-head' }, h('span', {}, pre.dataset.lang ?? ''),
      h('span', { class: 'chat-code-tools', role: 'toolbar', 'aria-label': 'Code block actions' }, wrap, copyButton(() => pre.textContent, 'Copy code'))), pre);
  }
  return el;
}

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
  let menu = null;
  let status = '';
  let since = null; // when the last user message was sent (ms), for "Working for 12s"; null from an older server
  let tick = 0;
  let group = null; // the work-log group still taking tool calls
  const seen = new Set(); // item keys already on screen
  const tools = new Map(); // tool id -> its row, for the result that follows
  const waiting = new Map(); // tool id -> the tool, until its result comes; the last one is what Claude may be asking about

  const list = h('div', { class: 'chat-list', role: 'log', 'aria-label': 'Conversation' });
  const EMPTY = 'Send a message to start the conversation.';
  const hint = h('div', { class: 'chat-hint' }, EMPTY);
  const working = h('div', { class: 'chat-working', hidden: true });
  const more = h('button', { type: 'button', class: 'chat-more', hidden: true, onClick: () => toEnd() }, icon('chevronDown', 14), 'Scroll to end');
  let pinned = true; // at the end when last scrolled, so a reflow keeps it there
  const scroller = h('div', { class: 'chat-scroll', onScroll: () => { pinned = atBottom(); if (pinned) more.hidden = true; } },
    h('div', { class: 'chat-lane' }, hint, list, working));
  const c = composer(p);
  c.el.addEventListener('sent', () => toEnd());
  // Keys 1–9 answer the docked panel from anywhere in this view; the listener goes when the pane does.
  const el = h('div', { class: 'chat', onKeydown: c.keys }, scroller, more, c.el);
  // The composer floats over the list: the list is padded by its height (chat.css), and the pill sits just above it.
  // When the composer, the pane or the rows change size, a list that was at its end stays there.
  const resized = new ResizeObserver(() => {
    el.style.setProperty('--composer-h', `${c.el.offsetHeight}px`);
    if (pinned) toEnd();
  });
  for (const x of [c.el, scroller, scroller.firstElementChild]) resized.observe(x);

  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  const toEnd = () => { scroller.scrollTop = scroller.scrollHeight; more.hidden = true; pinned = true; };

  function count() {
    if (!el.isConnected && tick) { clearInterval(tick); tick = 0; } // the pane closed
    working.textContent = since ? `Working for ${elapsed(Date.now() - since)}` : 'Working...';
  }

  function lock() {
    working.hidden = status !== 'working';
    if (status === 'working') { count(); tick ||= setInterval(count, 1000); }
    else { clearInterval(tick); tick = 0; }
    if (group) refresh(group);
    c.update({ status, exited: p.session.exited, prompting, menu, pending: [...waiting.values()].at(-1) ?? null });
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
        waiting.clear();
        group = null;
        since = null;
      }
      sid = r.sid;
      after = r.size;
      prompting = r.prompting;
      menu = r.menu ?? null;
      add(r.items, r.reset);
      lock();
      hint.textContent = EMPTY;
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
      if (it.kind === 'turn') { group = null; fold(it); added = true; continue; }
      if (it.kind === 'tool') waiting.set(it.id, { id: it.id, name: it.name, detail: it.detail, ask: it.ask });
      // Tool calls and thinking join the open group; anything else (a question card too) ends it.
      if ((it.kind === 'tool' && !it.ask) || it.kind === 'thinking') { work(it); added = true; continue; }
      group = null;
      if (it.kind === 'user') { since = it.at ?? null; waiting.clear(); }
      const row = rowOf(it);
      if (!row) continue;
      list.append(row);
      colorize(row.querySelectorAll('pre[data-lang]'));
      added = true;
    }
    // ponytail: the oldest rows go past MAX_ROWS and `seen` keeps every key; add "load earlier" (?before=) when asked.
    while (list.childElementCount > MAX_ROWS) {
      const old = list.firstElementChild;
      for (const t of [old, ...old.querySelectorAll('[data-tool]')]) if (t.dataset.tool) tools.delete(t.dataset.tool);
      if (old === group?.el) group = null;
      old.remove();
    }
    if (stick) toEnd();
    else if (added) more.hidden = false;
  }

  // A group of one shows its entry's own row; from two on, one line ("Read 2 files and ran 1 command") that opens to the entries.
  function work(it) {
    if (!group) {
      const g = { entries: [], text: h('span', { class: 'chat-label' }), mark: h('span', { class: 'chat-mark bad' }), icon: h('span', { class: 'chat-tool-icon' }) };
      g.head = h('button', { class: 'chat-group-head', 'aria-expanded': 'false', onClick: () => {
        g.head.setAttribute('aria-expanded', String(g.head.getAttribute('aria-expanded') !== 'true'));
        refresh(g);
      } }, g.icon, g.text, g.mark);
      g.body = h('div', { class: 'chat-group-body' });
      g.el = h('div', { class: 'chat-group' }, g.head, g.body);
      list.append(g.el);
      group = g;
    }
    const entry = { kind: it.kind, name: it.name, label: it.label ?? '', done: it.kind === 'thinking', error: false, text: h('span', { class: 'chat-label' }, label(it.label ?? '')) };
    group.entries.push(entry);
    if (it.kind === 'thinking') {
      entry.text.textContent = 'Thought';
      group.body.append(h('details', { class: 'chat-fold' }, summary(entry, entry.text),
        h('div', { class: 'chat-thought' }, it.text)));
    } else if (startsAgent(it.name)) { // T3's subagent row: a link to the thread it started, live once the result names it
      const mark = h('span', { class: 'chat-mark' });
      const link = h('button', { class: 'chat-sub', 'data-tool': it.id, disabled: true, title: 'Starting…' },
        h('span', { class: 'chat-tool-icon' }, icon('bot', 16)), entry.text, mark,
        h('span', { class: 'chat-chevron' }, icon('chevronRight', 12)));
      tools.set(it.id, { mark, body: h('div'), entry, group, link });
      group.body.append(link);
    } else {
      const mark = h('span', { class: 'chat-mark' });
      const body = h('div', { class: 'chat-tool-body' }, it.detail && h('pre', {}, it.detail));
      tools.set(it.id, { mark, body, entry, group });
      group.body.append(h('details', { class: 'chat-fold chat-tool', 'data-tool': it.id },
        summary(entry, entry.text, mark), body));
    }
    refresh(group);
  }

  // While its last tool has no result and Claude works, a group reads "Running `npm test`…" with T3's shine on it.
  function refresh(g) {
    const many = g.entries.length > 1;
    const now = g.entries.at(-1);
    const live = status === 'working' && !now.done;
    for (const e of g.entries) e.text.classList.toggle('live', live && e === now);
    g.el.classList.toggle('many', many);
    g.head.hidden = !many;
    g.body.hidden = many && g.head.getAttribute('aria-expanded') !== 'true';
    if (!many) return;
    const { label: said, failed, kind } = summarize(g.entries);
    g.icon.replaceChildren(icon(live ? toolIcon(now) : KIND_ICONS[kind], 16));
    g.text.replaceChildren(...(live ? label(`${now.label.replace(/^Ran /, 'Running ')}…`) : [said]));
    g.text.classList.toggle('live', live);
    g.mark.textContent = failed ? `✗ ${failed} failed` : '';
  }

  // T3's turn fold: when a turn ends, "Worked for 44s" goes just under your message and folds away everything Claude did
  // before its answer; a click opens it again. A turn with nothing to fold is just the line.
  function fold(it) {
    const rows = [];
    for (let r = list.lastElementChild; r && !r.classList.contains('chat-user'); r = r.previousElementSibling) rows.unshift(r);
    const answer = rows.findLast(r => r.classList.contains('chat-text'));
    const folded = rows.filter(r => r !== answer);
    answer?.classList.add('final');
    for (const r of folded) r.hidden = true;
    const btn = h('button', { type: 'button', 'aria-expanded': 'false', disabled: !folded.length, onClick: () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      for (const r of folded) r.hidden = !open;
    } }, `Worked for ${elapsed(it.ms)}`, icon('chevronRight', 14));
    list.insertBefore(h('div', { class: 'chat-turn' }, btn), rows[0] ?? null);
  }

  function rowOf(it) {
    switch (it.kind) {
      case 'user': return userRow(it);
      case 'command': return h('div', { class: 'chat-note' }, h('code', {}, it.text));
      case 'note': return h('div', { class: 'chat-note' }, it.text);
      case 'text': return h('div', { class: 'chat-text' }, md(it.text), h('div', { class: 'chat-meta' }, copyButton(() => it.text)));
      case 'compact': return h('details', { class: 'chat-compact' }, h('summary', {}, 'Conversation compacted'), md(it.text));
      case 'tool': { // a question; other tools go to the work log
        const body = h('div', { class: 'chat-tool-body' });
        const ask = it.ask.map(q => askCard(q, body));
        tools.set(it.id, { mark: h('span'), body, ask });
        return h('div', { class: 'chat-ask', 'data-tool': it.id }, h('div', { class: 'chat-ask-title' }, label(it.label)), body);
      }
      default: return null; // a kind this page doesn't know yet
    }
  }

  function userRow(it) {
    const signed = it.text.match(SIGNED);
    const text = signed ? it.text.slice(signed[0].length) : it.text;
    const bubble = h('div', { class: 'chat-bubble clamp' }, md(text),
      it.images > 0 && h('span', { class: 'chat-images' }, `${it.images} image${it.images === 1 ? '' : 's'}`));
    tall.observe(bubble);
    const expand = h('button', { class: 'btn xs ghost chat-expand', 'aria-expanded': 'false', onClick: () => {
      const open = bubble.classList.toggle('clamp') === false;
      expand.setAttribute('aria-expanded', String(open));
      expand.textContent = open ? 'Show less' : 'Show full message';
    } }, 'Show full message');
    return h('div', { class: 'chat-user' },
      signed && h('div', { class: 'chat-from' }, `${signed[1] === 'Message' ? 'From' : `${signed[1]} from`} ${signed[2].replace(/\s*\((agent|ask id) [^)]*\)$/, '')}`),
      bubble,
      expand,
      h('div', { class: 'chat-meta' },
        it.at && h('time', { dateTime: new Date(it.at).toISOString(), title: new Date(it.at).toLocaleString() }, clock(it.at)),
        copyButton(() => text)));
  }

  // One of AskUserQuestion's questions, with its options numbered as the terminal numbers them.
  function askCard(q, body) {
    const options = q.options.map(o => h('li', {}, h('span', { class: 'chat-ask-label' }, o.label),
      o.description && h('span', { class: 'chat-ask-desc' }, o.description)));
    const answer = h('div', { class: 'chat-ask-answer', hidden: true });
    body.append(h('div', { class: 'chat-ask-q' },
      q.header && h('div', { class: 'chat-ask-head' }, q.header, q.multiSelect && ' · pick any'),
      h('div', { class: 'chat-ask-text' }, q.question), h('ol', {}, options), answer));
    return { q, options, answer };
  }

  // A tool's result ticks or crosses its row (and counts in its group's line); a result whose tool isn't shown is dropped.
  // A question card shows what was picked instead of the raw result.
  function attach(it) {
    waiting.delete(it.id);
    const t = tools.get(it.id);
    if (!t) return;
    t.mark.replaceChildren(it.error ? icon('x', 12) : ''); // T3: no tick for success, a cross on failure
    t.mark.classList.toggle('bad', it.error);
    t.mark.setAttribute('aria-label', it.error ? 'failed' : 'done');
    if (t.entry) {
      t.entry.done = true;
      t.entry.error = it.error;
      refresh(t.group);
    }
    const started = t.link && !it.error && startedId(it.text);
    if (started) Object.assign(t.link, { disabled: false, title: 'Open the thread it started', onclick: () => openStarted(started) });
    else if (t.link) t.link.title = it.text || 'It did not start';
    if (t.ask && it.answers) {
      for (const { q, options, answer } of t.ask) {
        const picked = it.answers[q.question];
        if (picked === undefined) continue;
        const labels = picked.split(', ');
        q.options.forEach((o, i) => options[i].classList.toggle('picked', labels.includes(o.label)));
        answer.textContent = picked;
        answer.hidden = false;
      }
      t.body.parentElement?.classList.add('answered');
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
    focus: () => c.focus(),
    setMeter: m => c.setMeter(m),
    // The pane's status each second: shows "Working for 12s" and the Stop button, and reads once more when Claude goes idle.
    setStatus(now) {
      if (now === status) return;
      const was = status;
      status = now;
      lock();
      if (was === 'working') poke();
    },
  };
}
