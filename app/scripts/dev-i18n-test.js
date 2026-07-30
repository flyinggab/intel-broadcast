'use strict';

// Unit test for i18n.js — the EN/IT string tables both renderers and the
// main process translate through.
//
// The contract that matters most is PARITY: every key exists in both
// locales, non-empty, with the same placeholders. A key added to English
// and forgotten in Italian would otherwise fall back silently and ship a
// half-translated UI.
//
// Usage: node scripts/dev-i18n-test.js

const assert = require('assert');
const I18n = require('../src/renderer/i18n');

const { DICTS, t, photos, setLocale, locale } = I18n;
const locales = Object.keys(DICTS);
assert.deepStrictEqual(locales.sort(), ['en', 'it'], 'exactly the two shipped locales');

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`[i18n] FAIL — ${msg}`);
};

// --- parity ------------------------------------------------------------------
const enKeys = Object.keys(DICTS.en).sort();
const itKeys = Object.keys(DICTS.it).sort();
for (const k of enKeys) if (!itKeys.includes(k)) fail(`key "${k}" missing in it`);
for (const k of itKeys) if (!enKeys.includes(k)) fail(`key "${k}" missing in en`);
console.log(`[test] parity: ${enKeys.length} en keys, ${itKeys.length} it keys`);

// --- no empty strings --------------------------------------------------------
for (const l of locales) {
  for (const [k, v] of Object.entries(DICTS[l])) {
    if (typeof v !== 'string' || v.length === 0) fail(`${l}:"${k}" is empty`);
  }
}
console.log('[test] no empty strings');

// --- same placeholders both sides -------------------------------------------
const placeholders = (s) => (s.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
for (const k of enKeys) {
  if (!DICTS.it[k]) continue;
  if (placeholders(DICTS.en[k]) !== placeholders(DICTS.it[k])) {
    fail(`"${k}" placeholders differ: en(${placeholders(DICTS.en[k])}) vs it(${placeholders(DICTS.it[k])})`);
  }
}
console.log('[test] placeholder parity');

// --- t() behaviour -----------------------------------------------------------
setLocale('en');
assert.strictEqual(t('strip.host', { n: 4 }), 'HOST · 4 ON NET');
assert.strictEqual(t('no.such.key'), 'no.such.key', 'missing key renders as the key — the canary');
assert.strictEqual(photos(1), '1 PHOTO');
assert.strictEqual(photos(3), '3 PHOTOS');

setLocale('it');
assert.strictEqual(locale(), 'it');
assert.strictEqual(t('strip.host', { n: 4 }), 'HOST · 4 IN RETE');
assert.strictEqual(photos(1), '1 FOTO');
assert.strictEqual(photos(3), '3 FOTO', 'Italian FOTO is invariable');
assert.strictEqual(t('banner.newFrom', { who: 'JOKER 2-1' }), 'NUOVO DA JOKER 2-1');

setLocale('xx');
assert.strictEqual(locale(), 'en', 'unknown locale falls back to en');
console.log('[test] t(), photos(), fallback');

// --- every viewer/settings data-i18n key exists ------------------------------
// Static markup references keys by name; a typo there renders as the key.
const fs = require('fs');
const path = require('path');
for (const file of ['viewer.html', 'settings.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', file), 'utf8');
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) {
    if (!DICTS.en[m[1]]) fail(`${file} references unknown key "${m[1]}"`);
  }
}
console.log('[test] all data-i18n keys in the markup exist');

if (failures) {
  console.error(`\n[dev-i18n-test] FAIL — ${failures} problem(s)`);
  process.exit(1);
}
console.log('\n[dev-i18n-test] PASS');
