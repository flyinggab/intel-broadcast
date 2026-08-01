#!/usr/bin/env node
// Checks every {path} in a layout template resolves against a card JSON.
// Plain node, no deps beyond a YAML parse — matches the repo's test style.
//   node design/kneeboard/verify-bindings.js
//
// This is the seed of the import-time validator described in HANDOFF §3.
// The part it does NOT yet do is measure string widths against columns.
const fs = require('fs'), path = require('path');
const dir = __dirname;

// Minimal YAML subset reader would be fragile; require js-yaml if present,
// otherwise skip with a clear message rather than pretend to pass.
let yaml;
try { yaml = require('js-yaml'); }
catch { console.log('SKIP: npm i -D js-yaml to run this check'); process.exit(0); }

const tpl = yaml.load(fs.readFileSync(path.join(dir, 'strike-package.layout.yaml'), 'utf8'));
const card = JSON.parse(fs.readFileSync(path.join(dir, 'foxhunt2-roman1.card.json'), 'utf8'));

const get = (o, p) => p.split('.').reduce((c, k) => (c && k in c ? c[k] : undefined), o);
const TOK = /\{([\w.]+)(?:\|(\w+))?\}/g;
const bad = [];
let n = 0;

function resolve(str, scope, where) {
  String(str).replace(TOK, (_, p, filt) => {
    const v = get(scope, p) ?? get(card, p);
    if (v === undefined) { if (!filt) bad.push(`${where}: {${p}}`); }
    else n++;
    return '';
  });
}

for (const req of tpl.requires || [])
  if (get(card, req) === undefined) bad.push(`requires '${req}' missing`);

for (const page of tpl.pages) {
  if (page.when && !get(card, page.when)) continue;
  for (const b of page.blocks) {
    const where = `${page.id}/${b.type}`;
    if (b.when && !get(card, b.when)) continue;
    if (b.title) resolve(b.title, card, `${where}.title`);
    if (b.repeat) {
      const arr = get(card, b.repeat);
      if (!Array.isArray(arr)) { bad.push(`${where}: repeat '${b.repeat}' not an array`); continue; }
      const spec = b.row || b.cell;
      arr.forEach((item, i) => {
        if (spec) for (const [k, v] of Object.entries(spec)) resolve(v, item, `${where}[${i}].${k}`);
        for (const c of b.columns || []) resolve(c.value, item, `${where}[${i}]`);
      });
    } else {
      const scope = b.bind ? get(card, b.bind) : card;
      for (const it of b.items || []) resolve(it.value, scope || {}, where);
      for (const [k, v] of Object.entries(b))
        if (typeof v === 'string' && v.includes('{')) resolve(v, scope || {}, `${where}.${k}`);
    }
  }
}

console.log(`resolved ${n} placeholders`);
if (bad.length) { console.error('UNRESOLVED:'); bad.forEach(b => console.error('  ' + b)); process.exit(1); }
console.log('OK — every binding resolves');
