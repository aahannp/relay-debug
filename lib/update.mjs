// Updates, the same way Task Notes does them: ask GitHub for the newest release of this app, and if it's
// newer, download its .dmg into your Downloads folder for you to drag into Applications. In the Mac app with
// "Update automatically" on, it is downloaded, checked and installed when you quit Relay instead (see auto).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { bus, db, changed } from './store.mjs';

// The early-access app ("Relay Debug", RELAY_DEBUG=1) is released from its own repo under its own file name;
// everything else about updating is the same, and installing replaces the running bundle, so never the other app.
const debug = () => process.env.RELAY_DEBUG === '1';
export const channel = () => (debug()
  ? { app: 'Relay Debug', repo: 'aahannp/relay-debug', dmg: v => `Relay-Debug-${v}-arm64.dmg` }
  : { app: 'Relay', repo: 'aahannp/relay', dmg: v => `Relay-${v}-arm64.dmg` });
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(import.meta.dirname), 'package.json'), 'utf8')).version;
const API = () => process.env.AGENT_DESK_GITHUB_API || 'https://api.github.com';
const fail = (status, message) => Object.assign(new Error(message), { status });

export const current = () => VERSION;

// "v1.10.0" is newer than "1.9.2". Anything after a "-" (a pre-release tag) is ignored.
export function isNewer(tag, than) {
  const nums = v => String(v).replace(/^v/i, '').split('-')[0].split('.').map(n => Number.parseInt(n, 10) || 0);
  const [a, b] = [nums(tag), nums(than)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

// Cached for ten minutes: GitHub rate-limits callers without a login, and the answer rarely changes.
let cache = { at: 0, value: null };
export async function check(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 10 * 60_000) return { current: VERSION, ...cache.value };
  let res;
  try {
    res = await fetch(`${API()}/repos/${channel().repo}/releases/latest`, {
      signal: AbortSignal.timeout(10_000), headers: { accept: 'application/vnd.github+json', 'user-agent': `agent-desk/${VERSION}` },
    });
  } catch (e) {
    return { current: VERSION, error: `Couldn't reach GitHub (${e.cause?.code || e.message})` };
  }
  const j = await res.json().catch(() => ({}));
  if (res.status === 404) return save({ latest: null, newer: false, none: true });
  if (!res.ok) return viaReleasePage(j.message || `GitHub answered ${res.status}`);
  const dmg = (j.assets || []).find(a => /\.dmg$/i.test(a.name || ''));
  const sum = dmg && j.assets.find(a => a.name === `${dmg.name}.sha256`);
  return save({
    latest: j.tag_name, newer: isNewer(j.tag_name, VERSION), notes: String(j.body || '').slice(0, 4000), page: j.html_url, publishedAt: j.published_at,
    asset: dmg ? { name: dmg.name, url: dmg.browser_download_url, size: dmg.size, sha256: sum?.browser_download_url, digest: dmg.digest } : null,
  });
}
// Without a login GitHub allows 60 API calls an hour per address, and an office network shares one address.
// The release page's redirect isn't counted, so fall back to it: the tag and the .dmg, but no notes.
async function viaReleasePage(why) {
  const web = process.env.AGENT_DESK_GITHUB_API || 'https://github.com';
  try {
    const res = await fetch(`${web}/${channel().repo}/releases/latest`, {
      redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': `agent-desk/${VERSION}` },
    });
    const tag = res.headers.get('location')?.match(/\/releases\/tag\/([^/?#]+)$/)?.[1];
    if (!tag) return { current: VERSION, error: why };
    const name = channel().dmg(decodeURIComponent(tag).replace(/^v/i, ''));
    return save({
      latest: decodeURIComponent(tag), newer: isNewer(decodeURIComponent(tag), VERSION), notes: '', page: `${web}/${channel().repo}/releases/tag/${tag}`,
      asset: { name, url: `${web}/${channel().repo}/releases/download/${tag}/${name}`, size: 0, sha256: `${web}/${channel().repo}/releases/download/${tag}/${name}.sha256` },
    });
  } catch {
    return { current: VERSION, error: why };
  }
}
const save = value => ((cache = { at: Date.now(), value }), { current: VERSION, ...value });

// Only ever follows links to GitHub, where releases and their files live.
const fromGitHub = url => /^https:\/\/([a-z0-9-]+\.)*(github\.com|githubusercontent\.com)\//i.test(url)
  || Boolean(process.env.AGENT_DESK_GITHUB_API && url.startsWith(`${process.env.AGENT_DESK_GITHUB_API}/`));

// Fetches a release file, following redirects only while they stay on GitHub.
async function follow(url) {
  for (let hops = 0; ; hops++) {
    if (hops > 5 || !fromGitHub(url)) throw fail(502, 'The download pointed somewhere other than GitHub, so it was stopped');
    const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': `agent-desk/${VERSION}` } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).href; continue; }
    if (!res.ok) throw fail(502, `GitHub answered ${res.status}`);
    return res;
  }
}

// Saves a release file to dest (through dest.part, so a half download never looks finished), telling pages how far it got.
async function fetchTo(url, dest, size) {
  const res = await follow(url);
  const total = Number(res.headers.get('content-length')) || size || 0;
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part);
  let received = 0;
  let last = 0;
  const progress = done => bus.emit('event', { type: 'update-progress', received, total, done });
  try {
    for await (const chunk of res.body) {
      received += chunk.length;
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      if (Date.now() - last > 150) { last = Date.now(); progress(false); }
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }
  fs.renameSync(part, dest);
  progress(true);
}

let downloading = null;
let saved = null; // the last download, the only file "show in Finder" will reveal
export function download(downloads = path.join(os.homedir(), 'Downloads')) {
  downloading ??= (async () => {
    const info = await check();
    if (!info.newer || !info.asset) throw fail(409, 'There is no newer version to download');
    const name = path.basename(info.asset.name);
    const dest = path.join(downloads, name);
    await fetchTo(info.asset.url, dest, info.asset.size);
    saved = dest;
    return { path: dest, name };
  })().finally(() => { downloading = null; });
  return downloading;
}

// Shows the downloaded file in Finder.
export function reveal() {
  if (!saved) throw fail(404, 'Nothing has been downloaded yet');
  return new Promise(resolve => execFile('open', ['-R', saved], () => resolve({})));
}

// Automatic updates, in the Mac app only (an ad-hoc signed app can't use Squirrel). A newer release's .dmg is
// downloaded into <data>/update, checked against its SHA-256, and its Relay.app copied out ("staged"). It is
// installed when you quit Relay or click Restart to update, never by Relay restarting itself.
let DIR = null; // <data>/update once the Mac app calls auto(); null means manual updates only
let quitApp = null;
let installError = null; // why the last install failed, shown once
let installing = false;

export const autoOn = () => Boolean(DIR) && db.settings.autoUpdate !== false;

export function auto({ dataDir, quit }) {
  DIR = path.join(dataDir, 'update');
  quitApp = quit;
  fs.mkdirSync(DIR, { recursive: true });
  const lastError = path.join(DIR, 'last-error.txt');
  if (fs.existsSync(lastError)) {
    // Back to downloading by hand until you fix what stopped it and turn automatic updates on again.
    installError = fs.readFileSync(lastError, 'utf8').trim() || 'unknown error';
    fs.rmSync(lastError);
    db.settings.autoUpdate = false;
    changed('settings');
  }
  if (!staged()) for (const f of ['Relay.app', 'staged.json']) fs.rmSync(path.join(DIR, f), { recursive: true, force: true }); // installed, or turned off
  const tick = () => autoOn() && check().then(info => info.newer && info.asset && prepare()).catch(e => console.error("Couldn't get the update ready:", e.message));
  tick();
  setInterval(tick, 6 * 3600_000).unref();
}

// The update that's ready to install: { version, path }, or null.
export function staged() {
  if (!autoOn()) return null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DIR, 'staged.json'), 'utf8'));
    return isNewer(s.version, VERSION) && fs.existsSync(s.path) ? s : null;
  } catch {
    return null;
  }
}

export async function status(force = false) {
  const info = await check(force);
  const failed = installError;
  installError = null;
  return { ...info, app: channel().app, debug: debug(), auto: autoOn(), staged: staged()?.version ?? null, preparing: Boolean(preparing), installError: failed };
}

let preparing = null;
export function prepare() {
  preparing ??= (async () => {
    const info = await check();
    if (!info.newer || !info.asset) throw fail(409, 'There is no newer version to download');
    const version = info.latest.replace(/^v/i, '');
    if (staged()?.version === version) return staged();
    const dmg = path.join(DIR, path.basename(info.asset.name));
    try {
      await fetchTo(info.asset.url, dmg, info.asset.size);
      await verify(dmg, info.asset);
      await stage(dmg, version);
    } finally {
      fs.rmSync(dmg, { force: true });
    }
    bus.emit('event', { type: 'update-ready', version });
    return staged();
  })().finally(() => { preparing = null; });
  return preparing;
}

// The file's SHA-256 must match the release's .sha256 file ("<hex>  <name>") and GitHub's digest, when there is one.
async function verify(file, { sha256, digest }) {
  const want = [];
  if (sha256) want.push((await (await follow(sha256)).text()).trim().split(/\s+/)[0].toLowerCase());
  if (/^sha256:/i.test(digest || '')) want.push(digest.slice(7).toLowerCase());
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const got = hash.digest('hex');
  if (!want.length) throw fail(502, 'The release has no SHA-256 to check the download against, so it was not installed');
  if (want.some(w => w !== got)) throw fail(502, "The download's SHA-256 doesn't match the release's, so it was deleted");
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (err, stdout, stderr) =>
  (err ? reject(fail(502, `${cmd} failed: ${String(stderr).trim() || err.message}`)) : resolve(String(stdout).trim()))));

// Copies Relay.app out of the .dmg into <data>/update, and keeps it only if it is that version and its signature holds.
async function stage(dmg, version) {
  const app = path.join(DIR, 'Relay.app');
  const json = path.join(DIR, 'staged.json');
  for (const f of [app, json]) fs.rmSync(f, { recursive: true, force: true });
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-update-'));
  try {
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, dmg]);
    try {
      const inside = fs.readdirSync(mnt).find(n => n.endsWith('.app'));
      if (!inside) throw fail(502, 'The .dmg has no app in it');
      await run('ditto', [path.join(mnt, inside), app]);
    } finally {
      await run('hdiutil', ['detach', mnt, '-force']).catch(e => console.error(e.message));
    }
    const found = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
    if (found !== version) throw fail(502, `The .dmg holds version ${found}, not ${version}`);
    await run('codesign', ['--verify', '--deep', '--strict', app]);
    fs.writeFileSync(json, JSON.stringify({ version, path: app }));
  } catch (e) {
    fs.rmSync(app, { recursive: true, force: true });
    throw e;
  } finally {
    try { fs.rmdirSync(mnt); } catch {} // rmdir, not rm: if the detach failed, never delete through the mount
  }
}

// Waits for Relay (pid) to exit, swaps the new app into place keeping the old one as .old until it worked, and
// opens it only when asked to. Any failure puts the old app back and leaves the reason in last-error.txt.
const INSTALL = `pid=$1 app=$2 new=$3 dir=$4 relaunch=$5
moved=
fail() {
  echo "$1" > "$dir/last-error.txt"
  if [ -n "$moved" ]; then rm -rf "$app"; mv "$app.old" "$app"; fi
  exit 1
}
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$app.old"
[ -e "$app.old" ] && fail "Couldn't remove an earlier $app.old"
mv "$app" "$app.old" || fail "Couldn't move $app aside to replace it"
moved=1
mv "$new" "$app" 2>/dev/null || { rm -rf "$app"; ditto "$new" "$app"; } || fail "Couldn't copy the new version into $app"
xattr -dr com.apple.quarantine "$app" 2>/dev/null
rm -rf "$app.old" "$new" "$dir/staged.json"
if [ "$relaunch" = 1 ]; then open "$app"; fi
`;
export function install({ relaunch = false, bundle = path.resolve(process.execPath, '../../..'), dir = DIR, pid = process.pid } = {}) {
  if (!bundle.endsWith('.app')) throw fail(409, 'Only the Relay Mac app can install updates');
  const script = path.join(dir, 'install.sh');
  fs.writeFileSync(script, INSTALL);
  const child = spawn('/bin/sh', [script, String(pid), bundle, path.join(dir, 'Relay.app'), dir, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

// On a quit you chose: installs the staged update, once.
export function installOnQuit(relaunch = false) {
  if (installing || !staged()) return false;
  install({ relaunch });
  installing = true;
  return true;
}

// The Restart to update button: install, then quit; the new version opens when it's in place.
export function restart() {
  if (!quitApp) throw fail(409, 'Only the Relay Mac app can install updates');
  if (!installOnQuit(true)) throw fail(409, 'No update is ready to install');
  setTimeout(quitApp, 300); // after this answer reaches the page
  return {};
}
