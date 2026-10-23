// Reads Claude Code's own saved conversations (~/.claude/projects/<folder>/<session id>.jsonl), read-only,
// so Relay can show a chat's title and know whether `claude --resume` will find it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { priceReply } from './usage.mjs';

const HEAD_BYTES = 1024 * 1024; // titles and the first message sit near the start of the file
const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const folderName = dir => dir.replace(/[^a-zA-Z0-9]/g, '-'); // how Claude Code names a project's folder

const found = new Map(); // session id -> transcript file
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Listing chats only looks in the folder Claude names after the chat's directory (two stats). `scan` also
// looks in every project folder, because Claude shortens very long folder names; opening a chat uses it.
// ponytail: a chat in a very long path shows its pane name, not Claude's title, until it is opened once
export function transcriptFile(sessionId, cwd, { scan = false } = {}) {
  if (!UUID.test(String(sessionId))) return null; // it becomes part of a path
  const known = found.get(sessionId);
  if (known && fs.existsSync(known)) return known;
  const real = (() => { try { return fs.realpathSync(cwd); } catch { return cwd; } })();
  const direct = [cwd, real].map(dir => path.join(projectsDir(), folderName(dir), `${sessionId}.jsonl`));
  const everywhere = () => {
    try { return fs.readdirSync(projectsDir()).map(d => path.join(projectsDir(), d, `${sessionId}.jsonl`)); } catch { return []; }
  };
  const file = direct.find(f => fs.existsSync(f)) ?? (scan ? everywhere().find(f => fs.existsSync(f)) : null) ?? null;
  if (file) found.set(sessionId, file);
  return file;
}

// What you typed, minus the wrappers Claude Code adds around commands and reminders.
export const WRAPPER = /^\s*(<|Caveat:)/;
const typedText = content => {
  const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text) : [];
  return blocks.find(t => t && !WRAPPER.test(t)) ?? null;
};

const titles = new Map(); // file -> { mtime, title }
export function transcriptTitle(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const cached = titles.get(file);
  if (cached?.mtime === stat.mtimeMs) return cached.title;
  const buffer = Buffer.alloc(Math.min(stat.size, HEAD_BYTES));
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, 0);
  } catch {
    return null; // unreadable: show the chat's own name instead
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let named = null;
  let first = null;
  for (const line of buffer.toString('utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    named = entry.customTitle || entry.aiTitle || (entry.type === 'summary' && entry.summary) || named;
    if (!first && entry.type === 'user' && !entry.isSidechain) first = typedText(entry.message?.content);
  }
  const title = (named || first || '').replace(/\s+/g, ' ').trim().slice(0, 90) || null;
  titles.set(file, { mtime: stat.mtimeMs, title, first });
  return title;
}

// What a conversation is about and where it got to: the first thing typed and Claude's latest words (its last
// reply's text, read from the file's last 256KB), so other agents' briefs can say both. Cached by mtime.
const TAIL_BYTES = 256 * 1024;
const gists = new Map(); // file -> { mtime, first, last }
export function transcriptGist(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const cached = gists.get(file);
  if (cached?.mtime === stat.mtimeMs) return cached;
  transcriptTitle(file);
  const first = titles.get(file)?.first ?? null;
  let last = null;
  let fd;
  try {
    const length = Math.min(stat.size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.includes('"assistant"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // the first line may be cut in half
      if (entry.type !== 'assistant' || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
      const text = entry.message.content.filter(b => b?.type === 'text' && b.text?.trim()).map(b => b.text).join(' ');
      if (text) last = text;
    }
  } catch {} finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const gist = { mtime: stat.mtimeMs, first, last };
  gists.set(file, gist);
  return gist;
}

// What a tool call did in a few words: the command, the file or the search, not just the tool's name.
const toolLine = ({ name, input = {} }) => {
  const what = input.command || input.file_path || input.pattern || input.url || input.description;
  return what ? `(${name === 'Bash' ? 'ran' : name.toLowerCase()}: ${String(what).replace(/\s+/g, ' ').slice(0, 200)})` : `(used ${name})`;
};
// Of a tool's output only the pull request links it printed (what `gh pr create` ends with) are kept.
const prLinks = content => {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(c => c?.text ?? '').join('\n') : '';
  const urls = [...new Set(text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? [])];
  return urls.length ? [`(result: ${urls.join(' ')})`] : [];
};

// The end of a conversation, as said: what the user typed, what Claude answered, and which tools it used,
// so another agent can catch up on it. Reads only the last few MB, and keeps it to about 30,000 characters.
export function transcriptMessages(file, last = 30) {
  let text = '';
  let fd;
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, size - length);
    text = buffer.toString('utf8');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const said = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue; // the first line may be cut in half
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.isSidechain || entry.isMeta || !['user', 'assistant'].includes(entry.type)) continue;
    const content = entry.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const parts = blocks.flatMap(b => b?.type === 'text' && b.text && !WRAPPER.test(b.text) ? [b.text.trim()]
      : b?.type === 'tool_use' ? [toolLine(b)]
      : b?.type === 'tool_result' ? prLinks(b.content) : []);
    if (parts.length) said.push({ from: entry.type === 'user' && !blocks.some(b => b?.type === 'tool_result') ? 'user' : 'agent', text: parts.join('\n').slice(0, 2000) });
  }
  const out = [];
  let total = 0;
  for (const m of said.slice(-last).reverse()) {
    if ((total += m.text.length) > 30_000) break;
    out.unshift(m);
  }
  return out;
}

// How full a conversation's context is, how often it was compacted and its latest summary, for lead upkeep,
// and what its replies cost so far, for the pane meter.
// Claude Code writes a "compact_boundary" entry for /compact and for its own auto-compaction (with the size
// after it, postTokens), then the summary as a user entry marked isCompactSummary. The context in use is the
// last reply's input, cached or not. Read on from where it left off, so a long transcript is parsed only once.
// One API response is written as several lines in a row sharing message.id; the one with the most output counts.
// ponytail: the first read takes the whole file in one buffer; stream it if transcripts grow past ~100 MB
const contexts = new Map(); // file -> { offset, used, compactions, summary, cost, tokens, unpriced, lastId, last }
const tally = (c, reply, sign) => {
  const t = reply.tokens;
  for (const [k, n] of [['input', t.input], ['output', t.output], ['read', t.read], ['write', t.write5m + t.write1h]]) c.tokens[k] += sign * n;
  if (reply.cost === null) c.unpriced += sign;
  else c.cost += sign * reply.cost;
};
export function transcriptContext(file) {
  let c = contexts.get(file);
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (!c || size < c.offset) { // new, or rewritten
      c = { offset: 0, used: 0, compactions: 0, summary: '', cost: 0, tokens: { input: 0, output: 0, read: 0, write: 0 }, unpriced: 0, lastId: null, last: null };
    }
    if (size > c.offset) {
      const buffer = Buffer.alloc(size - c.offset);
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buffer, 0, buffer.length, c.offset);
      const whole = buffer.lastIndexOf(10) + 1; // a line still being written waits for next time
      for (const line of buffer.subarray(0, whole).toString('utf8').split('\n')) {
        if (!line.startsWith('{')) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.isSidechain) continue;
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          c.compactions++;
          c.used = Number(entry.compactMetadata?.postTokens) || 0;
        } else if (entry.type === 'user' && entry.isCompactSummary) {
          const content = entry.message?.content;
          c.summary = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
        } else if (entry.type === 'assistant' && entry.message?.usage) {
          const u = entry.message.usage;
          const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (used) c.used = used; // a reply Claude Code made up itself (an error, say) has no usage
          const m = entry.message;
          if (m.model === '<synthetic>') continue;
          const reply = priceReply(m.model, u);
          if (m.id && m.id === c.lastId) {
            if (reply.tokens.output < c.last.tokens.output) continue;
            tally(c, c.last, -1);
          }
          tally(c, reply, 1);
          Object.assign(c, { lastId: m.id, last: reply });
        }
      }
      c.offset += whole;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  contexts.set(file, c);
  return { used: c.used, compactions: c.compactions, summary: c.summary, cost: c.cost, tokens: { ...c.tokens }, unpriced: c.unpriced };
}

// A Claude pane's chat view: the conversation as items to render, read from byte `after` on. Starts over (reset)
// from the file's last 2 MB on the first read, when the file shrank, or when the page fell more than 2 MB behind.
// Every item's key is "<entry uuid>:<block index>", so the page can skip ones it already has.
// ponytail: no "load earlier" past the last 2 MB; add ?before= when someone asks
const CHAT_BYTES = 2 * 1024 * 1024;
const CAP = 4000;
const blockText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
const imageCount = content => Array.isArray(content) ? content.filter(b => b?.type === 'image').length : 0;
const toolLabel = ({ name = '', input = {} }, cwd) => {
  const rel = p => {
    const r = cwd ? path.relative(cwd, String(p)) : '';
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : String(p);
  };
  const mcp = name.split('__');
  if (mcp[0] === 'mcp' && mcp.length >= 3) return `${mcp[1]}: ${mcp.slice(2).join('__')}`;
  switch (name) {
    case 'Bash': return `Ran \`${String(input.command ?? '').trim().split('\n')[0].slice(0, 80)}\``;
    case 'Read': return `Read ${rel(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Edited ${rel(input.file_path)}`;
    case 'NotebookEdit': return `Edited ${rel(input.notebook_path ?? input.file_path)}`;
    case 'Write': return `Wrote ${rel(input.file_path)}`;
    case 'Grep': return `Searched for \`${input.pattern}\``;
    case 'Glob': return `Listed \`${input.pattern}\``;
    case 'WebFetch': return `Fetched ${input.url}`;
    case 'WebSearch': return `Searched the web for "${input.query}"`;
    case 'Task': case 'Agent': return `Agent: ${input.description ?? ''}`;
    case 'TodoWrite': return 'Updated the to-do list';
    default: return `Used ${name}`;
  }
};
const toolDetail = ({ name, input = {} }) => String(name === 'Bash' ? input.command
  : name === 'Edit' ? `- ${input.old_string}\n+ ${input.new_string}`
  : name === 'Write' ? input.content
  : JSON.stringify(input, null, 2)).slice(0, CAP);

const chatItems = (entry, cwd) => {
  const content = entry.message?.content;
  const key = i => `${entry.uuid}:${i}`;
  if (entry.type === 'user' && entry.isCompactSummary) return [{ kind: 'compact', key: key(0), text: blockText(content) }];
  if (entry.isSidechain || entry.isMeta || !['user', 'assistant'].includes(entry.type)) return [];
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  if (entry.type === 'assistant') {
    return blocks.flatMap((b, i) => {
      if (b?.type === 'text' && b.text?.trim()) return [{ kind: entry.isApiErrorMessage ? 'note' : 'text', key: key(i), text: b.text }];
      if (b?.type === 'thinking' && b.thinking?.trim()) return [{ kind: 'thinking', key: key(i), text: b.thinking }];
      if (b?.type === 'tool_use') return [{ kind: 'tool', key: key(i), id: b.id, name: b.name, label: toolLabel(b, cwd), detail: toolDetail(b) }];
      return [];
    });
  }
  const items = [];
  const typed = [];
  let first = -1;
  blocks.forEach((b, i) => {
    if (b?.type === 'tool_result') {
      items.push({ kind: 'result', key: key(i), id: b.tool_use_id, error: Boolean(b.is_error), text: blockText(b.content).slice(0, CAP), images: imageCount(b.content) });
    } else if (b?.type === 'text' && typeof b.text === 'string') {
      const command = b.text.match(/<command-name>([^<]*)<\/command-name>/);
      if (command) items.push({ kind: 'command', key: key(i), text: `${command[1]} ${b.text.match(/<command-args>([^<]*)<\/command-args>/)?.[1] ?? ''}`.trim() });
      else if (b.text.startsWith('[Request interrupted by user')) items.push({ kind: 'note', key: key(i), text: 'Interrupted' });
      else if (b.text.trim() && !WRAPPER.test(b.text)) {
        typed.push(b.text);
        if (first < 0) first = i;
      }
    } else if (b?.type === 'image' && first < 0) first = i;
  });
  const images = imageCount(content);
  if (typed.length || images) items.push({ kind: 'user', key: key(Math.max(first, 0)), text: typed.join('\n'), images });
  return items;
};

export function transcriptChat(file, after, cwd) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    const reset = !(after > 0 && after <= size && size - after <= CHAT_BYTES);
    const from = reset ? Math.max(0, size - CHAT_BYTES) : after;
    const buffer = Buffer.alloc(size - from);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, from);
    const cut = from > 0 && reset ? buffer.indexOf(10) : -1; // a read from the middle drops its partial first line
    const start = from > 0 && reset ? (cut < 0 ? buffer.length : cut + 1) : 0;
    const end = Math.max(start, buffer.lastIndexOf(10) + 1); // a line still being written waits for next time
    const items = [];
    for (const line of buffer.subarray(start, end).toString('utf8').split('\n')) {
      if (!line.startsWith('{') || !/"type":"(user|assistant)"/.test(line)) continue; // skips the big blobs unparsed
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      items.push(...chatItems(entry, cwd));
    }
    return { size: from + end, reset, items };
  } catch {
    return { size: 0, reset: true, items: [] };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
