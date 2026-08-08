'use strict';

const fs = require('fs');
const path = require('path');

const { validateLayout, describeLayout } = require('./card');

// Templates a pilot imported are COPIED here, not referenced. Same reasoning
// as the blob store: if the app needs it to render, the app holds it. A
// template linked from Downloads is a card that stops working the week the
// pilot tidies up, and it would fail at the worst possible moment — opening
// the kneeboard, in the air, having changed nothing.
const USER_DIR_NAME = 'templates';

// Names live BESIDE the templates rather than inside them. Two reasons: the
// copy stays byte-identical to the file that was imported, and a SHIPPED
// template can be renamed too — a squad that calls the strike card something
// else should not have to fork the app to say so.
const NAMES_FILE = 'names.json';

const SUFFIX = '.layout.json';

/**
 * The library: templates that ship with the app, plus the ones a pilot has
 * imported. Pure Node but for the two directories it is handed — dev
 * tests drive it with temporary ones.
 */
function createTemplateStore({ shippedDir, userDataDir }) {
  const userDir = path.join(userDataDir, USER_DIR_NAME);
  const namesPath = path.join(userDir, NAMES_FILE);

  function readNames() {
    try {
      const parsed = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {}; // absent or corrupt — a lost nickname is not worth a failure
    }
  }

  function writeNames(names) {
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(namesPath, JSON.stringify(names, null, 2));
  }

  /** Reads one directory's templates. A file that will not parse is SKIPPED,
   *  not thrown: one bad template must not empty the whole library. */
  function readDir(dir, source, out, bad) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      return; // no user directory yet is the normal first-run state
    }
    for (const file of files.filter((f) => f.endsWith(SUFFIX))) {
      const full = path.join(dir, file);
      try {
        const layout = JSON.parse(fs.readFileSync(full, 'utf8'));
        const check = validateLayout(layout);
        if (!check.ok) {
          bad.push({ file, source, errors: check.errors });
          continue;
        }
        out.set(layout.id, { ...describeLayout(layout), source, path: full });
      } catch (err) {
        bad.push({ file, source, errors: [err.message] });
      }
    }
  }

  /**
   * Every template, shipped first.
   *
   * Shipped wins on an id collision. It has to: a card names a template by id
   * on the wire, so if a pilot could shadow `strike-package` with their own,
   * every card their squad sent would render against a different sheet — and
   * nothing would look wrong, which is the worst kind of wrong.
   */
  function list() {
    const byId = new Map();
    const bad = [];
    readDir(userDir, 'user', byId, bad);
    readDir(shippedDir, 'shipped', byId, bad); // second, so it overwrites
    const names = readNames();
    const all = [...byId.values()].map((t) => ({ ...t, name: names[t.id] || t.name }));
    all.sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'shipped' ? -1 : 1));
    return { templates: all, bad };
  }

  function entry(id) {
    return list().templates.find((t) => t.id === id) || null;
  }

  /** The layout itself, for resolving a card against. */
  function get(id) {
    const found = entry(id);
    if (!found) return null;
    try {
      return JSON.parse(fs.readFileSync(found.path, 'utf8'));
    } catch {
      return null;
    }
  }

  function has(id) {
    return Boolean(entry(id));
  }

  /**
   * Reads a file a pilot picked and says whether it is a template — WITHOUT
   * saving it. The naming step sits between the two, and a template that is
   * saved before it is named is one that appears in the library under whatever
   * the file happened to call it if the pilot changes their mind.
   */
  function inspect(filePath) {
    let layout;
    try {
      layout = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      return { ok: false, errors: [`not readable JSON: ${err.message}`] };
    }
    const check = validateLayout(layout);
    if (!check.ok) return { ok: false, errors: check.errors };

    const clash = entry(layout.id);
    if (clash && clash.source === 'shipped') {
      return { ok: false, errors: [`"${layout.id}" already ships with Tac Link`] };
    }
    return { ok: true, errors: [], layout, describe: describeLayout(layout), replaces: Boolean(clash) };
  }

  /** Saves an inspected layout under a pilot's chosen name. */
  function save(layout, name) {
    const check = validateLayout(layout);
    if (!check.ok) return { ok: false, errors: check.errors };
    const clash = entry(layout.id);
    if (clash && clash.source === 'shipped') {
      return { ok: false, errors: [`"${layout.id}" already ships with Tac Link`] };
    }
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, `${layout.id}${SUFFIX}`), JSON.stringify(layout, null, 2));
    const chosen = typeof name === 'string' ? name.trim() : '';
    if (chosen) {
      const names = readNames();
      names[layout.id] = chosen.slice(0, 60);
      writeNames(names);
    }
    return { ok: true, errors: [], id: layout.id };
  }

  /** Removes one a pilot imported. Shipped templates are not theirs to delete. */
  function remove(id) {
    const found = entry(id);
    if (!found) return { ok: false, errors: ['no such template'] };
    if (found.source === 'shipped') return { ok: false, errors: ['that one ships with Tac Link'] };
    fs.rmSync(found.path, { force: true });
    const names = readNames();
    if (id in names) {
      delete names[id];
      writeNames(names);
    }
    return { ok: true, errors: [] };
  }

  return { list, get, has, inspect, save, remove, userDir };
}

module.exports = { createTemplateStore, USER_DIR_NAME, NAMES_FILE, SUFFIX };
