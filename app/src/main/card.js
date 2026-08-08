'use strict';

// Kneeboard cards: validate a card against its layout, and resolve the two
// into a render model. See design/kneeboard/HANDOFF.md.
//
// THE SPLIT THIS FILE EXISTS TO ENFORCE. A `*.layout.yaml` is SHAPE — no
// mission data, no colours, no px, no fonts. A `*.card.json` is CONTENT — no
// appearance. Neither can express the other, and the EFB owns how any of it
// looks. Phase 4 renders the same model into a VR quad, where an author's
// pixel choices would be meaningless.
//
// A CARD IS UNTRUSTED. Today it is a file a pilot picked; once cards travel
// the relay it is a file another pilot sent. So:
//   - everything is resolved HERE, in main, into plain strings. The renderer
//     receives a finished model and writes textContent — it never sees a
//     binding, a path, or anything it has to interpret.
//   - blocks come from a CLOSED SET. An unknown type is an import failure, not
//     something to render generically; that is the mechanism by which a card
//     cannot introduce a new kind of thing on a pilot's knee.
//   - images are content-addressed hashes only, never URLs, so a card cannot
//     phone out.
//   - validation runs before render and REJECTS. A half-rendered card is worse
//     than a refused one: it looks like the mission.
//
// Pure Node, no Electron — dev-card-test drives it directly.

// The closed set. Adding one is a code change, deliberately.
const BLOCK_TYPES = new Set(['fields', 'stations', 'steps', 'table', 'prose', 'image']);

// Semantic vocabulary a template may use. Anything else is a template bug, and
// a template that could say "red" is a template that can break the cockpit.
const WIDTHS = new Set(['badge', 'xs', 'sm', 'md', 'flex']);
const EMPHASES = new Set(['threat', 'strong', 'muted']);
const STYLES = new Set(['mono']);

// `{path}` or `{path|filter}`. Braces mean RENDER; bare paths in `when`,
// `repeat`, `bind`, `mark` and `complete` are tests and sources. That
// inconsistency is deliberate and has already prevented one real bug — see
// the handoff's binding rules.
const TOKEN = /\{([\w.]+)(?:\|(\w+))?\}/g;

// `dash` and `blank` render a mark or nothing. `none` is different in kind: it
// is the literal enum value for "no state", used by `{state|none}` and
// `{kind|none}`, so every row reaches the renderer with a state string rather
// than an absent one. The handoff documents the first two; the shipped
// template uses all three.
const FILTERS = {
  dash: '—',
  blank: '',
  none: 'none',
};

// Bare hex, or the self-describing `sha256:` form. Nothing else: an image
// source is a content hash, so a card cannot phone out. See resolveBlock.
const SHA256 = /^(?:sha256:)?([a-f0-9]{64})$/;

/** Walks a dotted path. Returns undefined rather than throwing on any gap. */
function get(obj, dottedPath) {
  if (!dottedPath) return undefined;
  return String(dottedPath)
    .split('.')
    .reduce((cur, key) => (cur && typeof cur === 'object' && key in cur ? cur[key] : undefined), obj);
}

/** A path is "present" for `when`/`mark` if it is truthy and not an empty array. */
function present(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

/**
 * Renders one template string against a scope, falling back to the card.
 *
 * Row scope first so `"{name}"` inside a `repeat` means the row's name, with
 * the card as the outer scope so a row can still reach `{flight.callsign}`.
 * A missing path with no filter is an ERROR, not an empty string: a blank
 * where a frequency should be is indistinguishable from a frequency of blank.
 */
function renderString(template, scope, card, where, errors) {
  let out = '';
  let last = 0;
  const text = String(template);
  TOKEN.lastIndex = 0;
  let match = TOKEN.exec(text);
  while (match) {
    out += text.slice(last, match.index);
    const [full, dottedPath, filter] = match;
    let value = get(scope, dottedPath);
    if (value === undefined) value = get(card, dottedPath);

    if (value === undefined) {
      if (filter && filter in FILTERS) out += FILTERS[filter];
      else if (filter) errors.push(`${where}: unknown filter "${filter}" in ${full}`);
      else errors.push(`${where}: {${dottedPath}} does not resolve, and has no fallback`);
    } else if (value === null || typeof value === 'object') {
      errors.push(`${where}: {${dottedPath}} is ${value === null ? 'null' : 'not a value'}`);
    } else {
      out += String(value);
    }
    last = match.index + full.length;
    match = TOKEN.exec(text);
  }
  return out + text.slice(last);
}

/** Validates the semantic vocabulary on one column/item spec. */
function checkVocabulary(spec, where, errors) {
  if (spec.width && !WIDTHS.has(spec.width)) errors.push(`${where}: unknown width "${spec.width}"`);
  if (spec.emphasis && !EMPHASES.has(spec.emphasis)) errors.push(`${where}: unknown emphasis "${spec.emphasis}"`);
  if (spec.style && !STYLES.has(spec.style)) errors.push(`${where}: unknown style "${spec.style}"`);
  // The one rule that keeps appearance out of templates entirely.
  for (const banned of ['color', 'colour', 'font', 'size', 'px', 'weight']) {
    if (banned in spec) errors.push(`${where}: a template may not say "${banned}" — style belongs to the EFB`);
  }
}

/** The rows a `repeat` produces, or null with an error logged. */
function repeatRows(block, card, where, errors) {
  const rows = get(card, block.repeat);
  if (!Array.isArray(rows)) {
    errors.push(`${where}: repeat "${block.repeat}" is not an array`);
    return null;
  }
  return rows;
}

function resolveBlock(block, card, where, errors) {
  switch (block.type) {
    case 'fields': {
      const items = (block.items || []).map((item, i) => {
        checkVocabulary(item, `${where}.items[${i}]`, errors);
        return {
          label: item.label ? renderString(item.label, card, card, `${where}.items[${i}].label`, errors) : '',
          value: renderString(item.value, card, card, `${where}.items[${i}].value`, errors),
          width: item.width || 'flex',
          style: item.style || null,
          emphasis: item.emphasis || null,
        };
      });
      return { type: 'fields', band: block.band || null, title: '', items };
    }

    case 'stations': {
      const rows = repeatRows(block, card, where, errors);
      if (!rows) return null;
      const spec = block.cell || {};
      return {
        type: 'stations',
        band: block.band || null,
        title: block.title ? renderString(block.title, card, card, `${where}.title`, errors) : '',
        wrap: Number.isInteger(block.wrap) ? block.wrap : rows.length,
        cells: rows.map((row, i) => ({
          value: spec.value ? renderString(spec.value, row, card, `${where}[${i}].value`, errors) : '',
          label: spec.label ? renderString(spec.label, row, card, `${where}[${i}].label`, errors) : '',
          state: spec.state ? renderString(spec.state, row, card, `${where}[${i}].state`, errors) : '',
        })),
      };
    }

    case 'steps': {
      const rows = repeatRows(block, card, where, errors);
      if (!rows) return null;
      const spec = block.row || {};
      return {
        type: 'steps',
        title: block.title ? renderString(block.title, card, card, `${where}.title`, errors) : '',
        subtitle: block.subtitle ? renderString(block.subtitle, card, card, `${where}.subtitle`, errors) : '',
        rows: rows.map((row, i) => ({
          name: spec.name ? renderString(spec.name, row, card, `${where}[${i}].name`, errors) : '',
          ref: spec.ref ? renderString(spec.ref, row, card, `${where}[${i}].ref`, errors) : '',
          gate: spec.gate ? renderString(spec.gate, row, card, `${where}[${i}].gate`, errors) : '',
          note: spec.note ? renderString(spec.note, row, card, `${where}[${i}].note`, errors) : '',
          state: spec.state ? renderString(spec.state, row, card, `${where}[${i}].state`, errors) : '',
          // WHETHER A STEP IS FLOWN LIVES IN EXACTLY ONE FIELD, and this is it.
          //
          // A card can say so two ways — a `complete` flag, or a state of
          // "done" — and both are folded in here rather than left for the
          // renderer to OR together. When it did OR them, a step the card
          // called done could never be UNticked: the pilot's tick writes
          // `done`, but `state` still read "done" and won, so the first three
          // legs of the example card looked simply unclickable.
          //
          // `state` keeps only what it alone can say: which step is CURRENT.
          done:
            (block.complete ? present(get(row, block.complete)) : false) ||
            (spec.state ? renderString(spec.state, row, card, `${where}[${i}].state`, errors) === 'done' : false),
        })),
      };
    }

    case 'table': {
      const rows = repeatRows(block, card, where, errors);
      if (!rows) return null;
      (block.columns || []).forEach((col, i) => checkVocabulary(col, `${where}.columns[${i}]`, errors));
      return {
        type: 'table',
        band: block.band || null,
        column: block.column || null,
        title: block.title ? renderString(block.title, card, card, `${where}.title`, errors) : '',
        rows: rows.map((row, i) => ({
          // `mark` is a per-row boolean path — the template does not know
          // which row is the next tanker, only that the card flags one.
          marked: block.mark ? present(get(row, block.mark)) : false,
          cells: (block.columns || []).map((col) => ({
            value: renderString(col.value, row, card, `${where}[${i}]`, errors),
            width: col.width || 'flex',
            style: col.style || null,
            emphasis: col.emphasis || null,
          })),
        })),
      };
    }

    case 'prose': {
      const scope = block.bind ? get(card, block.bind) : card;
      if (block.bind && (!scope || typeof scope !== 'object')) {
        errors.push(`${where}: bind "${block.bind}" is not an object`);
        return null;
      }
      const listPath = block.list;
      const list = listPath ? get(scope, listPath) : null;
      if (listPath && !Array.isArray(list)) {
        errors.push(`${where}: list "${listPath}" is not an array`);
        return null;
      }
      return {
        type: 'prose',
        title: block.title ? renderString(block.title, scope, card, `${where}.title`, errors) : '',
        badge: block.badge ? renderString(block.badge, scope, card, `${where}.badge`, errors) : '',
        items: (list || []).map((entry, i) => {
          if (typeof entry === 'object' && entry !== null) {
            errors.push(`${where}.list[${i}]: prose items must be strings`);
            return '';
          }
          return String(entry);
        }),
      };
    }

    case 'image': {
      const scope = block.bind ? get(card, block.bind) : card;
      if (!scope || typeof scope !== 'object') {
        errors.push(`${where}: bind "${block.bind}" is not an object`);
        return null;
      }
      const source = renderString(block.source, scope, card, `${where}.source`, errors);
      // Content-addressed or nothing. A URL here is how a card would phone
      // home, and it is refused rather than sanitised.
      const hash = SHA256.exec(source);
      if (!hash) {
        errors.push(`${where}: image source must be a sha256 content hash, got "${source.slice(0, 40)}"`);
        return null;
      }
      return {
        type: 'image',
        blob: hash[1],
        caption: block.caption ? renderString(block.caption, scope, card, `${where}.caption`, errors) : '',
      };
    }

    default:
      errors.push(`${where}: unknown block type "${block.type}"`);
      return null;
  }
}

/**
 * Validates and resolves one card against one layout.
 *
 * Returns `{ ok, errors, card }`. `ok` is false if ANYTHING failed — there is
 * no partial render, because a card missing its tanker row still looks like
 * the mission.
 */

// ---------------------------------------------------------------------------
// Height budget
//
// The sheet is a fixed 893 x 1263 and there is nowhere for a block to go if it
// does not fit: anything past the bottom edge is simply unreachable in flight,
// with no scrollbar and no second page. So a card that is too long is REFUSED
// at import, the same as one with a broken binding — the pilot finds out on
// the ground, with a message saying which block pushed it over.
//
// NOT YET WIRED INTO THE REFUSAL, deliberately. The constants below are
// measured, but the model they feed comes out ~132px light against what the
// browser actually renders — consistently, on both the design card and the
// full one, so something structural is missing rather than a row height being
// off. A refusal built on a model that is wrong in the safe direction passes
// cards that then render off the bottom of the sheet, which is exactly the
// failure it exists to prevent. dev-card-geometry-test measures the real
// overflow in the meantime and fails on it.
//
// To finish: print pageHeight()'s per-block breakdown beside the harness's
// measured per-block heights (it already reports them) and find the 132px.
// ---------------------------------------------------------------------------

const SHEET_BODY_PX = 1227; // 1263 sheet less 18px padding top and bottom
const BLOCK_GAP_PX = 6;
const HEIGHTS = {
  head: 22, // a section's dark title band
  step: 33, // a route row — taller than a table row, it carries the tick lane
  row: 31, // a table row (targets, comms)
  band: 47, // the header band, one line of label over value
  stations: 63, // the loadout strip
  proseLine: 19,
  prosePad: 12,
};

/** Predicted rendered height of one block, in sheet pixels. */
function blockHeight(block) {
  switch (block.type) {
    case 'fields':
      return HEIGHTS.band;
    case 'stations':
      return HEIGHTS.stations;
    case 'steps':
      return HEIGHTS.head + (block.rows || []).length * HEIGHTS.step;
    case 'table':
      return HEIGHTS.head + (block.rows || []).length * HEIGHTS.row;
    case 'prose':
      return HEIGHTS.head + (block.lines || []).length * HEIGHTS.proseLine + HEIGHTS.prosePad;
    case 'image':
      return 0; // the map is its own page and sizes to what is left
    default:
      return 0;
  }
}

/**
 * Predicted height of a page, and the per-block breakdown behind it.
 *
 * Comms blocks sit side by side in one grid row, so they cost the height of
 * the TALLEST of them once, not the sum — getting that wrong would refuse
 * perfectly good cards.
 */
function pageHeight(page) {
  const blocks = (page.blocks || []).filter((b) => b.type !== 'image');
  const banded = new Map();
  const plain = [];
  for (const block of blocks) {
    if (block.band) banded.set(block.band, Math.max(banded.get(block.band) || 0, blockHeight(block)));
    else plain.push({ block, h: blockHeight(block) });
  }
  const parts = [
    ...plain.map((p) => ({ title: p.block.title || p.block.type, h: p.h })),
    ...[...banded].map(([band, h]) => ({ title: band, h })),
  ];
  const total = parts.reduce((sum, p) => sum + p.h, 0) + Math.max(0, parts.length - 1) * BLOCK_GAP_PX;
  return { total, parts };
}

function resolveCard({ layout, card }) {
  const errors = [];

  if (!layout || typeof layout !== 'object') return { ok: false, errors: ['no layout'], card: null };
  if (!card || typeof card !== 'object') return { ok: false, errors: ['no card'], card: null };
  if (layout.schema !== 1) errors.push(`layout schema ${layout.schema} is not supported`);
  if (card.schema !== 1) errors.push(`card schema ${card.schema} is not supported`);
  if (card.layout !== layout.id) errors.push(`card asks for layout "${card.layout}", got "${layout.id}"`);

  // `requires` is the loud, early failure the handoff asks for: a card that
  // has no comms is refused at import, not discovered in the air.
  for (const required of layout.requires || []) {
    if (get(card, required) === undefined) errors.push(`card is missing "${required}", which this layout requires`);
  }

  const pages = [];
  for (const page of layout.pages || []) {
    if (page.when && !present(get(card, page.when))) continue;
    const blocks = [];
    for (const [i, block] of (page.blocks || []).entries()) {
      const where = `${page.id}/${block.type || `block[${i}]`}`;
      if (!BLOCK_TYPES.has(block.type)) {
        errors.push(`${where}: unknown block type "${block.type}"`);
        continue;
      }
      if (block.when && !present(get(card, block.when))) continue;
      const resolved = resolveBlock(block, card, where, errors);
      if (resolved) blocks.push(resolved);
    }
    pages.push({ id: page.id, label: page.label || page.id, layout: page.layout || 'single', blocks });
  }

  return {
    ok: errors.length === 0,
    errors,
    card: {
      id: card.id || card.layout,
      title: typeof card.title === 'string' ? card.title : '',
      subtitle: typeof card.subtitle === 'string' ? card.subtitle : '',
      pages,
    },
  };
}

// ---------------------------------------------------------------------------
// Templates as things in their own right: validating one, and looking at one
// before you have any data for it.
// ---------------------------------------------------------------------------

/** An id becomes a FILENAME, so it may not contain a path. */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Sets `path` on `obj` without clobbering anything already there. */
function plant(obj, dottedPath, value) {
  const keys = String(dottedPath).split('.');
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (!cur[key] || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  const last = keys[keys.length - 1];
  if (cur[last] === undefined) cur[last] = value;
  return cur[last];
}

/**
 * Builds a card that satisfies a layout and says nothing.
 *
 * This is how a template is shown before it has data. The alternative was a
 * "blank mode" threaded through the resolver, which would have meant every
 * rendering rule existing twice — and the second copy is the one that rots.
 * Instead the skeleton goes through the SAME resolveCard as a real card, so a
 * preview cannot drift from the thing it is previewing.
 *
 * One row per repeated block, not zero: a table's columns are the most useful
 * thing about it when you are deciding whether a template is the one you want,
 * and an empty block shows none of them.
 */
function blankCardFor(layout) {
  const card = { schema: 1, layout: layout.id };

  for (const page of layout.pages || []) {
    // A page gated on data stays OFF. The map page is the case that matters:
    // an image block needs a real content hash, and inventing one would put a
    // broken picture in front of a pilot deciding what template to use.
    if (page.when) continue;
    for (const block of page.blocks || []) {
      if (block.type === 'image') continue;
      if (block.when) plant(card, block.when, ['—']);
      if (block.repeat) plant(card, block.repeat, [{}]);
      const scope = block.bind ? plant(card, block.bind, {}) : card;
      if (block.list && typeof scope === 'object') {
        if (scope[block.list] === undefined) scope[block.list] = ['—'];
      }
      // Every `{token}` the block can render, planted as a dash. Row-scoped
      // tokens fall back to the card, so planting at the top answers them too.
      for (const spec of [block.items, block.columns, [block.cell], [block.row], [block]].filter(Boolean)) {
        for (const one of spec) {
          for (const text of Object.values(one || {})) {
            if (typeof text !== 'string') continue;
            TOKEN.lastIndex = 0;
            let m = TOKEN.exec(text);
            while (m) {
              if (!m[2]) plant(card, m[1], '—'); // a filter already has its own answer
              m = TOKEN.exec(text);
            }
          }
        }
      }
    }
  }

  // Whatever `requires` names, so the layout's own gate passes.
  for (const required of layout.requires || []) plant(card, required, '—');
  return card;
}

/**
 * Is this file a card template at all?
 *
 * Called on IMPORT, where the file came from another pilot and the only thing
 * between it and a kneeboard is this saying no. The last check is the one that
 * matters most: a template that cannot render its own empty sheet is broken,
 * whatever its structure looks like, and finding that out at import beats
 * finding it out in the air.
 */
function validateLayout(layout) {
  const errors = [];
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    return { ok: false, errors: ['not a JSON object'] };
  }
  if (layout.schema !== 1) errors.push(`schema ${JSON.stringify(layout.schema)} is not supported`);
  if (typeof layout.id !== 'string' || !layout.id) errors.push('no "id"');
  else if (!SAFE_ID.test(layout.id)) errors.push(`"id" must be a plain name, got ${JSON.stringify(layout.id)}`);
  if (layout.name !== undefined && typeof layout.name !== 'string') errors.push('"name" must be text');
  if (!Array.isArray(layout.pages) || !layout.pages.length) errors.push('no "pages"');

  for (const [p, page] of (Array.isArray(layout.pages) ? layout.pages : []).entries()) {
    const where = `pages[${p}]`;
    if (typeof page !== 'object' || page === null) {
      errors.push(`${where}: not an object`);
      continue;
    }
    if (typeof page.id !== 'string' || !page.id) errors.push(`${where}: no "id"`);
    if (!Array.isArray(page.blocks)) errors.push(`${where}: no "blocks"`);
    for (const [b, block] of (Array.isArray(page.blocks) ? page.blocks : []).entries()) {
      const at = `${page.id || where}/block[${b}]`;
      if (!block || typeof block !== 'object') {
        errors.push(`${at}: not an object`);
        continue;
      }
      if (!BLOCK_TYPES.has(block.type)) errors.push(`${at}: unknown block type ${JSON.stringify(block.type)}`);
      for (const spec of [block.items, block.columns, [block.cell], [block.row]].filter(Boolean)) {
        for (const [i, one] of spec.entries()) if (one) checkVocabulary(one, `${at}[${i}]`, errors);
      }
    }
  }

  if (errors.length) return { ok: false, errors };

  // The proof: render it empty. Anything the structural pass cannot see — a
  // binding with no fallback, a filter that does not exist — surfaces here.
  const preview = resolveCard({ layout, card: blankCardFor(layout) });
  if (!preview.ok) return { ok: false, errors: preview.errors };
  return { ok: true, errors: [] };
}

/** What the library shows about a template without opening it again. */
function describeLayout(layout) {
  const pages = (layout.pages || []).map((p) => p.id);
  const blocks = (layout.pages || []).reduce((n, p) => n + (p.blocks || []).length, 0);
  return {
    id: layout.id,
    name: typeof layout.name === 'string' && layout.name ? layout.name : layout.id,
    pages,
    blocks,
    requires: Array.isArray(layout.requires) ? layout.requires.slice() : [],
  };
}

/**
 * Marks WHERE THE FLIGHT IS: the first step not yet flown.
 *
 * Derived, never declared. A card may say `state: "current"` on a row, but a
 * fixed marker is only true at the moment the card was written — the pilot
 * ticks off DEPART and the highlight is still sitting on DEPART, pointing at
 * something already behind them. The first unflown step is the only answer
 * that stays right for the whole mission.
 *
 * It also settles the harder question for free. Ticks travel between pilots,
 * so anything derived from them travels too, and two pilots cannot end up
 * looking at different current steps while holding the same ticks. Sending
 * "current" as its own field would make that possible — one more thing on the
 * wire that can disagree with the thing it was computed from.
 *
 * Applied to the SNAPSHOT rather than at resolve time, because the ticks are
 * an override laid on afterwards and this has to see them.
 */
function markCurrentStep(model) {
  if (!model || !model.pages) return model;
  return {
    ...model,
    pages: model.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => {
        if (block.type !== 'steps') return block;
        // Every step flown means no current step — the mission is done, and
        // highlighting the last row would claim there is still one to fly.
        const at = block.rows.findIndex((row) => !row.done);
        return { ...block, rows: block.rows.map((row, i) => ({ ...row, current: i === at })) };
      }),
    })),
  };
}

module.exports = {
  resolveCard,
  markCurrentStep,
  validateLayout,
  blankCardFor,
  describeLayout,
  BLOCK_TYPES,
  WIDTHS,
  EMPHASES,
  STYLES,
  get,
  present,
  pageHeight,
  SHEET_BODY_PX,
};
