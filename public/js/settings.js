// Settings view: themes, agents and their guardrails, voice, notifications, and the MCP setup for your own Claude Code.
import { state, api, h, icon, avatar, on, actions, copy, guard, modal, toast, confirmDialog } from './ui.js';
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
let root;

// The settings sections, for a nav beside the page. emit('settings:section', id) goes to one.
export const SECTIONS = [
  { id: 'general', label: 'General', icon: 'settings2' },
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'agents', label: 'Agents', icon: 'bot' },
  { id: 'team', label: 'Team', icon: 'users' },
  { id: 'voice', label: 'Voice', icon: 'mic' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'mcp', label: 'Claude Code', icon: 'blocks' },
  { id: 'keyboard', label: 'Keyboard', icon: 'keyboard' },
  { id: 'about', label: 'About', icon: 'info' },
];

export function mount(el) {
  root = h('div', { class: 'settings' });
  el.append(root);
  for (const kind of ['settings', 'specialists']) on(kind, () => actions.currentView() === 'settings' && render());
  // Still one long page: scroll to the section whose heading names it (General is the top).
  on('settings:section', id => {
    const label = SECTIONS.find(x => x.id === id)?.label;
    actions.showView('settings');
    const heading = id !== 'general' && [...root.querySelectorAll('.card-section > h2')].find(x => x.textContent.includes(label));
    (heading?.parentElement ?? root).scrollIntoView({ block: 'start' });
  });
}
export const show = () => render();

const set = patch => actions.setSetting(patch);
const setting = (title, text, control) => h('div', { class: 'setting' }, h('div', { class: 'label' }, h('b', {}, title), h('span', {}, text)), control);
const section = (title, text, ...body) => h('section', { class: 'card-section' }, h('h2', {}, title), text && h('p', {}, text), ...body);

function render() {
  const s = state.settings;
  const current = THEMES[s.theme] ? s.theme : 't3dark';
  const mcpCommand = `claude mcp add --transport http --scope user agent-desk ${state.info.mcpUrl} --header "x-desk-token: ${state.info.token}"`;

  root.replaceChildren(h('div', { class: 'settings-inner' },
    section('Appearance', `${Object.keys(THEMES).length} themes, dark and light.`,
      ...[['Dark', true], ['Light', false]].flatMap(([label, dark]) => [h('h3', { class: 'theme-group' }, label),
      h('div', { class: 'themes' }, Object.entries(THEMES).filter(([, t]) => t.dark === dark).map(([id, t]) => h('button', { class: `theme-card${id === current ? ' on' : ''}`, onClick: () => set({ theme: id }) },
        h('div', { class: 'theme-prev', style: { background: t.ui.bg } },
          h('div', { class: 'sb', style: { background: t.ui.side, borderRight: `1px solid ${t.ui.line}` } }),
          h('div', { class: 'body' },
            h('div', { class: 'bar', style: { background: t.term.blue, width: '42%' } }),
            h('div', { class: 'bar', style: { background: t.ui.line, width: '76%' } }),
            h('div', { class: 'bar', style: { background: t.ui.line, width: '58%' } }),
            h('div', { class: 'ansi' }, ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].map(c => h('i', { style: { background: t.term[c] } }))))),
        h('div', { class: 'theme-name', style: { background: t.ui.panel, color: t.ui.text } }, t.name))))]),
      setting('Sidebar', 'Hide it to give the panes the whole window. ⌘B or the button at the top left also do it.',
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.sidebarHidden !== true, onChange: e => set({ sidebarHidden: !e.target.checked }) }))),
      setting('Animated cursor', 'A custom cursor that reacts to what you point at. It steps aside over terminals and text.',
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.fancyCursor !== false, onChange: e => set({ fancyCursor: e.target.checked }) }))),
      setting('Scroll speed', `${s.scrollSpeed ?? 1}× how far your trackpad or wheel moves. 1× matches Terminal and iTerm.`,
        h('input', { type: 'range', min: 0.5, max: 3, step: 0.25, value: s.scrollSpeed ?? 1, onChange: e => set({ scrollSpeed: Number(e.target.value) }) })),
      setting('Terminal and editor text size', `${s.fontSize}px`, h('input', { type: 'range', min: 10, max: 20, value: s.fontSize, onChange: e => set({ fontSize: Number(e.target.value) }) }))),

    section('Agents', 'Relay runs each agent\'s own command-line tool with your own login, so Claude Code uses your Claude subscription.',
      h('div', { class: 'agent-list' }, state.agents.map(a => h('div', { class: 'agent-row' },
        avatar({ kind: 'agent', agent: a.id }), h('b', {}, a.label), h('span', { class: 'grow' }),
        a.installed ? h('span', { class: 'chip', style: { color: 'var(--ok)' } }, icon('check', 11), 'Installed') : h('span', { class: 'chip' }, 'Not found on your PATH'),
        a.installed && h('button', { class: `btn xs${s.defaultAgent === a.id ? ' primary' : ''}`, onClick: () => set({ defaultAgent: a.id }) }, s.defaultAgent === a.id ? 'Default' : 'Make default')))),
      ...[['claude', 'workers', 'New Claude Code panes, workers, and specialists left on the default. Sonnet keeps spend down; pick Opus for harder work.'], ['lead', 'lead agents', 'The agent that plans and hands out the work.']].map(([kind, title, text]) => {
        const d = s.agentDefaults?.[kind] ?? { model: '', effort: '' };
        const save = patch => set({ agentDefaults: { ...s.agentDefaults, [kind]: { ...d, ...patch } } });
        const model = modelSelect(d.model);
        const effort = effortSelect(d.effort);
        model.options[0].textContent = 'Your Claude Code default';
        effort.options[0].textContent = 'Your Claude Code default';
        model.addEventListener('change', () => save({ model: model.value }));
        effort.addEventListener('change', () => save({ effort: effort.value }));
        return setting(`Model and effort for ${title}`, `${text} Agents can still ask for a lighter or stronger one for a job.`,
          h('div', { class: 'row' }, model, effort));
      }),
      setting('Permissions for Claude agents', PERMISSIONS.find(p => p[0] === s.permissionMode)?.[2] ?? '',
        h('div', { class: 'segmented' }, PERMISSIONS.map(([id, label]) => h('button', { class: s.permissionMode === id ? 'on' : '', onClick: () => set({ permissionMode: id }) }, label)))),
      setting('Give new tasks their own git worktree', 'Agents running at the same time then never edit the same files. You merge their work from Review.',
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.worktreeByDefault, onChange: e => set({ worktreeByDefault: e.target.checked }) }))),
      setting("Tell agents what's happening around them", 'Each agent starts with a short summary of the other agents and the board, and hears what changed before each turn, like a task moving or another agent editing the same file.',
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.agentsAware !== false, onChange: e => set({ agentsAware: e.target.checked }) }))),
      setting('Let spaces ask each other', 'Each project folder is a space. An agent can ask another folder\'s lead a question and gets a short answer back; it never reads their chats or board.',
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.spacesCanAsk !== false, onChange: e => set({ spacesCanAsk: e.target.checked }) })))),

    section('Team', 'Specialists are Claude agents with a name, one area of expertise, their own instructions and, if you like, a model. Every agent knows who is on the team, so it can hand a job to the right one. Start one from the New Claude Code menu.',
      h('div', { class: 'agent-list' }, state.specialists.map(x => h('div', { class: 'agent-row' },
        avatar({ specialist: x }), h('div', { class: 'grow' }, h('b', {}, x.name), h('div', { class: 'muted', style: { fontSize: '12px' } }, x.role)),
        h('span', { class: 'chip' }, [x.model || 'default model', x.effort || 'default effort', ...(x.readOnly ? ['read-only'] : [])].join(' · ')),
        h('button', { class: 'btn xs', onClick: () => editSpecialist(x) }, 'Edit'),
        h('button', { class: 'icon-btn', title: `Remove ${x.name}`, onClick: () => removeSpecialist(x) }, icon('trash', 14))))),
      h('div', { class: 'row', style: { margin: '12px 0 4px' } }, h('button', { class: 'btn sm', onClick: () => editSpecialist() }, icon('plus', 13), 'Add a specialist')),
      setting('Agents can message each other', s.agentsCanMessage !== false
        ? 'On: when you ask, an agent can send another one a message (it\'s typed into their pane, signed with who sent it), and they can answer.'
        : 'Off: agents work alone; only you type into their panes.',
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.agentsCanMessage !== false, onChange: e => set({ agentsCanMessage: e.target.checked }) }))),
      setting('Agents work together without asking', s.agentsAutonomous !== false
        ? 'On: agents message, read and copy each other without asking you each time. Their edits and commands still ask, as Permissions says. Applies to agents started from now on.'
        : 'Off: an agent asks you before each message to another agent or each copy it makes.',
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.agentsAutonomous !== false, onChange: e => set({ agentsAutonomous: e.target.checked }) }))),
      setting('Agents can start other agents', s.agentsCanSpawn !== false
        ? 'On: an agent can start a specialist or a worker, on a model it picks, for part of its job. A lead agent needs this.'
        : 'Off: agents can see the team but only you start agents.',
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.agentsCanSpawn !== false, onChange: e => set({ agentsCanSpawn: e.target.checked }) }))),
      leadUpkeep({ on: false, compactAt: 70, windowCap: 200_000, replaceAfter: 3, ...s.leadUpkeep }),
      setting('Agents can edit the team', s.agentsCanEditTeam !== false
        ? 'On: when you ask ("Scout, make your answers shorter"), an agent can change a specialist\'s profile. It asks you first each time. Applies to agents started from then on.'
        : 'Off: agents can read the team\'s profiles but only you change them.',
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.agentsCanEditTeam !== false, onChange: e => set({ agentsCanEditTeam: e.target.checked }) })))),

    section('Voice', state.info.voice ? 'On-device speech recognition from macOS. Nothing you say leaves your Mac.'
      : window.webkitSpeechRecognition ? 'Uses your browser\'s speech recognition, which sends audio to the browser maker. The Mac app does it on-device instead.'
        : 'Voice needs the Relay Mac app or Chrome. macOS Dictation (press Fn twice) also works in any pane.',
    setting('Language', 'What you\'ll speak in.', h('select', { class: 'input', style: { width: 'auto' }, onChange: e => set({ voiceLang: e.target.value }) },
      LANGUAGES.map(([id, label]) => h('option', { value: id, selected: s.voiceLang === id }, label)))),
    setting('How to use it', 'Click into a pane or text box, press ⌘⇧M and talk. It stops after a short pause. End with “send” to press Enter.', h('kbd', {}, '⌘⇧M'))),

    section('Notifications', 'Get told when an agent needs you or finishes, even when Relay is in the background.',
      setting('Desktop notifications', !('Notification' in window) ? 'Not supported here.' : Notification.permission === 'granted' ? 'On.' : 'Off. Your browser will ask you first.',
        'Notification' in window && Notification.permission !== 'granted'
          ? h('button', { class: 'btn sm', onClick: async () => { await Notification.requestPermission(); render(); } }, 'Turn on')
          : h('span', { class: 'chip', style: { color: 'var(--ok)' } }, icon('check', 11), 'On'))),

    section('Use the board from your own Claude Code', 'Agents inside Relay already have these tools. Run this once in a terminal to give the same tools (tasks, agents, the team, artifacts, diffs) to Claude Code everywhere else.',
      h('div', { class: 'codeblock' }, mcpCommand, h('button', { class: 'icon-btn', title: 'Copy', onClick: () => copy(mcpCommand) }, icon('copy', 14))),
      h('p', { class: 'muted', style: { margin: '10px 0 0', fontSize: '12px' } }, 'The command includes this Relay\'s secret, so don\'t share it.')),

    section('Keyboard', null, h('div', { class: 'keys' }, [
      ['Command palette', '⌘K'], ['Voice input', '⌘⇧M'], ['Switch views', '⌘1 – ⌘7'], ['Save file', '⌘S'],
      ['Maximise a pane', 'double-click its header'], ['Close dialogs', 'Esc'],
    ].map(([what, keys]) => h('div', {}, what, h('kbd', {}, keys))))),

    section('About', null, h('div', { class: 'row' }, h('p', { class: 'muted grow', style: { margin: 0 } },
      `Relay ${state.info.version ? `v${state.info.version} ` : ''}${state.info.electron ? 'Mac app' : 'in the browser'} · server ${state.info.url}`),
    h('button', { class: 'btn sm', onClick: () => openUpdates() }, icon('refresh', 13), 'Check for updates')),
    setting('Update automatically', s.autoUpdate !== false
      ? 'On: the Mac app downloads new versions in the background, checks them, and installs them when you quit Relay or click Restart to update. It never restarts on its own.'
      : 'Off: the Update button downloads the new .dmg to your Downloads folder for you to drag into Applications.',
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.autoUpdate !== false, onChange: e => set({ autoUpdate: e.target.checked }) }))))));
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
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: u.on, onChange: e => save({ on: e.target.checked }) }))));
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
  if (await confirmDialog(`Remove ${x.name}?`, `${x.name} leaves the team. Their past chats stay in the sidebar.`, { label: 'Remove', danger: true })) {
    await api('DELETE', `/api/specialists/${x.id}`);
  }
});
