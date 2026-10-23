// Renders the app icon and the DMG background from the pages in this folder (npm run build:art).
// Writes build/icon.icns, build/icon-debug.icns (Relay Debug), build/background.tiff, and the PNGs in build/art/out for review, plus the
// website's apple-touch icon (relay-180.png) and social card (relay-og.png).
import { app, BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ART = import.meta.dirname;
const BUILD = path.dirname(ART);
const OUT = path.join(ART, 'out');

async function render(page, width, height, scale = 1, hash = '', query = {}) {
  const win = new BrowserWindow({
    show: false, width, height, useContentSize: true, frame: false, transparent: true,
    webPreferences: { offscreen: { deviceScaleFactor: scale } },
  });
  await win.loadFile(path.join(ART, page), { hash, query });
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))');
  const png = (await win.capturePage()).toPNG({ scaleFactor: scale });
  await new Promise(resolve => { win.once('closed', resolve); win.close(); });
  return png;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // Every iconset size is drawn at its own pixel size; 16 and 32 point icons use simpler designs.
  for (const [name, query] of [['icon', {}], ['icon-debug', { debug: '' }]]) {
    const iconset = path.join(OUT, `${name}.iconset`);
    fs.mkdirSync(iconset, { recursive: true });
    for (const pt of [16, 32, 128, 256, 512]) {
      for (const x of [1, 2]) {
        const px = pt * x;
        const png = await render('icon.html', px, px, 1, px === 16 ? 'tiny' : pt <= 32 ? 'small' : '', query);
        fs.writeFileSync(path.join(iconset, `icon_${pt}x${pt}${x === 2 ? '@2x' : ''}.png`), png);
      }
    }
    fs.copyFileSync(path.join(iconset, 'icon_512x512@2x.png'), path.join(OUT, `${name}-1024.png`));
    fs.copyFileSync(path.join(iconset, 'icon_32x32.png'), path.join(OUT, `${name}-32.png`));
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, `${name}.icns`)]);
  }

  fs.writeFileSync(path.join(OUT, 'background.png'), await render('dmg.html', 660, 420, 1));
  fs.writeFileSync(path.join(OUT, 'background@2x.png'), await render('dmg.html', 660, 420, 2));
  execFileSync('tiffutil', ['-cathidpicheck', path.join(OUT, 'background.png'), path.join(OUT, 'background@2x.png'), '-out', path.join(BUILD, 'background.tiff')]);

  fs.writeFileSync(path.join(OUT, 'relay-180.png'), await render('icon.html', 180, 180, 1, 'touch'));
  fs.writeFileSync(path.join(OUT, 'relay-og.png'), await render('og.html', 1200, 630, 1));

  console.log(`Art written to ${path.relative(process.cwd(), BUILD)}`);
}

// No top-level await here: Electron holds the ready event until the main module has finished loading.
app.dock?.hide();
app.whenReady().then(main).then(() => app.quit(), e => { console.error(e); app.exit(1); });
