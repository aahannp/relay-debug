// What Claude Code spent, per local day: every reply in ~/.claude/projects (subagents too), priced at API list
// prices. Read-only, and incremental like transcriptContext(): a rescan reads only the bytes added since the last.
// Claude Code deletes old transcripts, so finished days are also kept in desk.json (usageDays).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, changed } from './store.mjs';
import { transcriptTitle } from './transcripts.mjs';

// $ per million tokens: input, 5m cache write, 1h cache write, cache read, output.
// From platform.claude.com/docs/en/about-claude/pricing on 2026-10-17. Matched by substring of message.model.
const PRICES = [
  ['opus-5-5', [4, 5, 8, 0.20, 20]],
  ['sonnet-5-5', [2, 2.5, 4, 0.10, 10]],
  ['haiku-5-5', [0.10, 0.125, 0.20, 0.01, 0.50], [0.50, 0.625, 1, 0.05, 2.50]], // prompts up to 100K, and above
  ['fable-5-2', [8, 10, 16, 0.20, 40]], // the claude-api skill's models.md (2026-11-03); `fable` in the CLI is this one
  ['fable-5-1', [10, 12.5, 20, 0.25, 50]],
];
const TYPES = ['input', 'write5m', 'write1h', 'read', 'output'];

// One reply's tokens by type, and its cost in $ (null: a model with no price in the table).
export function priceReply(model, usage) {
  const u = usage || {};
  const written = u.cache_creation_input_tokens || 0;
  const write1h = Math.min(written, u.cache_creation?.ephemeral_1h_input_tokens || 0);
  const tokens = { input: u.input_tokens || 0, write5m: written - write1h, write1h, read: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
  const row = PRICES.find(([name]) => String(model).includes(name));
  if (!row) return { tokens, cost: null, parts: null };
  const prompt = tokens.input + written + tokens.read;
  const rates = prompt > 100_000 && row[2] ? row[2] : row[1];
  const parts = Object.fromEntries(TYPES.map((t, i) => [t, tokens[t] * rates[i] / 1e6]));
  return { tokens, cost: TYPES.reduce((sum, t) => sum + parts[t], 0), parts };
}

const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => localDay(new Date());

const files = new Map(); // transcript -> { offset, born }
const replies = new Map(); // message id -> { file, session, cwd, day, hour, model, usage, sidechain }
const touched = new Set(); // days a reply was read for since the last save

// Read what each transcript gained since last time. One API response is written as several lines (one per
// content block) sharing message.id, and a resumed or cloned session copies lines into another file, so
// replies are keyed by message.id across all files; the line with the most output is the finished one.
async function readNew(file, f) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < f.offset) f.offset = 0; // rewritten
    while (f.offset < size) {
      const length = Math.min(size - f.offset, 8 * 1024 * 1024);
      const { buffer } = await handle.read(Buffer.alloc(length), 0, length, f.offset);
      const whole = buffer.lastIndexOf(10) + 1; // a line still being written waits for next time
      if (!whole) break; // ponytail: a single line over 8 MB is never read; none are anywhere near that
      for (const line of buffer.subarray(0, whole).toString('utf8').split('\n')) {
        if (!line.includes('"usage"')) continue; // cheap skip: only assistant replies carry usage
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const m = entry.message;
        if (entry.type !== 'assistant' || !m?.usage || !entry.timestamp || m.model === '<synthetic>') continue;
        const key = m.id || entry.requestId || entry.uuid;
        const known = replies.get(key);
        if (known && (known.usage.output_tokens || 0) > (m.usage.output_tokens || 0)) continue;
        if (known && known.file !== file) { known.usage = m.usage; touched.add(known.day); continue; } // a copy: keep it on the session that made it
        const at = new Date(entry.timestamp);
        touched.add(localDay(at));
        replies.set(key, {
          file, session: entry.sessionId || path.basename(file, '.jsonl'), cwd: entry.cwd || '', day: localDay(at), hour: at.getHours(),
          model: m.model || 'unknown', usage: m.usage, sidechain: Boolean(entry.isSidechain),
        });
      }
      f.offset += whole;
      await new Promise(resolve => setImmediate(resolve)); // let requests and terminals through between chunks
    }
  } finally {
    await handle.close();
  }
}

let scanning = null;
// Read what's new (about 0.1 s once the first full scan is done); callers during a scan share it.
export function scan() {
  if (scanning) return scanning;
  scanning = (async () => {
    let names = [];
    try { names = await fs.promises.readdir(projectsDir(), { recursive: true }); } catch {}
    const found = [];
    for (const name of names.filter(n => n.endsWith('.jsonl'))) {
      const file = path.join(projectsDir(), name);
      if (!files.has(file)) {
        const stat = await fs.promises.stat(file).catch(() => null);
        if (stat) files.set(file, { offset: 0, born: stat.birthtimeMs });
      }
      if (files.has(file)) found.push(file);
    }
    // Oldest files first, so a reply copied into a clone counts toward the session that made it.
    found.sort((a, b) => files.get(a).born - files.get(b).born);
    for (const file of found) await readNew(file, files.get(file)).catch(() => {}); // unreadable or gone: skip
    keepFinishedDays();
  })().finally(() => { scanning = null; });
  return scanning;
}

const add = (into, key, cost, tokens, extra) => {
  const row = into[key] ??= { cost: 0, tokens: 0, replies: 0, ...extra };
  row.cost += cost;
  row.tokens += tokens;
  row.replies++;
  return row;
};
const sorted = obj => Object.entries(obj).map(([name, row]) => ({ name, ...row })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

// Everything about one day, from the transcripts on disk now.
function liveDay(day) {
  const out = { day, cost: 0, replies: 0, unpriced: 0, byType: Object.fromEntries(TYPES.map(t => [t, { cost: 0, tokens: 0 }])),
    hours: Array.from({ length: 24 }, () => 0), models: {}, projects: {}, sessions: {} };
  for (const r of replies.values()) {
    if (r.day !== day) continue;
    const { tokens, cost, parts } = priceReply(r.model, r.usage);
    const total = TYPES.reduce((sum, t) => sum + tokens[t], 0);
    const spent = cost ?? 0;
    out.cost += spent;
    out.replies++;
    if (cost === null) out.unpriced++;
    for (const t of TYPES) {
      out.byType[t].tokens += tokens[t];
      out.byType[t].cost += parts?.[t] ?? 0;
    }
    out.hours[r.hour] += spent;
    add(out.models, r.model, spent, total, { priced: cost !== null });
    add(out.projects, r.cwd, spent, total);
    const s = add(out.sessions, r.session, spent, total, { file: null, cwd: r.cwd, subagents: 0 });
    if (r.sidechain) s.subagents++;
    else s.file ??= r.file;
  }
  const chats = new Map(db.chats.filter(c => c.claudeSessionId).map(c => [c.claudeSessionId, c]));
  return {
    ...out, models: sorted(out.models), projects: sorted(out.projects),
    sessions: sorted(out.sessions).map(({ name, file, ...s }) => {
      const chat = chats.get(name);
      return { id: name, ...s, title: (file && transcriptTitle(file)) || chat?.title || null, agent: chat?.name ?? null, deskProject: chat?.project ?? null };
    }),
  };
}

// A finished day is saved once its transcripts are read, and only ever replaced by a bigger total: when Claude
// Code deletes some of its transcripts, the saved numbers stay. Today is never saved: it isn't over yet.
// ponytail: a whole day's breakdown per day in desk.json (a few KB each); trim sessions if it ever grows too big
function keepFinishedDays() {
  db.usageDays ??= {};
  let saved = false;
  for (const day of touched) {
    if (day >= today()) continue;
    touched.delete(day);
    const live = liveDay(day);
    if (live.cost <= (db.usageDays[day]?.cost ?? -1) + 1e-9) continue;
    db.usageDays[day] = live;
    saved = true;
  }
  if (saved) changed('usage');
}

// The breakdown for a day: live from the transcripts, or what was saved if that was more (transcripts deleted since).
export function usageDay(day) {
  const live = liveDay(day);
  const kept = db.usageDays?.[day];
  return kept && kept.cost > live.cost + 1e-9 ? { ...kept, saved: true } : live;
}

// Every day there is anything for, newest first, with its total.
export function usageDays() {
  const totals = new Map(Object.entries(db.usageDays ?? {}).map(([day, d]) => [day, { cost: d.cost, replies: d.replies }]));
  const live = new Map();
  for (const r of replies.values()) {
    const d = live.get(r.day) ?? live.set(r.day, { cost: 0, replies: 0 }).get(r.day);
    d.cost += priceReply(r.model, r.usage).cost ?? 0;
    d.replies++;
  }
  for (const [day, d] of live) if (!totals.has(day) || d.cost > totals.get(day).cost) totals.set(day, d);
  return [...totals].map(([day, d]) => ({ day, ...d })).sort((a, b) => b.day.localeCompare(a.day));
}
