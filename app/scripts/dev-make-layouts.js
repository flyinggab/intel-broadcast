'use strict';

// Bakes the kneeboard layout templates from YAML into the JSON the app ships.
//
//   node scripts/dev-make-layouts.js
//
// Commit what this writes, the same way the icons are committed: the YAML in
// `design/kneeboard/` stays the authoring format — it is the one with the
// comments explaining every binding rule — and `app/resources/layouts/` is the
// generated artifact.
//
// WHY NOT PARSE YAML AT RUNTIME. Templates are ours and ship with the app;
// cards are not, and will one day arrive over the relay from another pilot.
// Keeping the app's only parser `JSON.parse` means there is no YAML parser
// anywhere near untrusted input, and no runtime dependency for a file that
// changes when we change it. js-yaml stays a devDependency.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DESIGN_DIR = path.join(__dirname, '..', '..', 'design', 'kneeboard');
const OUT_DIR = path.join(__dirname, '..', 'resources', 'layouts');

fs.mkdirSync(OUT_DIR, { recursive: true });

const sources = fs.readdirSync(DESIGN_DIR).filter((f) => f.endsWith('.layout.yaml'));
if (!sources.length) {
  console.error(`[layouts] no *.layout.yaml in ${DESIGN_DIR}`);
  process.exit(1);
}

for (const file of sources) {
  const parsed = yaml.load(fs.readFileSync(path.join(DESIGN_DIR, file), 'utf8'));
  const out = path.join(OUT_DIR, file.replace(/\.yaml$/, '.json'));
  fs.writeFileSync(out, `${JSON.stringify(parsed, null, 2)}\n`);
  const pages = (parsed.pages || []).map((p) => p.id).join(', ');
  console.log(`[layouts] ${file} -> ${path.relative(process.cwd(), out)}  (${parsed.id}: ${pages})`);
}
