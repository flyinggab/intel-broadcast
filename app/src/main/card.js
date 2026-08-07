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
          // The hold-to-tick target writes this. Read-only here.
          done: block.complete ? present(get(row, block.complete)) : false,
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

module.exports = { resolveCard, BLOCK_TYPES, WIDTHS, EMPHASES, STYLES, get, present };
