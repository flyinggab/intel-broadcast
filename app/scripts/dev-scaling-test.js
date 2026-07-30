'use strict';

// Unit test for scaling.js — pure math, no Electron needed. Covers the
// display classes that matter: the 1080p design baseline (must be
// pixel-identical to the pre-scaling app), 4K at 100% OS scaling (the "text
// is tiny" case this exists for), 4K at 150% (Electron already scales DIPs —
// our extra factor must stay modest), a pathologically narrow display, and
// the config uiScale override.
//
// Usage: node scripts/dev-scaling-test.js

const assert = require('assert');
const { computeUiScale, computeViewerBounds, computeSettingsBounds } = require('../src/main/scaling');

// --- 1080p work area: everything identical to the legacy fixed sizes -------
assert.deepStrictEqual(computeSettingsBounds({ width: 1920, height: 1040 }), {
  width: 480,
  height: 760,
  zoom: 1,
});
let v = computeViewerBounds({ width: 1920, height: 1040 });
assert.strictEqual(v.height, 884, '85% of a 1040 work area');
assert.strictEqual(v.width, 625);
assert.ok(v.height <= 1040, 'viewer must FIT a 1080p work area (the old fixed 1202px did not)');
assert.strictEqual(v.zoom, 0.75, 'zoom floor kicks in just below 884/1202');
console.log('[test] 1080p baseline OK');

// --- 4K at 100% OS scaling (DIP work area ~3840x2100): scale everything up -
const s4k = computeSettingsBounds({ width: 3840, height: 2100 });
assert.deepStrictEqual({ width: s4k.width, height: s4k.height }, { width: 969, height: 1535 });
assert.ok(Math.abs(s4k.zoom - 2100 / 1040) < 1e-9);
v = computeViewerBounds({ width: 3840, height: 2100 });
assert.strictEqual(v.height, 1785);
assert.strictEqual(v.width, 1262);
assert.ok(Math.abs(v.width * Math.SQRT2 - v.height) <= 2, 'A4 portrait ratio held');
assert.ok(Math.abs(v.zoom - 1785 / 1202) < 1e-9, 'overlay text zoomed up ~1.49x');
console.log('[test] 4K @ 100% OK');

// --- 4K at 150% OS scaling (DIP work area ~2560x1400): only a modest extra -
const s4k150 = computeSettingsBounds({ width: 2560, height: 1400 });
assert.ok(s4k150.zoom > 1.3 && s4k150.zoom < 1.4);
v = computeViewerBounds({ width: 2560, height: 1400 });
assert.strictEqual(v.height, 1190);
assert.ok(Math.abs(v.zoom - 1190 / 1202) < 1e-9, 'near-1 zoom — OS scaling already did the work');
console.log('[test] 4K @ 150% OK');

// --- Narrow display: width cap wins, window still fits ----------------------
v = computeViewerBounds({ width: 500, height: 1200 });
assert.ok(v.width <= 500, `width ${v.width} must fit a 500-wide work area`);
assert.ok(Math.abs(v.width * Math.SQRT2 - v.height) <= 2, 'A4 ratio held under the width cap');
console.log('[test] narrow display OK');

// --- uiScale config override wins over auto-detection -----------------------
assert.strictEqual(computeUiScale(2100, 1.25), 1.25);
assert.strictEqual(computeUiScale(1040, 99), 4, 'override clamped to sane max');
assert.strictEqual(computeViewerBounds({ width: 1920, height: 1040 }, 2).zoom, 2);
assert.strictEqual(computeSettingsBounds({ width: 3840, height: 2100 }, 1).zoom, 1);
console.log('[test] uiScale override OK');

// --- auto-detection clamps --------------------------------------------------
assert.strictEqual(computeUiScale(400), 1, 'never shrinks the settings UI below design size');
assert.strictEqual(computeUiScale(99999), 3, 'auto scale capped');
console.log('[test] clamps OK');

console.log('[dev-scaling-test] PASS');
