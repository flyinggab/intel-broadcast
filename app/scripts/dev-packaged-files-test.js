'use strict';

// Everything the app READS from disk at runtime must be in `build.files`.
//
//   node scripts/dev-packaged-files-test.js
//
// This exists because the shipped card templates were never packaged. The
// glob list carried `resources/config.default.json` and nothing else under
// `resources/`, so `resources/layouts/*.layout.json` simply were not in the
// asar — and the failure was invisible from a dev run, where the files are
// right there on disk. In the installed app the template store found zero
// templates, so every card was refused with `no template named
// "strike-package"`. That shipped in v0.9.0, v0.9.1 and v0.9.2.
//
// The general rule this checks: if main resolves a path under `resources/`,
// some glob in `build.files` has to cover it. Static, fast, and it needs no
// build — a packaging bug that only shows up after `electron-builder` has run
// is one nobody runs into until a pilot does.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const globs = pkg.build.files;

/** Does any glob in `build.files` cover this repo-relative path? */
function covered(rel) {
  return globs.some((glob) => {
    if (glob === rel) return true;
    // Only the two shapes this file actually uses: `dir/**/*` and `dir/*`.
    const starstar = glob.endsWith('/**/*') && rel.startsWith(glob.slice(0, -5) + '/');
    const star = glob.endsWith('/*') && path.dirname(rel) === glob.slice(0, -2);
    return starstar || star;
  });
}

// ---------------------------------------------------------------------------
// Every file under resources/ that main reads.
// ---------------------------------------------------------------------------
{
  const missing = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(APP_DIR, full).split(path.sep).join('/');
      // config.local.json is the USER's file, written at runtime into
      // userData — it must never be packaged.
      if (rel.endsWith('config.local.json')) continue;
      if (!covered(rel)) missing.push(rel);
    }
  };
  walk(path.join(APP_DIR, 'resources'));

  assert.deepStrictEqual(
    missing,
    [],
    `these files are read at runtime but are not in build.files, so they will be absent from the ` +
      `installed app:\n  ${missing.join('\n  ')}\n` +
      `A dev run cannot see this — the files are on disk either way.`,
  );
  console.log(`[test] every resources/ file the app reads is packaged (${globs.length} globs)`);
}

// ---------------------------------------------------------------------------
// The specific one that shipped broken three times, named so a regression
// says what it broke rather than just "a file is missing".
// ---------------------------------------------------------------------------
{
  const layoutsDir = path.join(APP_DIR, 'resources', 'layouts');
  const layouts = fs.readdirSync(layoutsDir).filter((f) => f.endsWith('.layout.json'));
  assert.ok(layouts.length > 0, 'there should be at least one shipped template');
  for (const file of layouts) {
    assert.ok(
      covered(`resources/layouts/${file}`),
      `the shipped template ${file} is not packaged — the installed app will refuse every card ` +
        `that names it, with "no template named ...", and a dev run will look fine`,
    );
  }
  console.log(`[test] the ${layouts.length} shipped templates are packaged: ${layouts.join(', ')}`);
}

console.log('[dev-packaged-files-test] PASS');
