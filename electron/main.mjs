// Relay for macOS: runs the server inside the app and shows its page in one or more windows.
import { app, BrowserWindow, Menu, desktopCapturer, dialog, session, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stripDeskCookies } from '../lib/cookies.mjs';

const ROOT = path.dirname(import.meta.dirname);
let server;
let update;

// Apps opened from Finder get a bare PATH, so claude and codex in /opt/homebrew/bin would not be
// found. Ask the user's login shell for its PATH; markers skip anything their shell config prints.
function loginShellPath() {
  const mark = '__AGENT_DESK_PATH__';
  return new Promise(resolve => {
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], { timeout: 5000 }, (_err, stdout = '') => {
      resolve(stdout.match(new RegExp(`${mark}(.*?)${mark}`, 's'))?.[1] || process.env.PATH);
    });
  });
}

const openOutside = url => /^(https?|mailto):/.test(url) && shell.openExternal(url);

// The debug build (`npm run dist:debug`) is a separate app named "Relay Debug": own data folder, port and lock, and its own releases.
const DEBUG = app.getName() === 'Relay Debug';
const APP_NAME = DEBUG ? 'Relay Debug' : 'Relay';

function createWindow({ from, project } = {}) {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    ...(from && { x: from.getBounds().x + 28, y: from.getBounds().y + 28 }), // a step off the one it came from
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0b0c10', show: false, title: APP_NAME,
  });
  if (DEBUG) win.on('page-title-updated', e => e.preventDefault()); // keep "Relay Debug" in the title bar
  win.once('ready-to-show', () => win.show());
  // Links and window.open go to the default browser; only the Relay page stays in the window.
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === new URL(server.url).origin) return;
    event.preventDefault();
    openOutside(url);
  });
  const url = new URL(server.url); // the URL start() returns: it carries the login token
  if (project) url.searchParams.set('project', project);
  win.loadURL(url.href);
}

// A new window opens on the project of the window you opened it from (each page keeps it in its ?project=).
function newWindow() {
  const from = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const project = from && new URL(from.webContents.getURL()).searchParams.get('project');
  createWindow({ from, project });
}

async function boot() {
  process.env.PATH = await loginShellPath();
  // Imported only now, because the server copies process.env for its agents when it loads.
  if (DEBUG) process.env.RELAY_DEBUG = '1'; // the server reports it to the page and updates from relay-debug
  const { start } = await import('../server.mjs');
  const options = {
    dataDir: app.getPath('userData'),
    voiceHelper: app.isPackaged ? path.join(process.resourcesPath, 'desk-listen') : path.join(ROOT, 'native/build/desk-listen'),
  };
  server = await start({ ...options, port: DEBUG ? 4849 : 4848 }).catch(e => {
    if (e.code !== 'EADDRINUSE') throw e;
    return start({ ...options, port: 0 }); // the port is taken, so take any free port
  });
  update = await import('../lib/update.mjs');
  if (app.isPackaged) update.auto({ dataDir: options.dataDir, quit: () => app.quit() }); // never from `npm run app`'s Electron

  // Electron grants every page every permission unless told otherwise, and browser panes frame other
  // websites. So deny by default, and give Relay's own top-level page only what it uses.
  const ownOrigin = new URL(server.url).origin;
  const ALLOWED = new Set(['clipboard-sanitized-write', 'notifications', 'media', 'display-capture', 'fullscreen']);
  const isSameOrigin = url => { try { return new URL(url).origin === ownOrigin; } catch { return false; } };
  const isOwnPage = (url, isMainFrame) => isMainFrame && isSameOrigin(url);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(ALLOWED.has(permission) && isOwnPage(details.requestingUrl, details.isMainFrame)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin, details) =>
    ALLOWED.has(permission) && isOwnPage(details.requestingUrl || origin, details.isMainFrame !== false));

  // Cookies ignore ports, so the browser pane would hand Relay's login cookie (the full token) to any
  // localhost server it opens, such as a Docker container or a port-forward. Only Relay itself gets it.
  // (ws:// counts as http:// so the terminals' WebSocket keeps it.) One listener per session: keep it here.
  session.defaultSession.webRequest.onBeforeSendHeaders(({ url, requestHeaders }, callback) => {
    const name = Object.keys(requestHeaders).find(k => k.toLowerCase() === 'cookie');
    if (name && !isSameOrigin(url.replace(/^ws/, 'http'))) {
      const kept = stripDeskCookies(requestHeaders[name]);
      if (kept) requestHeaders[name] = kept; else delete requestHeaders[name];
    }
    callback({ requestHeaders });
  });

  // Screenshots: only Relay's own page (not a browser pane) may capture the screen. On macOS 15+ the
  // system picker appears so you choose exactly what is shared; older versions get the main screen.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const fromApp = request.frame && !request.frame.parent && new URL(request.frame.url).origin === ownOrigin;
    if (!fromApp) return callback({});
    desktopCapturer.getSources({ types: ['screen'] }).then(([screen]) => callback({ video: screen }), () => callback({}));
  }, { useSystemPicker: true });
  // Terminals and inputs need the Edit menu for copy, paste and select all to work.
  const newItem = { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: newWindow };
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { label: 'File', submenu: [newItem, { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: newWindow }]));
  createWindow();
}

// Relay was called Agent Desk: keep using its data folder (board, chats, settings, login) when one exists.
// Same userData also means the same single-instance lock, so the old app and Relay never share desk.json at once.
const oldData = path.join(app.getPath('appData'), 'Agent Desk');
// The debug app never takes it: that would share the real desk.json and the single-instance lock.
if (!DEBUG && fs.existsSync(oldData)) app.setPath('userData', oldData);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return server && createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  // Mac convention: closing the window keeps the app and its agents running; the Dock icon reopens it.
  app.on('window-all-closed', () => {});
  app.on('activate', () => server && !BrowserWindow.getAllWindows().length && createWindow());
  // A quit you chose installs a downloaded update; the new version opens next time you open Relay.
  app.on('will-quit', () => {
    server?.close();
    try {
      if (app.isPackaged) update?.installOnQuit();
    } catch (e) {
      console.error("Couldn't install the update:", e.message);
    }
  });
  app.whenReady().then(boot).catch(e => {
    dialog.showErrorBox('Relay could not start', String(e?.stack || e));
    app.quit();
  });
}
