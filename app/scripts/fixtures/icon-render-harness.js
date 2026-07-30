'use strict';

// Electron harness for dev-make-icons.js. Rasterises SVG → PNG at exact
// pixel sizes and writes the files, then prints ICONS_OK.
//
// Deliberately uses canvas drawImage rather than capturePage: capturePage
// goes through the GPU compositor, which this project has already found
// unreliable in a sandbox, and it would also bake in a background. Canvas
// keeps the alpha channel and is deterministic.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const { jobs, branding } = JSON.parse(process.argv[process.argv.length - 1]);

// Runs inside the page. Returns a base64 PNG of the SVG at `size`.
function rasterise(svgText, size) {
  return new Promise((resolve, reject) => {
    const blobUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      // The masters are square; drawing to a square canvas keeps geometry
      // exact and lets the rasteriser antialias at the target size rather
      // than downscaling a larger bitmap.
      ctx.drawImage(img, 0, 0, size, size);
      resolve(canvas.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = () => reject(new Error('SVG failed to decode'));
    img.src = blobUrl;
  });
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 64, height: 64, show: false });
  await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body></body>');

  try {
    for (const job of jobs) {
      const svgText = fs.readFileSync(path.join(branding, job.svg), 'utf8');
      const b64 = await win.webContents.executeJavaScript(
        `(${rasterise.toString()})(${JSON.stringify(svgText)}, ${job.size})`,
      );
      fs.mkdirSync(path.dirname(job.out), { recursive: true });
      fs.writeFileSync(job.out, Buffer.from(b64, 'base64'));
      console.log(`[render] ${job.svg} @ ${job.size} -> ${path.basename(job.out)}`);
    }
    console.log('ICONS_OK');
  } catch (err) {
    console.error(`[render] ${err.message}`);
    app.exit(1);
    return;
  }
  win.destroy();
  app.quit();
});
