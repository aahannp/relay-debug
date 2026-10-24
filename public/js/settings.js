// Settings view: themes, agents and their guardrails, voice, notifications, and the MCP setup for your own Claude Code.
// One section at a time, laid out like T3's settings pages (SettingsSection, SettingsGroup, SettingsRow).
// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT © 2026 T3 Tools Inc. See NOTICE.
import { state, api, h, icon, avatar, on, emit, actions, copy, guard, modal, toast, confirmDialog, menu } from './ui.js';
import { modelSelect, effortSelect } from './agents.js';
import { openUpdates } from './updates.js';
import { THEMES } from './themes.js';

const PERMISSIONS = [
  ['default', 'Ask me', 'Agents ask before editing files or running commands. The safest choice.'],
  ['acceptEdits', 'Accept edits', 'File edits go through. Commands still ask first.'],
  ['auto', 'Auto', 'Claude decides what is safe to do without asking, and asks for the rest.'],
  ['plan', 'Plan only', 'Agents read and plan but change nothing.'],
];
const LANGUAGES = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-IN', 'English (India)'], ['hi-IN', 'Hindi'],
  ['es-ES', 'Spanish'], ['fr-FR', 'French'], ['de-DE', 'German'], ['pt-BR', 'Portuguese (Brazil)'], ['ja-JP', 'Japanese']];
// The defaults (as in lib/store.mjs) of what this page sets, for T3's per-row "Reset to default" and "Restore defaults".
const DEFAULTS = {
  sidebarHidden: ['Sidebar', false], fancyCursor: ['Animated cursor', false], scrollSpeed: ['Scroll speed', 1],
  theme: ['Theme', 't3dark'], fontSize: ['Text size', 13],
  defaultAgent: ['Default agent', 'claude'], agentDefaults: ['Model and effort', { claude: { model: 'sonnet', effort: '' }, lead: { model: 'opus', effort: 'high' } }],
  permissionMode: ['Permissions', 'default'], worktreeByDefault: ['Own git worktree', true], agentsAware: ['Awareness', true], spacesCanAsk: ['Projects ask each other', true],
  agentsCanMessage: ['Agents message', true], agentsAutonomous: ['Work together without asking', true], agentsCanSpawn: ['Agents start agents', true],
  leadUpkeep: ['Keep lead agents fresh', { on: false, compactAt: 70, windowCap: 200_000, replaceAfter: 3 }], agentsCanEditTeam: ['Agents edit the team', true],
  voiceLang: ['Language', 'en-US'], autoUpdate: ['Update automatically', true],
};
const same = (a, b) => a === b || (a && b && typeof a === 'object' && typeof b === 'object' && Object.keys({ ...a, ...b }).every(k => same(a[k], b[k])));
const changed = () => Object.keys(DEFAULTS).filter(k => !same(state.settings[k], DEFAULTS[k][1]));
let root;
let section = 'general';

// The settings sections, for the sidebar's settings nav. emit('settings:section', id) shows one.
export const SECTIONS = [
  { id: 'general', label: 'General', icon: 'settings2' },
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'agents', label: 'Agents', icon: 'bot' },
  { id: 'team', label: 'Team', icon: 'users' },
  { id: 'voice', label: 'Voice', icon: 'mic' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'mcp', label: 'Claude Code', icon: 'blocks' },
  { id: 'keyboard', label: 'Keybindings', icon: 'keyboard' },
  { id: 'about', label: 'About', icon: 'info' },
];

export function mount(el) {
  root = h('div', { class: 'settings' });
  el.append(root);
  for (const kind of ['settings', 'specialists']) on(kind, () => actions.currentView() === 'settings' && render());
  on('settings:section', id => {
    section = PAGES[id] ? id : 'general';
    actions.showView('settings'); // renders the section and the breadcrumb
    root.scrollTop = 0;
  });
  // Escape leaves Settings, as in T3, unless a dialog or a text field has it.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || actions.currentView() !== 'settings') return;
    if (e.target.closest?.('textarea, select, input:not([type=checkbox]):not([type=range])')) return;
    actions.showView('agents');
  });
}
export const show = () => render();
// T3's "Restore defaults", on General: puts every setting on this page back, after saying which ones change.
export const toolbar = () => section === 'general' ? [h('button', { class: 'btn xs ghost', disabled: !changed().length, onClick: restore }, icon('undo', 14), 'Restore defaults')] : [];
const restore = guard(async () => {
  const keys = changed();
  if (!keys.length || !await confirmDialog('Restore default settings?', `This will reset: ${keys.map(k => DEFAULTS[k][0]).join(', ')}.`, { label: 'Restore', danger: true })) return;
  set(Object.fromEntries(keys.map(k => [k, DEFAULTS[k][1]])));
});
// The header's breadcrumb: Settings / General.
export const title = () => h('nav', { class: 'page-crumbs', 'aria-label': 'Breadcrumb' }, h('ol', {},
  h('li', {}, 'Settings'), h('li', { class: 'sep', 'aria-hidden': 'true' }, '/'),
  h('li', { 'aria-current': 'page' }, h('h1', {}, SECTIONS.find(x => x.id === section).label))));

const set = patch => actions.setSetting(patch);
// T3's SettingsRow: title and description on the left, the control on the right (stacked under 32rem). With a reset
// patch, an Undo button by the title puts the row back to its default while it differs.
const setting = (title, text, control, reset) => h('div', { class: 'setting' }, h('div', { class: 'setting-grid' },
  h('div', { class: 'label' }, h('h3', {}, title, reset && Object.entries(reset).some(([k, v]) => !same(state.settings[k], v))
    && h('button', { type: 'button', class: 'setting-reset', title: 'Reset to default', 'aria-label': `Reset ${title} to default`, onClick: () => set(reset) }, icon('undo2', 12))),
  text && h('p', {}, text)), control && h('div', { class: 'setting-control' }, control)));
const reset = key => ({ [key]: DEFAULTS[key][1] });
// T3's SettingsSection: a quiet h2 (with an optional action) over a rounded card of rows.
const group = (title, rows, { action } = {}) => h('section', { class: 'settings-section' },
  h('div', { class: 'settings-section-head' }, h('h2', {}, title), action),
  h('div', { class: 'settings-group' }, ...rows));
// T3's Select: a button with the chosen option whose list opens with menu(), keyboard included. The native <select>
// stays the value (off the page), so listeners on it still hear 'change'.
function popupSelect(select, label) {
  const text = h('span', {}, select.selectedOptions[0]?.textContent ?? '');
  const trigger = h('button', { type: 'button', class: 'select-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label, onClick: open,
    onKeydown: e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } } }, text, icon('chevronDown', 12));
  function open() {
    const pick = o => { select.value = o.value; text.textContent = o.textContent; trigger.focus(); select.dispatchEvent(new Event('change')); };
    menu(trigger, [...select.options].map(o => ({ label: o.textContent, onClick: () => pick(o) })));
    const m = document.querySelector('.menu');
    const items = [...m.querySelectorAll('.menu-item')];
    m.classList.add('select-menu');
    m.setAttribute('role', 'listbox');
    m.setAttribute('aria-label', label);
    m.style.minWidth = `${trigger.offsetWidth}px`;
    items.forEach((el, i) => {
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(i === select.selectedIndex));
      if (i === select.selectedIndex) el.classList.add('sel'), el.append(icon('check', 14));
    });
    trigger.setAttribute('aria-expanded', 'true');
    const shut = refocus => { m.remove(); trigger.setAttribute('aria-expanded', 'false'); if (refocus) trigger.focus(); };
    m.addEventListener('keydown', e => {
      const at = { ArrowDown: items.indexOf(document.activeElement) + 1, ArrowUp: items.indexOf(document.activeElement) - 1, Home: 0, End: items.length - 1 }[e.key];
      if (at !== undefined) { e.preventDefault(); items[(at + items.length) % items.length].focus(); }
      if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); shut(true); }
    });
    // A click outside, or focus moving on. Deferred: removing the menu fires focusout too, and a second remove() inside it throws.
    m.addEventListener('focusout', e => !m.contains(e.relatedTarget) && setTimeout(() => shut(false)));
    (items[select.selectedIndex] ?? items[0])?.focus();
  }
  return trigger;
}
// Anything in a card that isn't a row: the theme grid, a code block.
const block = (...children) => h('div', { class: 'settings-block' }, ...children);
const toggle = (checked, onChange) => h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked, onChange: e => onChange(e.target.checked) }));

const PAGES = {
  general: s => [
    group('General', [
      setting('Sidebar', 'Hide it to give the panes the whole window. ⌘B or the button at the top left also do it.',
        toggle(s.sidebarHidden !== true, on => set({ sidebarHidden: !on })), reset('sidebarHidden')),
      setting('Animated cursor', 'A custom cursor that reacts to what you point at. It steps aside over terminals and text.',
        toggle(s.fancyCursor === true, on => set({ fancyCursor: on })), reset('fancyCursor')),
      setting('Scroll speed', `${s.scrollSpeed ?? 1}× how far your trackpad or wheel moves. 1× matches Terminal and iTerm.`,
        h('input', { type: 'range', min: 0.5, max: 3, step: 0.25, value: s.scrollSpeed ?? 1, onChange: e => set({ scrollSpeed: Number(e.target.value) }) }), reset('scrollSpeed')),
    ]),
  ],

  appearance: s => {
    const current = THEMES[s.theme] ? s.theme : 't3dark';
    return [
      group('Theme', [block(...[['Dark', true], ['Light', false]].flatMap(([label, dark]) => [h('h3', { class: 'theme-group' }, label),
        h('div', { class: 'themes' }, Object.entries(THEMES).filter(([, t]) => t.dark === dark).map(([id, t]) => h('button', { class: `theme-card${id === current ? ' on' : ''}`, onClick: () => set({ theme: id }) },
          h('div', { class: 'theme-prev', style: { background: t.ui.bg } },
            h('div', { class: 'sb', style: { background: t.ui.side, borderRight: `1px solid ${t.ui.line}` } }),
            h('div', { class: 'body' },
              h('div', { class: 'bar', style: { background: t.term.blue, width: '42%' } }),
              h('div', { class: 'bar', style: { background: t.ui.line, width: '76%' } }),
              h('div', { class: 'bar', style: { background: t.ui.line, width: '58%' } }),
              h('div', { class: 'ansi' }, ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].map(c => h('i', { style: { background: t.term[c] } }))))),
          h('div', { class: 'theme-name', style: { background: t.ui.panel, color: t.ui.text } }, t.name))))]))],
      ),
      group('Text', [
        setting('Terminal and editor text size', `${s.fontSize}px`, h('input', { type: 'range', min: 10, max: 20, value: s.fontSize, onChange: e => set({ fontSize: Number(e.target.value) }) }), reset('fontSize')),
      ]),
    ];
  },

  agents: s => [
    group('Coding agents', [block(h('p', { class: 'settings-text' }, 'Relay runs each agent\'s own command-line tool with your own login, so Claude Code uses your Claude subscription.')),
      ...state.agents.map(a => h('div', { class: 'agent-row' },
      avatar({ kind: 'agent', agent: a.id }), h('b', {}, a.label), h('span', { class: 'grow' }),
      a.installed ? h('span', { class: 'chip', style: { color: 'var(--ok)' } }, icon('check', 11), 'Installed') : h('span', { class: 'chip' }, 'Not found on your PATH'),
      a.installed && h('button', { class: `btn xs${s.defaultAgent === a.id ? ' primary' : ''}`, onClick: () => set({ defaultAgent: a.id }) }, s.defaultAgent === a.id ? 'Default' : 'Make default')))]),
    group('Defaults', [
      ...[['claude', 'workers', 'New Claude Code threads, workers, and specialists left on the default. Sonnet keeps spend down; pick Opus for harder work.'], ['lead', 'lead agents', 'The agent that plans and hands out the work.']].map(([kind, title, text]) => {
        const d = s.agentDefaults?.[kind] ?? { model: '', effort: '' };
        const save = patch => set({ agentDefaults: { ...s.agentDefaults, [kind]: { ...d, ...patch } } });
        const model = modelSelect(d.model);
        const effort = effortSelect(d.effort);
        model.options[0].textContent = 'Your Claude Code default';
        effort.options[0].textContent = 'Your Claude Code default';
        model.addEventListener('change', () => save({ model: model.value }));
        effort.addEventListener('change', () => save({ effort: effort.value }));
        return setting(`Model and effort for ${title}`, `${text} Agents can still ask for a lighter or stronger one for a job.`,
          h('div', { class: 'row' }, popupSelect(model, `Model for ${title}`), popupSelect(effort, `Effort for ${title}`)),
          { agentDefaults: { ...s.agentDefaults, [kind]: DEFAULTS.agentDefaults[1][kind] } });
      }),
      setting('Permissions for Claude agents', PERMISSIONS.find(p => p[0] === s.permissionMode)?.[2] ?? '',
        h('div', { class: 'segmented' }, PERMISSIONS.map(([id, label]) => h('button', { class: s.permissionMode === id ? 'on' : '', onClick: () => set({ permissionMode: id }) }, label))), reset('permissionMode')),
      setting('Give new tasks their own git worktree', 'Agents running at the same time then never edit the same files. You merge their work from Review.',
        toggle(s.worktreeByDefault, on => set({ worktreeByDefault: on })), reset('worktreeByDefault')),
    ]),
    group('Awareness', [
      setting("Tell agents what's happening around them", 'Each agent starts with a short summary of the other agents and the board, and hears what changed before each turn, like a task moving or another agent editing the same file.',
        toggle(s.agentsAware !== false, on => set({ agentsAware: on })), reset('agentsAware')),
      setting('Let projects ask each other', 'An agent can ask another project\'s lead a question and gets a short answer back; it never reads their threads or board.',
        toggle(s.spacesCanAsk !== false, on => set({ spacesCanAsk: on })), reset('spacesCanAsk')),
    ]),
  ],

  team: s => [
    group('Specialists', [block(h('p', { class: 'settings-text' }, 'Specialists are Claude agents with a name, one area of expertise, their own instructions and, if you like, a model. Every agent knows who is on the team, so it can hand a job to the right one. Start one from the New Claude Code menu.')),
      ...state.specialists.map(x => h('div', { class: 'agent-row' },
      avatar({ specialist: x }), h('div', { class: 'grow' }, h('b', {}, x.name), h('div', { class: 'muted', style: { fontSize: '12px' } }, x.role)),
      h('span', { class: 'chip' }, [x.model || 'default model', x.effort || 'default effort', ...(x.readOnly ? ['read-only'] : [])].join(' · ')),
      h('button', { class: 'btn xs', onClick: () => editSpecialist(x) }, 'Edit'),
      h('button', { class: 'icon-btn', title: `Remove ${x.name}`, 'aria-label': `Remove ${x.name}`, onClick: () => removeSpecialist(x) }, icon('trash', 14)))),
      ...(state.specialists.length ? [] : [block(h('p', { class: 'muted', style: { margin: 0, fontSize: '12px' } }, 'No specialists yet.'))])], {
      action: h('button', { class: 'btn xs', onClick: () => editSpecialist() }, icon('plus', 13), 'Add a specialist'),
    }),
    group('Working together', [
      setting('Agents can message each other', s.agentsCanMessage !== false
        ? 'On: when you ask, an agent can send another one a message (it\'s typed into their thread, signed with who sent it), and they can answer.'
        : 'Off: agents work alone; only you type into their threads.',
      toggle(s.agentsCanMessage !== false, on => set({ agentsCanMessage: on })), reset('agentsCanMessage')),
      setting('Agents work together without asking', s.agentsAutonomous !== false
        ? 'On: agents message, read and copy each other without asking you each time. Their edits and commands still ask, as Permissions says. Applies to agents started from now on.'
        : 'Off: an agent asks you before each message to another agent or each copy it makes.',
      toggle(s.agentsAutonomous !== false, on => set({ agentsAutonomous: on })), reset('agentsAutonomous')),
      setting('Agents can start other agents', s.agentsCanSpawn !== false
        ? 'On: an agent can start a specialist or a worker, on a model it picks, for part of its job. A lead agent needs this.'
        : 'Off: agents can see the team but only you start agents.',
      toggle(s.agentsCanSpawn !== false, on => set({ agentsCanSpawn: on })), reset('agentsCanSpawn')),
      leadUpkeep({ on: false, compactAt: 70, windowCap: 200_000, replaceAfter: 3, ...s.leadUpkeep }),
      setting('Agents can edit the team', s.agentsCanEditTeam !== false
        ? 'On: when you ask ("Scout, make your answers shorter"), an agent can change a specialist\'s profile. It asks you first each time. Applies to agents started from then on.'
        : 'Off: agents can read the team\'s profiles but only you change them.',
      toggle(s.agentsCanEditTeam !== false, on => set({ agentsCanEditTeam: on })), reset('agentsCanEditTeam')),
    ]),
  ],

  voice: s => [
    group('Voice', [
      setting('Language', `What you'll speak in. ${state.info.voice ? 'On-device speech recognition from macOS: nothing you say leaves your Mac.'
        : window.webkitSpeechRecognition ? 'Uses your browser\'s speech recognition, which sends audio to the browser maker. The Mac app does it on-device instead.'
          : 'Voice needs the Relay Mac app or Chrome. macOS Dictation (press Fn twice) also works in any thread.'}`,
      popupSelect(h('select', { onChange: e => set({ voiceLang: e.target.value }) }, LANGUAGES.map(([id, label]) => h('option', { value: id, selected: s.voiceLang === id }, label))), 'Language'),
      reset('voiceLang')),
      setting('How to use it', 'Click into a thread or text box, press ⌘⇧M and talk. It stops after a short pause. End with “send” to press Enter.', h('kbd', {}, '⌘⇧M')),
    ]),
  ],

  notifications: () => [
    group('Notifications', [
      setting('Desktop notifications', `Get told when an agent needs you or finishes, even when Relay is in the background. ${!('Notification' in window) ? 'Not supported here.' : Notification.permission === 'granted' ? 'On.' : 'Off: your browser will ask you first.'}`,
        'Notification' in window && Notification.permission !== 'granted'
          ? h('button', { class: 'btn sm', onClick: async () => { await Notification.requestPermission(); render(); } }, 'Turn on')
          : h('span', { class: 'chip', style: { color: 'var(--ok)' } }, icon('check', 11), 'On')),
    ]),
  ],

  mcp: () => {
    const mcpCommand = `claude mcp add --transport http --scope user agent-desk ${state.info.mcpUrl} --header "x-desk-token: ${state.info.token}"`;
    return [
      group('Use the board from your own Claude Code', [block(
        h('p', { class: 'settings-text' }, 'Agents inside Relay already have these tools. Run this once in a terminal to give the same tools (tasks, agents, the team, artifacts, diffs) to Claude Code everywhere else.'),
        h('div', { class: 'codeblock' }, mcpCommand, h('button', { class: 'icon-btn', title: 'Copy', 'aria-label': 'Copy the command', onClick: () => copy(mcpCommand) }, icon('copy', 14))),
        h('p', { class: 'muted', style: { margin: '10px 0 0', fontSize: '12px' } }, 'The command includes this Relay\'s secret, so don\'t share it.'))]),
    ];
  },

  keyboard: () => [
    group('Shortcuts', [
      ['Command palette', '⌘K'], ['Voice input', '⌘⇧M'], ['Switch views', '⌘1 – ⌘9'], ['Show or hide the sidebar', '⌘B'], ['Save file', '⌘S'],
      ['Maximise a pane', 'double-click its header'], ['Close dialogs, leave Settings', 'Esc'],
    ].map(([what, keys]) => setting(what, null, h('kbd', {}, keys)))),
  ],

  about: s => [
    group('About', [
      setting(`Relay${state.info.version ? ` v${state.info.version}` : ''}`, `${state.info.electron ? 'Mac app' : 'In the browser'} · server ${state.info.url}`,
        h('button', { class: 'btn sm', onClick: () => openUpdates() }, icon('refresh', 13), 'Check for updates')),
      setting('Update automatically', s.autoUpdate !== false
        ? 'On: the Mac app downloads new versions in the background, checks them, and installs them when you quit Relay or click Restart to update. It never restarts on its own.'
        : 'Off: the Update button downloads the new .dmg to your Downloads folder for you to drag into Applications.',
      toggle(s.autoUpdate !== false, on => set({ autoUpdate: on })), reset('autoUpdate')),
    ]),
  ],
};

// Every save re-renders, so keep keyboard focus on the same control of the same row (counted from the row's end:
// a reset button may come or go before it).
const controls = row => [...row.querySelectorAll('button, input, select, textarea')].reverse();
function render() {
  const row = root.contains(document.activeElement) && document.activeElement.closest('.setting');
  const title = row && row.querySelector('h3')?.textContent, at = row && controls(row).indexOf(document.activeElement);
  root.replaceChildren(h('div', { class: 'settings-inner' }, ...PAGES[section](state.settings)));
  const again = row && [...root.querySelectorAll('.setting')].find(r => r.querySelector('h3')?.textContent === title);
  if (again) controls(again)[at]?.focus({ preventScroll: true });
}

// T3's settings search: every row's title and description, across the sections. Built off-screen, only as you type.
export const find = q => SECTIONS.flatMap(x => [...h('div', {}, ...PAGES[x.id](state.settings)).querySelectorAll('.setting .label')]
  .map(l => ({ section: x.id, where: x.label, title: l.querySelector('h3').textContent, text: l.querySelector('p')?.textContent ?? '' })))
  .filter(r => `${r.title} ${r.text} ${r.where}`.toLowerCase().includes(q));
// Open a hit's section and bring its row into view.
export function reveal(hit) {
  emit('settings:section', hit.section);
  [...root.querySelectorAll('.setting .label h3')].find(t => t.textContent === hit.title)?.closest('.setting').scrollIntoView({ block: 'center' });
}

// A switch plus three small numbers: when to compact a lead (a % of a window in thousands of tokens), and after
// how many compactions to replace it.
function leadUpkeep(u) {
  const save = patch => set({ leadUpkeep: { ...u, ...patch } });
  const number = (key, min, max, scale = 1) => h('input', { class: 'input', type: 'number', min, max, value: u[key] / scale, style: { width: '62px' },
    onChange: e => save({ [key]: Math.round(Number(e.target.value)) * scale }) });
  return setting('Keep lead agents fresh', 'When a lead is idle with its context that full, Relay compacts it, and after that many compactions a fresh lead with the same name takes over its work. A smaller window (the model\'s own, or the auto-compact window: your Claude Code\'s, else 200K) wins.',
    h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      'Compact at', number('compactAt', 50, 95), '% of a', number('windowCap', 50, 2000, 1000), 'K-token window, replace after', number('replaceAfter', 1, 10), 'compactions',
      toggle(u.on, on => save({ on }))), reset('leadUpkeep'));
}

// The Mac app grants notifications without a prompt; in a browser you turn them on above.
if ('Notification' in window && Notification.permission === 'default' && navigator.userAgent.includes('Electron')) Notification.requestPermission();

// Adding or changing a specialist: a name, what they're good at, their instructions and their model.
function editSpecialist(x = null) {
  const name = h('input', { class: 'input', value: x?.name ?? '', placeholder: 'A name, like Rhea' });
  const role = h('input', { class: 'input', value: x?.role ?? '', placeholder: 'What they are good at, like: Code reviewer: finds bugs before you merge' });
  const model = modelSelect(x?.model ?? '');
  model.options[0].textContent = 'Worker default (Settings)';
  const effort = effortSelect(x?.effort ?? '');
  effort.options[0].textContent = 'Worker default (Settings)';
  const readOnly = h('input', { type: 'checkbox', checked: !!x?.readOnly });
  const instructions = h('textarea', { class: 'input', rows: 9, value: x?.instructions ?? '', placeholder: 'How they work: what to focus on, what to avoid, how to report back.' });
  modal({
    title: x ? `Edit ${x.name}` : 'Add a specialist', width: 600,
    body: [
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('div', { class: 'row' }, h('label', { class: 'field', style: { flex: 1 } }, h('span', {}, 'Usual model'), model), h('label', { class: 'field', style: { flex: 1 } }, h('span', {}, 'Usual effort'), effort)),
      h('label', { class: 'field' }, h('span', {}, 'Good at'), role),
      h('label', { class: 'field' }, h('span', {}, 'Instructions'), instructions),
      h('label', { class: 'toggle', title: 'Edit, Write, MultiEdit and NotebookEdit are turned off for them' }, readOnly, 'Read-only: Claude Code blocks their file-editing tools'),
    ],
    actions: [{ label: 'Cancel' }, { label: x ? 'Save' : 'Add', primary: true, onClick: async () => {
      try {
        const body = { name: name.value, role: role.value, model: model.value, effort: effort.value, readOnly: readOnly.checked, instructions: instructions.value };
        await api(x ? 'PATCH' : 'POST', x ? `/api/specialists/${x.id}` : '/api/specialists', body);
      } catch (e) {
        toast(e.message, 'error');
        return false;
      }
    } }],
  });
}

const removeSpecialist = guard(async x => {
  if (await confirmDialog(`Remove ${x.name}?`, `${x.name} leaves the team. Their past threads stay in the sidebar.`, { label: 'Remove', danger: true })) {
    await api('DELETE', `/api/specialists/${x.id}`);
  }
});
