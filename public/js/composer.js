// The composer of a chat view (chat.js): T3's floating glass card with the model chip, usage limits, context ring, Attach
// and Send/Stop; the `/` and `@` menu above it; and the banner attached on top of it while Claude asks something,
// whose options you can pick from here.
// The page above hears 'sent' on `el` after a message goes out, so it can scroll to the end.
// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT © 2026 T3 Tools Inc. See NOTICE.
// From ChatComposer, ComposerCommandMenu, ComposerAttachmentStrip, ComposerControl, ComposerPendingApprovalPanel, ComposerPendingApprovalActions,
// ComposerPendingUserInputPanel, ComposerPrimaryActions, ContextWindowMeter, ComposerUsageLimits (LimitWindows)
// and UsageLimitRecoveryBanner.
import { api, h, icon, menu, money, on } from './ui.js';

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
// T3's numbers: tokens as "950", "8.5k", "145k", "1.2m" (formatContextWindowTokens); a percentage with one decimal
// under 10 (ContextWindowMeter); a time left as "2d 4h", "3h 12m", "8m" (formatDuration).
const tokens = n => (n < 1_000 ? `${Math.round(n)}` : n < 10_000 ? `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  : n < 999_500 ? `${Math.round(n / 1_000)}k` : `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`);
const percent = v => (v < 10 ? `${v.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(v)}%`);
const MINUTE = 60_000;
const duration = ms => {
  const d = Math.floor(ms / (1440 * MINUTE)), hr = Math.floor(ms / (60 * MINUTE)) % 24, m = Math.floor(ms / MINUTE) % 60;
  return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`;
};
const resetsIn = (at, now) => (at - now < MINUTE ? 'Resets momentarily' : `resets in ${duration(at - now)}`);

// Your plan's usage limits (noteLimits in lib/sessions.mjs): the account's, so one copy for every composer.
// Each composer redraws when they change and every 30s, as "resets in" counts down and a window past its reset goes.
// ponytail: a closed chat's redraw stays in the set (it skips itself once detached); prune it if panes churn by the thousand.
const LIMITS = [['session', 'Session', 5 * 60], ['weekly', 'Weekly', 7 * 24 * 60]];
let limits = {};
const redraws = new Set();
const setLimits = next => { limits = next ?? {}; redraws.forEach(f => f()); };
on('limits', e => setLimits(e.limits));
setInterval(() => redraws.forEach(f => f()), 30_000);
// Windows still running, with their label, length in minutes, % used and reset time (if Claude sent one).
const liveLimits = now => LIMITS.map(([key, label, mins]) => ({ key, label, mins, ...limits[key] }))
  .filter(w => w.used !== undefined && !(w.resetsAt <= now));

// T3's popover over a footer control: opens on hover (after 150ms, in CSS) or focus, and a second click closes it.
let pops = 0;
function popover(button, ...content) {
  const pop = h('div', { class: 'chat-pop', id: `chat-pop-${++pops}`, role: 'tooltip' }, ...content);
  button.setAttribute('aria-describedby', pop.id);
  let open = false;
  button.addEventListener('pointerdown', () => { open = button.matches(':focus'); });
  button.addEventListener('click', () => open && button.blur());
  const wrap = h('span', { class: 'chat-pop-wrap', hidden: true, onKeydown: e => {
    if (e.key === 'Escape' && wrap.contains(document.activeElement)) { e.stopPropagation(); document.activeElement.blur(); }
  } }, button, pop);
  return { wrap, pop };
}
const popRow = (label, value) => h('div', { class: 'chat-pop-row' }, h('span', {}, label), h('span', { class: 'chat-pop-num' }, value));

// The model chip's menu: what `/model <id>` switches the running Claude to.
const MODELS = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const modelName = id => MODELS.find(([m]) => m === id)?.[1] ?? 'Default model';

// Claude Code's built-in commands for the `/` menu; the project's and your own .claude/commands/*.md join them.
const COMMANDS = [['add-dir', 'Add a working directory'], ['agents', 'Manage subagents'], ['clear', 'Start a new conversation'],
  ['compact', 'Compact the conversation'], ['config', 'Open settings'], ['context', 'Show what fills the context window'],
  ['cost', 'Show tokens and cost so far'], ['doctor', 'Check the Claude Code install'], ['export', 'Export the conversation'],
  ['help', 'Show help'], ['hooks', 'Manage hooks'], ['init', 'Write a CLAUDE.md for this project'], ['mcp', 'Manage MCP servers'],
  ['memory', 'Edit memory files'], ['model', 'Switch the model'], ['permissions', 'Manage tool permissions'],
  ['resume', 'Resume an earlier conversation'], ['review', 'Review a pull request'], ['rewind', 'Rewind the conversation or code'],
  ['status', 'Show version, model and account'], ['usage', 'Show plan usage limits']];
// The word being typed at the caret, if it opens the menu: `/` at the very start of the box, or `@` anywhere.
export function triggerAt(text, caret) {
  const m = /(^|\s)([@/])(\S*)$/.exec(text.slice(0, caret));
  if (!m || (m[2] === '/' && m.index + m[1].length > 0)) return null;
  return { kind: m[2], query: m[3], start: caret - m[3].length - 1, end: caret };
}

export function composer(p) {
  let panel = null; // what the docked panel shows, or null
  let shown = ''; // the menu it was built from, so a feed read with the same menu leaves it alone
  let choosing = false;
  let working = false;
  let model = p.session.model; // picked here, it's ours: the session keeps the model it started with

  const dock = h('div', { class: 'chat-dock', hidden: true });
  const drawer = h('div', { class: 'chat-dock chat-menu', id: `chat-menu-${++pops}`, role: 'listbox', hidden: true, onPointerdown: e => e.preventDefault() });
  const input = h('textarea', { class: 'chat-input', rows: 1, 'aria-label': 'Message Claude', 'aria-autocomplete': 'list', 'aria-controls': drawer.id,
    onInput: () => { buttons(); suggest(); }, onClick: () => suggest(), onBlur: () => closeMenu(), onKeydown: e => {
      if (e.isComposing) return;
      if (found && menuKey(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); p.send('\x1b'); } // interrupts Claude, as in the terminal
    }, onKeyup: e => /^(Arrow(Left|Right)|Home|End)$/.test(e.key) && suggest() });
  const arc = svg('circle', { cx: 12, cy: 12, r: R, class: 'chat-ring-arc', 'stroke-dasharray': CIRCLE, 'stroke-dashoffset': CIRCLE });
  const rings = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  rings.append(svg('circle', { cx: 12, cy: 12, r: R, class: 'chat-ring-track' }), arc);
  const meterPct = h('span', { class: 'chat-meter-pct' });
  const meterButton = h('button', { type: 'button', class: 'chat-meter' }, h('span', { class: 'chat-ring' }, rings), meterPct);
  const meter = popover(meterButton);
  const limitsText = h('span', { class: 'chat-limits-text' });
  const limitsButton = h('button', { type: 'button', class: 'chat-control chat-limits' }, icon('gauge', 14), limitsText);
  const usage = popover(limitsButton);
  const limitBanner = h('div', { class: 'chat-dock chat-limit', role: 'status', hidden: true });
  const modelLabel = h('span', {}, modelName(model));
  const chip = h('button', { type: 'button', class: 'chat-control chat-model', 'aria-haspopup': 'menu', title: 'Model', onClick: () => pickModel() },
    icon('sparkles', 16), modelLabel, icon('chevronDown', 14));
  // Attach: starts an `@` mention at the caret, whose menu picks a file or folder; Claude Code reads what it names.
  const attach = h('button', { type: 'button', class: 'chat-attach', title: 'Attach files', 'aria-label': 'Attach files', onClick: () => {
    const at = input.selectionStart;
    const gap = at > 0 && !/\s/.test(input.value[at - 1]) ? ' ' : '';
    input.focus();
    input.setRangeText(`${gap}@`, at, input.selectionEnd, 'end');
    buttons();
    suggest();
  } }, icon('paperclip', 16));
  const stop = h('button', { type: 'button', class: 'chat-go stop', title: 'Interrupt (Esc)', 'aria-label': 'Interrupt', hidden: true, onClick: () => p.send('\x1b'),
    innerHTML: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5"/></svg>' });
  const arrow = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const send = h('button', { type: 'button', class: 'chat-go', disabled: true, onClick: () => submit(), innerHTML: arrow });
  let steering = null; // what Send shows: Submit, or Steer while Claude works (Claude Code takes the message mid-turn)
  const card = h('div', { class: 'chat-card' }, input,
    h('div', { class: 'chat-controls' }, chip, h('span', { class: 'grow' }), usage.wrap, meter.wrap, attach, stop, send));
  const el = h('div', { class: 'chat-composer' }, h('div', { class: 'chat-composer-lane' }, limitBanner, dock, drawer, card));

  // The usage-limits control: "Session 23% · resets in 2h 5m · Weekly 41%" (used), T3's LimitWindows (left) over it,
  // and its "Usage limit reached" banner on the card while a window is used up. Nothing at all before any limits
  // came in, as for an API key, which has none.
  function drawLimits() {
    if (!el.isConnected && limitsText.textContent) return;
    const now = Date.now();
    const windows = liveLimits(now);
    usage.wrap.hidden = !windows.length;
    limitsButton.classList.toggle('bad', windows.some(w => w.used > 90));
    limitsText.replaceChildren(...windows.flatMap((w, i) => [i > 0 && h('span', { class: 'chat-limits-more' }, ' · '),
      h('span', { class: i > 0 ? 'chat-limits-more' : '' }, `${w.label} ${Math.round(w.used)}%`),
      i === 0 && w.resetsAt && h('span', { class: 'chat-limits-more' }, ` · ${resetsIn(w.resetsAt, now)}`)]).filter(Boolean));
    limitsButton.setAttribute('aria-label', `Usage limits: ${windows.map(w => `${w.label} ${Math.round(w.used)}% used${w.resetsAt ? `, ${resetsIn(w.resetsAt, now)}` : ''}`).join('; ')}`);
    usage.pop.replaceChildren(
      h('div', { class: 'chat-pop-head' }, icon('gauge', 14), h('span', {}, 'Usage limits'), h('span', { class: 'chat-pop-num' }, 'Claude Code')),
      h('div', { class: 'chat-limit-grid' }, windows.flatMap(w => {
        const left = Math.round(100 - w.used);
        // Where even spending would be: the share of the window's time still to run (T3's pace mark).
        const timeLeft = w.resetsAt ? Math.max(0, Math.min(100, Math.round((w.resetsAt - now) * 100 / (w.mins * MINUTE)))) : null;
        return [
          h('span', { class: 'chat-limit-label' }, h('span', {}, w.label), h('b', {}, `${left}% left`)),
          h('span', { class: 'chat-limit-bar', role: 'img', 'aria-label': `${w.label}: ${left}% left${w.resetsAt ? `, ${resetsIn(w.resetsAt, now)}` : ''}`,
            title: w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : '' },
            h('span', { class: 'chat-limit-fill', style: `width: ${left}%` }),
            timeLeft !== null && h('span', { class: 'chat-limit-pace', style: `left: clamp(3px, ${timeLeft}%, calc(100% - 3px))` })),
          h('span', { class: 'chat-limit-reset' }, w.resetsAt ? resetsIn(w.resetsAt, now) : ''),
        ];
      })));
    const out = windows.find(w => w.used >= 100);
    limitBanner.hidden = !out;
    if (out) limitBanner.replaceChildren(h('div', { class: 'chat-dock-row' },
      h('span', { class: 'chat-dock-icon', 'aria-hidden': 'true' }, icon('gauge', 16)),
      h('span', { class: 'chat-dock-main' }, h('span', { class: 'chat-dock-title' }, 'Usage limit reached'),
        h('span', { class: 'chat-limit-when' }, out.resetsAt ? `Resets ${new Date(out.resetsAt).toLocaleString()}` : 'Reset time unavailable; retry manually'))));
  }
  redraws.add(drawLimits);
  api('GET', '/api/limits').then(setLimits, () => {});

  // Keys 1–9 pick an option while focus is anywhere in this chat view but a text field (chat.js listens on the view,
  // so a closed pane takes its listener with it). They go through /choose, never into the terminal: the server
  // checks the option is still on screen and moves Claude's cursor to it.
  function keys(e) {
    if (!panel?.options.length || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || !/^[1-9]$/.test(e.key)) return;
    if (e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const o = panel.options.find(x => x.n === Number(e.key));
    if (!o) return;
    e.preventDefault();
    choose(o);
  }

  async function choose(o) {
    if (choosing) return;
    choosing = true;
    dock.classList.add('busy');
    // T3 marks the pick at once: muted fill and a check where its number was.
    const row = dock.querySelector(`.chat-option[data-n="${o.n}"]`);
    row?.classList.add('on');
    row?.querySelector('kbd')?.replaceWith(icon('check', 14));
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
    chip.disabled = attach.disabled = input.disabled;
    if (steering === working) return;
    steering = working;
    send.innerHTML = working ? icon('cornerUpRight', 16).innerHTML : arrow;
    send.setAttribute('aria-label', working ? 'Steer message' : 'Submit message');
    send.title = working ? 'Steer: Claude reads it mid-turn (Enter)' : 'Send (Enter; Shift+Enter for a new line)';
  }

  // The `/` and `@` menu (T3's ComposerCommandMenu): a drawer on top of the card, ↑↓ to move, Enter or Tab to pick,
  // Esc to close. `@` lists the session's folder level by level: a folder opens, a file ends the mention.
  let found = null; // { ...the trigger, items, i }, while the drawer is up
  let asked = 0; // so a slow listing can't overwrite a newer one
  let dismissed = ''; // the trigger Esc closed, kept closed until it changes
  const listings = new Map();
  const list = dir => {
    if (!listings.has(dir)) listings.set(dir, api('GET', `/api/fs/list?path=${encodeURIComponent(dir)}`).catch(() => []));
    return listings.get(dir);
  };
  const own = async dir => (await list(dir)).filter(f => !f.dir && f.name.endsWith('.md')).map(f => [f.name.slice(0, -3), dir.startsWith('~') ? 'Your command' : 'Project command']);
  async function itemsFor(t) {
    const q = t.query.toLowerCase();
    if (t.kind === '/') {
      const all = [...COMMANDS, ...await own(`${p.session.cwd}/.claude/commands`), ...await own('~/.claude/commands')];
      return all.filter(([name]) => name.toLowerCase().includes(q)).sort(([a], [b]) => b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q))
        .map(([name, desc]) => ({ label: `/${name}`, desc, icon: 'terminal', text: `/${name} ` }));
    }
    const cut = t.query.lastIndexOf('/') + 1;
    const dir = t.query.slice(0, cut), part = q.slice(cut);
    return (await list(`${p.session.cwd}/${dir}`))
      .filter(f => f.name.toLowerCase().includes(part) && (part.startsWith('.') || !f.name.startsWith('.')))
      .sort((a, b) => b.name.toLowerCase().startsWith(part) - a.name.toLowerCase().startsWith(part))
      .slice(0, 50)
      .map(f => ({ label: f.name + (f.dir ? '/' : ''), desc: dir, icon: f.dir ? 'folder' : 'file', text: `@${dir}${f.name}${f.dir ? '/' : ' '}`, open: f.dir }));
  }
  async function suggest() {
    const t = !input.disabled && document.activeElement === input && input.selectionStart === input.selectionEnd ? triggerAt(input.value, input.selectionStart) : null;
    const key = t && `${t.start}:${t.kind}${t.query}`;
    if (!t || key === dismissed) return closeMenu();
    dismissed = '';
    const mine = ++asked;
    const items = await itemsFor(t);
    if (mine !== asked) return;
    found = { ...t, key, items, i: 0 };
    drawMenu();
  }
  function closeMenu() {
    asked++;
    found = null;
    drawer.hidden = true;
    input.removeAttribute('aria-activedescendant');
  }
  function drawMenu() {
    const { items, i, kind } = found;
    drawer.hidden = false;
    drawer.setAttribute('aria-label', kind === '/' ? 'Commands' : 'Files and folders');
    drawer.replaceChildren(items.length ? h('div', { class: 'chat-menu-list' }, items.map((it, n) => h('div', {
      class: `chat-menu-item${n === i ? ' on' : ''}`, id: `${drawer.id}-${n}`, role: 'option', 'aria-selected': String(n === i), onClick: () => pick(it),
    }, icon(it.icon, 16), h('span', { class: 'chat-menu-label' }, it.label), h('span', { class: 'chat-menu-desc' }, it.desc))))
      : h('p', { class: 'chat-menu-empty' }, kind === '/' ? 'No matching command.' : 'No matching files or folders.'));
    if (items.length) input.setAttribute('aria-activedescendant', `${drawer.id}-${i}`);
    else input.removeAttribute('aria-activedescendant');
    drawer.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  function pick(it) {
    input.setRangeText(it.text, found.start, found.end, 'end');
    buttons();
    if (it.open) suggest();
    else closeMenu();
  }
  // The keys the open drawer takes; true when it took one.
  function menuKey(e) {
    const n = found.items.length;
    if (e.key === 'Escape') dismissed = found.key, closeMenu();
    else if (n && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) found.i = (found.i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n, drawMenu();
    else if (n && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) pick(found.items[found.i]);
    else return false;
    e.preventDefault();
    return true;
  }

  // The menu opens above the chip, as the composer sits at the foot of the window.
  function pickModel() {
    menu(chip, MODELS.map(([id, name]) => ({ label: name, icon: id === model ? 'check' : null, onClick: () => {
      if (id === model || !type(`/model ${id}`)) return;
      model = id;
      modelLabel.textContent = name;
    } })));
    const m = document.querySelector('.menu');
    if (m) m.style.top = `${Math.max(8, chip.getBoundingClientRect().top - m.offsetHeight - 6)}px`;
  }

  const terminalButton = () => h('button', { type: 'button', class: 'btn xs ghost', onClick: () => p.showChat(false) }, icon('terminal', 12), 'Open terminal');
  const optionRow = o => h('button', { type: 'button', class: 'chat-option', 'data-n': o.n, onClick: () => choose(o) },
    h('span', { class: 'chat-option-text' }, h('span', {}, o.label), o.description && h('span', { class: 'chat-option-desc' }, o.description)),
    o.n <= 9 && h('kbd', {}, String(o.n)));

  // An approval is T3's banner: Shield, "Command approval", the command, then Decline and Approve, the rest under "…".
  // Claude Code's first "Yes" approves and its "No" declines; every option keeps its number key.
  function approval() {
    const yes = panel.options.find(o => /^Yes\b/.test(o.label));
    const no = panel.options.find(o => /^No\b/.test(o.label));
    const rest = panel.options.filter(o => o !== yes && o !== no);
    const more = h('button', { type: 'button', class: 'btn xs', 'aria-label': 'More approval options', 'aria-haspopup': 'menu', onClick: () => {
      menu(more, [...rest.map(o => ({ label: o.label, sub: o.n <= 9 ? String(o.n) : '', onClick: () => choose(o) })),
        ...(rest.length ? ['sep'] : []), { label: 'Open terminal', icon: 'terminal', onClick: () => p.showChat(false) }], { align: 'right' });
    } }, icon('dots', 14));
    const answer = (o, text, kind) => o && h('button', { type: 'button', class: `btn xs ${kind}`.trim(), title: o.n <= 9 ? `${o.label} (${o.n})` : o.label, onClick: () => choose(o) }, text);
    return h('div', { class: 'chat-dock-row' },
      h('span', { class: 'chat-dock-icon', 'aria-hidden': 'true' }, icon('shield', 16)),
      h('span', { class: 'chat-dock-main' },
        h('span', { class: 'chat-dock-head' }, h('span', { class: 'chat-dock-title' }, panel.title), panel.step && h('span', { class: 'chat-dock-step' }, panel.step)),
        h('code', { class: 'chat-dock-body', tabindex: 0, 'aria-label': panel.title === 'Command approval' ? 'Command' : 'Request' }, panel.body)),
      h('span', { class: 'chat-dock-actions' }, answer(no, 'Decline', ''), answer(yes, 'Approve', 'primary'), more));
  }

  function render(next) {
    panel = next;
    choosing = false;
    dock.classList.remove('busy');
    dock.hidden = !panel;
    if (!panel) return dock.replaceChildren();
    dock.dataset.kind = panel.kind;
    dock.setAttribute('role', 'group');
    dock.setAttribute('aria-label', panel.title);
    if (panel.kind === 'approval') return dock.replaceChildren(approval(), h('div', { class: 'chat-dock-error', role: 'alert' }));
    dock.replaceChildren(
      h('div', { class: 'chat-dock-head' }, icon(panel.kind === 'question' ? 'message' : 'info', 14),
        h('span', { class: 'chat-dock-title' }, panel.title), panel.step && h('span', { class: 'chat-dock-step' }, panel.step),
        h('span', { class: 'grow' }), terminalButton()),
      panel.body && h('div', { class: 'chat-dock-body', tabindex: 0 }, panel.body),
      panel.options.length > 0 && h('div', { class: 'chat-dock-options' }, panel.options.map(optionRow)),
      h('div', { class: 'chat-dock-error', role: 'alert' }));
  }

  // While a panel is up the input is off, so focus goes to the panel's first choice, where 1–9 work.
  const focus = () => (input.disabled ? dock.querySelector('.chat-option, .btn.primary') ?? dock.querySelector('button') : input)?.focus();

  return {
    el,
    focus,
    keys,
    // `pending` is the tool still waiting for its result (or null); `menu` is the menu on Claude's screen (or null).
    update({ status, exited, prompting, menu, pending }) {
      const had = el.contains(document.activeElement);
      const up = prompting && !exited;
      input.disabled = exited || prompting;
      input.placeholder = exited ? 'This agent has exited' : prompting ? 'Choose an option above' : 'Ask anything, @tag files/folders, or / for commands';
      working = status === 'working' && !exited;
      buttons();
      const key = up ? JSON.stringify([menu, pending?.id]) : '';
      if (key === shown) return;
      shown = key;
      render(up ? panelOf(menu, pending) : null);
      if (had && up) focus();
    },
    // The pane's context meter (meter() in lib/sessions.mjs) as T3's ring, with its % beside it: dim, red over 90%.
    // Its popover has T3's "Context Window" card, plus the tokens so far by type.
    setMeter(m) {
      meter.wrap.hidden = !m;
      if (!m) return;
      const pct = m.used * 100 / m.effective;
      const fill = Math.max(0, Math.min(100, pct));
      const t = m.tokens;
      const priced = m.cost > 0 || !m.unpriced;
      arc.setAttribute('stroke-dashoffset', CIRCLE * (1 - fill / 100));
      meterButton.classList.toggle('bad', fill > 90);
      meterPct.textContent = percent(pct);
      meterButton.setAttribute('aria-label', `Context window ${percent(pct)} used`);
      const compact = h('button', { type: 'button', class: 'btn xs chat-pop-action', disabled: input.disabled, onClick: () => { document.activeElement.blur(); type('/compact'); } },
        icon('minimize', 12), 'Compact context');
      meter.pop.replaceChildren(...[
        h('div', { class: 'chat-pop-head' }, h('span', {}, 'Context Window'), h('span', { class: 'chat-pop-num' }, `${percent(pct)} · ${tokens(m.used)}/${tokens(m.effective)}`)),
        h('div', { class: 'chat-pop-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(fill), 'aria-label': 'Context window usage' },
          h('span', { style: `width: ${fill}%` })),
        popRow('Total processed', tokens(t.input + t.output + t.read + t.write)),
        popRow('Input · output', `${tokens(t.input)} · ${tokens(t.output)}`),
        popRow('Cache read · write', `${tokens(t.read)} · ${tokens(t.write)}`),
        priced && popRow('Cost', `${money(m.cost)} (API list prices)`),
        h('div', { class: 'chat-pop-note' }, `Compacts automatically at about ${m.effective.toLocaleString('en-US')} tokens.`),
        compact].filter(Boolean));
    },
  };

  // Typed into the terminal as a paste, then Enter on its own: Claude Code treats one big chunk as a paste.
  function type(text) {
    if (!text || input.disabled || p.ws?.readyState !== WebSocket.OPEN) return false;
    p.send(p.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text.replace(/\s*\n\s*/g, ' '));
    setTimeout(() => p.send('\r'), 150);
    return true;
  }

  // A slash command other than /compact or /clear draws its own screen, which only the terminal shows.
  function submit() {
    const text = input.value.replace(CONTROL, '').trim();
    if (!type(text)) return;
    input.value = '';
    buttons();
    el.dispatchEvent(new Event('sent'));
    if (/^\/(?!(compact|clear)\b)\S/.test(text)) p.showChat(false);
  }
}
