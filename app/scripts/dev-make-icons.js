'use strict';

// Renders branding/*.svg into every icon asset the app ships, then packs
// them into build/icon.icns and build/icon.ico.
//
// Why a script and not "drop a 1024 PNG in build/": electron-builder would
// happily generate both containers from one master, but every small size
// would then be a downscale of the large artwork — and the kneeboard page
// turns into a featureless white rectangle at 16px. .icns and .ico are
// containers of INDEPENDENT bitmaps, so this script feeds the small sizes
// from branding/icon-small.svg instead.
//
// Rendering goes through Electron (already a devDependency) via a canvas
// drawImage, NOT capturePage: capturePage depends on the GPU compositor
// and has been unreliable in this project's sandboxes. Canvas is
// deterministic and keeps the alpha channel.
//
// The OUTPUTS ARE COMMITTED. iconutil is macOS-only, so CI never runs this
// — it just consumes what is in build/. Re-run it after editing any SVG:
//
//   node scripts/dev-make-icons.js
//
// Usage: node scripts/dev-make-icons.js

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const BRANDING = path.join(APP_DIR, 'branding');
const BUILD = path.join(APP_DIR, 'build');
const RENDERER_IMG = path.join(APP_DIR, 'src', 'renderer', 'img');

// Which master feeds which size. The crossover is 48: above it the full
// artwork still reads, at and below it the small variant wins.
const MASTER = 'icon.svg';
const SMALL = 'icon-small.svg';
const sourceFor = (size) => (size >= 64 ? MASTER : SMALL);

// .icns wants the Apple set; .ico tops out at 256.
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ALL_SIZES = [...new Set([...ICNS_SIZES, ...ICO_SIZES])].sort((a, b) => a - b);

const OUT = path.join(os.tmpdir(), 'taclink-icons');

// --- render -----------------------------------------------------------------

/** Runs an Electron child that rasterises every (svg, size) pair we need. */
function renderAll() {
  const jobs = [];
  for (const size of ALL_SIZES) jobs.push({ svg: sourceFor(size), size, out: path.join(OUT, `app-${size}.png`) });
  for (const size of [16, 32]) {
    jobs.push({ svg: 'tray-template.svg', size, out: path.join(OUT, `tray-${size}.png`) });
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const harness = path.join(__dirname, 'fixtures', 'icon-render-harness.js');
  const electron = path.join(APP_DIR, 'node_modules', '.bin', 'electron');

  return new Promise((resolve, reject) => {
    const child = spawn(electron, [harness, '--no-sandbox', JSON.stringify({ jobs, branding: BRANDING })], {
      cwd: APP_DIR,
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', () => {});
    child.on('exit', (code) => {
      if (code !== 0 || !/ICONS_OK/.test(out)) return reject(new Error('render harness failed'));
      resolve(jobs);
    });
  });
}

// --- .ico -------------------------------------------------------------------

/**
 * Minimal ICO writer. An .ico is just a 6-byte header, a 16-byte directory
 * entry per image, then the payloads — and since Vista those payloads may
 * be PNG as-is. That is the whole format, so no image library is needed.
 */
function writeIco(pngPaths, outPath) {
  const images = pngPaths.map(({ size, file }) => ({ size, data: fs.readFileSync(file) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    // 256 is encoded as 0 — the field is one byte.
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    entries.push(e);
  }

  fs.writeFileSync(outPath, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
}

// --- .icns ------------------------------------------------------------------

function writeIcns(outPath) {
  // iconutil wants an .iconset directory with Apple's exact filenames.
  const iconset = path.join(OUT, 'icon.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  const pairs = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of pairs) {
    fs.copyFileSync(path.join(OUT, `app-${size}.png`), path.join(iconset, name));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outPath]);
}

// --- main -------------------------------------------------------------------

async function main() {
  if (process.platform !== 'darwin') {
    console.error('[icons] iconutil is macOS-only — run this on a Mac. The outputs are committed.');
    process.exit(1);
  }

  console.log('[icons] rendering SVG masters through Electron…');
  await renderAll();

  fs.mkdirSync(BUILD, { recursive: true });

  // Windows
  writeIco(
    ICO_SIZES.map((size) => ({ size, file: path.join(OUT, `app-${size}.png`) })),
    path.join(BUILD, 'icon.ico'),
  );
  console.log(`[icons] build/icon.ico        ${ICO_SIZES.join(', ')}`);

  // macOS
  writeIcns(path.join(BUILD, 'icon.icns'));
  console.log('[icons] build/icon.icns       16…1024');

  // electron-builder also likes a plain PNG master; Linux uses it directly.
  fs.copyFileSync(path.join(OUT, 'app-512.png'), path.join(BUILD, 'icon.png'));
  console.log('[icons] build/icon.png        512');

  // Runtime assets that ship INSIDE the bundle (tray, window, favicon).
  fs.mkdirSync(RENDERER_IMG, { recursive: true });
  fs.copyFileSync(path.join(OUT, 'tray-16.png'), path.join(RENDERER_IMG, 'trayTemplate.png'));
  fs.copyFileSync(path.join(OUT, 'tray-32.png'), path.join(RENDERER_IMG, 'trayTemplate@2x.png'));
  fs.copyFileSync(path.join(OUT, 'app-256.png'), path.join(RENDERER_IMG, 'icon.png'));
  fs.copyFileSync(path.join(OUT, 'app-32.png'), path.join(RENDERER_IMG, 'favicon.png'));
  console.log('[icons] src/renderer/img/     trayTemplate.png, trayTemplate@2x.png, icon.png, favicon.png');

  console.log('\n[dev-make-icons] DONE');
}

main().catch((err) => {
  console.error(`[icons] FAIL: ${err.message}`);
  process.exit(1);
});
