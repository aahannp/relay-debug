// The chat view's work log: one line such as "Read 3 files and ran 2 commands" for a run of tool calls. No DOM, so check.mjs can test it.
// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT, © 2026 T3 Tools Inc.):
// packages/client-runtime/src/work-log/presentation.ts (labels, the top-two rule, the join) and
// apps/web/src/components/chat/TimelineWorkGroupRows.logic.ts (the timer's format).

const BUCKETS = {
  Read: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Bash: 'command',
  Grep: 'code-search', Glob: 'code-search', WebSearch: 'web', WebFetch: 'web', Task: 'agent', Agent: 'agent',
};
// Relay's own tools that start a worker count as starting an agent; the chat links them to the thread they started.
export const startsAgent = name => /^mcp__.+__(start_agent|start_task|clone_agent)$/.test(name);
export const bucket = name => BUCKETS[name] ?? (startsAgent(name) ? 'agent' : 'other');
// start_agent and clone_agent answer with the new session ({ "id": … }), start_task with { …task, "sessionId": … }.
export const startedId = text => text.match(/"sessionId": "([^"]+)"/)?.[1] ?? text.match(/^\{\s*"id": "([^"]+)"/)?.[1] ?? null;

const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const LABELS = {
  read: c => `Read ${n(c, 'file', 'files')}`,
  edit: c => `Changed ${n(c, 'file', 'files')}`,
  command: c => `Ran ${n(c, 'command', 'commands')}`,
  'code-search': c => `Searched code ${n(c, 'time', 'times')}`,
  web: c => `Searched the web ${n(c, 'time', 'times')}`,
  agent: c => `Started ${n(c, 'agent', 'agents')}`,
  other: c => `Used ${n(c, 'tool', 'tools')}`,
};
// Changes outrank looking around, and "other" comes last, as in T3.
const PRIORITY = { command: 0, edit: 0, agent: 0, other: 2 };

// tools: [{ kind: 'tool' | 'thinking', name, label, error }] -> { label, failed }.
// Reads and edits count distinct files: the label is "Read src/a.js", so what follows its first word is the file.
export function summarize(tools) {
  const work = tools.filter(t => t.kind !== 'thinking');
  if (!work.length) return { label: tools.length > 1 ? `Thought (×${tools.length})` : 'Thought', failed: 0 };
  const groups = new Map();
  for (const t of work) {
    const b = bucket(t.name);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(t);
  }
  const top = [...groups].map(([b, list], index) => ({ b, list, index }))
    .sort((x, y) => (PRIORITY[x.b] ?? 1) - (PRIORITY[y.b] ?? 1) || x.index - y.index)
    .slice(0, 2).sort((x, y) => x.index - y.index);
  const labels = top.map(({ b, list }) => LABELS[b](b === 'read' || b === 'edit'
    ? new Set(list.map(t => t.label.replace(/^\S+\s/, ''))).size : list.length));
  const rest = work.length - top.reduce((s, { list }) => s + list.length, 0);
  if (rest > 0) labels.push(`Performed ${n(rest, 'other action', 'other actions')}`);
  const words = labels.map((l, i) => (i ? l[0].toLowerCase() + l.slice(1) : l));
  return {
    label: words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')}, and ${words.at(-1)}`,
    failed: work.filter(t => t.error).length,
  };
}

// 12000 -> '12s', 65000 -> '1m 5s', 3725000 -> '1h 2m 5s'.
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return [[Math.floor(s / 3600), 'h'], [Math.floor(s % 3600 / 60), 'm'], [s % 60, 's']].filter(([v]) => v).map(([v, u]) => v + u).join(' ');
}
