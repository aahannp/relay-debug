// Everything Relay remembers between runs: projects, tasks, worktrees and settings, in one JSON file.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Emits 'event' with { type: 'projects' | 'tasks' | 'settings' | 'sessions' | 'voice', ...details }; pages refetch on it.
export const bus = new EventEmitter();

const DEFAULTS = {
  projects: [], // { path, name, addedAt, repos? }: repos are other git repos this project's agents changed
  tasks: [],
  chats: [], // every agent conversation, kept after it stops so it can be resumed
  shells: [], // shell panes open at quit, { id, project, cwd, name, createdAt }: Relay opens a fresh one in the same folder
  artifacts: [], // pages and reports agents saved; the HTML itself is in <data>/artifacts
  artifactFolders: [], // names of the Artifacts tab's folders, in order; a page's folder is its `folder` (none = Unfiled)
  messages: [], // the last 500 messages between agents, for the Graph: { at, project, fromId, fromName, toId, toName, via } (never the text)
  groups: [], // named groups on the Graph: { id, project, name, color, members: [chatId, or session id for shells] }
  workersOnSonnet: true, // see load
  removedSpecialists: [], // ids of built-in specialists you removed, so a newer Relay doesn't add them back
  worktrees: {}, // worktree path -> { root, branch, base, taskId, by?, from? } (by and from: a worktree an agent made itself)
  settings: {
    theme: 't3dark',
    fontSize: 13,
    defaultAgent: 'claude',
    permissionMode: 'default',
    worktreeByDefault: true,
    voiceLang: 'en-US',
    fancyCursor: true,
    lastProject: '',
    browserPanes: {}, // project path -> [{ id, url }]
    pages: null, // { account, repo } last published to on GitHub Pages
    agentsCanSpawn: true, // agents may start other agents (start_agent, start_task)
    agentsCanMessage: true, // agents may message each other (message_agent)
    agentsCanEditTeam: true, // agents may edit a specialist's profile when you ask (update_specialist)
    agentsAutonomous: true, // they message and copy each other without asking you each time
    agentDefaults: { claude: { model: 'sonnet', effort: '' }, lead: { model: 'opus', effort: 'high' } }, // workers on Sonnet; '' = your Claude Code's own
    // Compact a lead at compactAt % of its window (at most windowCap tokens), and replace it after replaceAfter compactions.
    leadUpkeep: { on: false, compactAt: 70, windowCap: 200_000, replaceAfter: 3 },
    scrollSpeed: 1, // terminal scrolling, times how far the trackpad moved
    sidebarHidden: false,
    openSpaces: [], // project paths open side by side in the Agents grid; the first is the current one (none = just the current one)
    agentsAware: true, // agents get a short brief of the workspace at the start, and what changed before each turn
    spacesCanAsk: true, // agents may ask another project folder a question (ask_space) and answer one
    autoUpdate: true, // the Mac app downloads new versions and installs them when you quit it (lib/update.mjs)
    artifactEditModel: 'haiku', // the model behind an artifact's "Edit with AI" chat: small page edits rarely need more
  },
};

let file;
export let db = structuredClone(DEFAULTS);

export function load(dataDir) {
  file = path.join(dataDir, 'desk.json');
  if (!fs.existsSync(file)) return;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  db = migrate({ ...structuredClone(DEFAULTS), ...saved, settings: { ...DEFAULTS.settings, ...saved.settings } });
  // Workers moved to Sonnet by default (Opus re-reading context was most of the spend). Once, for the old
  // '' default saved before that; a model you pick in Settings afterwards stays.
  // Teams saved before built-ins were tracked: the first three built-ins missing from yours, you removed.
  if (saved.specialists && !saved.removedSpecialists) db.removedSpecialists = ['christie', 'browner', 'scout'].filter(id => !saved.specialists.some(s => s.id === id));
  if (!saved.workersOnSonnet && db.settings.agentDefaults?.claude?.model === '') db.settings.agentDefaults.claude.model = 'sonnet';
}

// Settings saved by an older version, renamed or reshaped. Exported for check.mjs.
export function migrate(data) {
  const { settings } = data;
  // "Departments" became "spaces": if you turned asking off, it stays off.
  if ('departmentsCanAsk' in settings) {
    settings.spacesCanAsk = settings.departmentsCanAsk !== false;
    delete settings.departmentsCanAsk;
  }
  // "Every folder in one grid" became a list of the spaces open side by side: on means all of them.
  if ('mixFolders' in settings) {
    if (settings.mixFolders === true && !settings.openSpaces?.length) settings.openSpaces = [settings.lastProject, ...data.projects.map(p => p.path)];
    delete settings.mixFolders;
  }
  // The accent colour went away with the T3 look. Whoever still had the old default theme moves to the new one.
  if ('accent' in settings) {
    if (settings.theme === 'midnight') settings.theme = 't3dark';
    delete settings.accent;
  }
  pruneSpaces(data);
  return data;
}

// Only folders still in the list stay open in the Agents grid, each once.
export function pruneSpaces(data) {
  data.settings.openSpaces = [...new Set(data.settings.openSpaces)].filter(p => data.projects.some(x => x.path === p));
}

// Save, then tell every open page what changed.
export function changed(kind) {
  if (kind !== 'sessions' && file) {
    // Write a temp file and rename it, so a crash mid-write can't wipe the data.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(db, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }
  bus.emit('event', { type: kind });
}
