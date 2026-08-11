'use strict';

// VIEWER — the window OpenKneeboard captures.
//
// ROADMAP §5.2: this file owns NO state. It renders whatever snapshot main
// pushes and sends intents back. There is deliberately no `currentIndex` here
// — phase 4 renders this same markup offscreen into a VR quad alongside the
// desktop window, and state living in one DOM cannot be shared between two
// surfaces. The only mutable module binding is the banner timer handle.
//
// It also never writes inline styles: it toggles the classes and attributes
// in the BRIEF §4 contract, and nothing else. And it never prints a hotkey:
// a printed binding goes stale the moment the pilot records a new one —
// SETUP → KEYS is the single source.

const body = document.body;

const el = (id) => document.getElementById(id);

// --- destinations -----------------------------------------------------------
// The nav rail is generated from this. Adding a page is ONE entry here plus
// its two i18n keys — which is the whole reason the tab bar went: a bar
// divides a fixed width by N and stops working at six, a grouped grid does
// not. Every entry is a page of this window, SETUP included: the EFB carries
// its own settings, like the tablet a pilot actually flies with.
// Icons are ELEMENT LISTS, not one flattened path. Squashing them into a
// single `d` lost real artwork: SETUP's three slider knobs are filled circles
// and simply vanished, leaving three bare lines, and the arrows lost their
// round caps.
const DESTINATIONS = [
  {
    // ONE destination for all of it. RECEIVED and SHARE were never places
    // you GO — they are two directions of the same queue, what came in and
    // what goes out, and both are things you do to the brief you are already
    // looking at. They are sub-views now, picked from the strip.
    id: 'brief',
    group: 'intel',
    label: 'tab.intel',
    icon: [['rect', { x: 3, y: 2, width: 14, height: 16 }], ['path', { d: 'M6 7h8M6 11h8M6 15h5' }]],
  },
  {
    // The mission card. `mission` is a group GROUPS already declares and
    // nothing rendered into until now — see design/kneeboard/HANDOFF.md §5.
    // CARD and MAP are two entries, not a rail.
    id: 'card',
    group: 'mission',
    label: 'tab.card',
    icon: [
      ['rect', { x: 3, y: 2, width: 14, height: 16 }],
      ['path', { d: 'M6 6h8M6 9h8M6 12h8M6 15h4' }],
    ],
  },
  {
    id: 'setup',
    group: 'system',
    label: 'tab.setup',
    // A real cog, not a sun. The first attempt was a circle with radial lines,
    // which is exactly what a brightness glyph is: thin rays SEPARATE from a
    // disc. A gear's teeth are wide and part of the body, so the outline
    // alternates between an outer and an inner radius with flat tooth tops.
    // No caption: SETUP is the one destination nobody has to be told the name
    // of, and it sits apart from the flight surfaces anyway.
    icon: [
      ['path', { d: 'M8.04 1.83L11.96 1.83L11.45 3.97L13.24 4.71L14.39 2.84L17.16 5.61L15.29 6.76L16.03 8.55L18.17 8.04L18.17 11.96L16.03 11.45L15.29 13.24L17.16 14.39L14.39 17.16L13.24 15.29L11.45 16.03L11.96 18.17L8.04 18.17L8.55 16.03L6.76 15.29L5.61 17.16L2.84 14.39L4.71 13.24L3.97 11.45L1.83 11.96L1.83 8.04L3.97 8.55L4.71 6.76L2.84 5.61L5.61 2.84L6.76 4.71L8.55 3.97Z', 'stroke-linejoin': 'round' }],
      ['circle', { cx: 10, cy: 10, r: 2.8 }],
    ],
  },
];
// Group order is the order they appear; a group with no destinations is
// simply not rendered, so this list can run ahead of the pages.
const GROUPS = ['intel', 'mission', 'reference', 'tools', 'system'];

const strip = { net: el('strip-net'), relay: el('strip-relay') };
const crumb = { root: el('crumb'), page: el('crumb-page'), pos: el('crumb-pos') };
const menukey = el('menukey');
const nav = el('nav');
const abar = { root: el('abar'), views: el('abar-views'), card: el('abar-card') };
const lib = el('lib');
const banner = {
  root: el('banner'),
  who: el('banner-who'),
  meta: el('banner-meta'),
  close: el('banner-close'),
};
const stage = {
  img: el('stage-img'),
  file: el('stage-file'),
  posN: el('stage-pos-n'),
  posMeta: el('stage-pos-meta'),
  prev: el('stage-prev'),
  next: el('stage-next'),
  standby: el('stage-standby'),
  standbyLine1: el('standby-line1'),
  standbyLine2: el('standby-line2'),
  ink: el('stage-ink'),
  cast: el('brief-cast'),
};

const brief = {
  bar: el('briefbar'),
  title: el('briefbar-title'),
  meta: el('briefbar-meta'),
  key: el('briefbar-key'),
  mark: el('brief-mark'),
  markLabel: el('brief-mark-label'),
  tools: el('brief-tools'),
  undo: el('tool-undo'),
  clear: el('tool-clear'),
};
const batches = el('batches');
const autoshow = el('tg-autoshow');
const share = {
  folder: el('share-folder'),
  count: el('share-count'),
  grid: el('share-grid'),
  toggle: el('share-toggle'),
  reveal: el('share-reveal'),
};
const fixkey = el('fixkey');

const PLACEHOLDER = 'img/frame-placeholder.svg';

// The three faces of INTEL. Not destinations — RECEIVED and SHARE are what
// INTEL is SHOWING, which is why they live in the action bar with the other
// verbs rather than in the rail with the apps.
const INTEL_VIEWS = ['brief', 'received', 'share'];
// CARD's own views, same idiom: one destination on the rail, two views in the
// bar. TEMPLATES is not a place you navigate TO — it is the other half of the
// page you are already on.
const CARD_VIEWS = ['card', 'templates'];

// Every arrival banner dismisses itself. Keyed on banner.at so a later state
// push re-rendering the SAME banner cannot extend its life.
const BANNER_DISMISS_MS = 10000;
let bannerTimer = null;
let bannerShownAt = null;

// --- formatting -------------------------------------------------------------
// In viewer/format.js so plain node can require and test them; loaded by the
// <script> tag above this one.
const { zulu, megabytes } = self.Format;
// i18n.js is loaded by the <script> tag above format.js.
const { t, photos: photoWord, setLocale, applyStatic } = self.I18n;

// Callsigns and filenames are remote-supplied strings — everything user-facing
// goes in via textContent, never innerHTML.
function setText(node, text) {
  if (node) node.textContent = text;
}

// --- render -----------------------------------------------------------------

function renderStrip(s) {
  // The breadcrumb replaced the callsign here: the callsign is identity, which
  // settings owns and the squad sees, while WHERE YOU ARE is the thing the
  // strip has to answer now that there is no tab bar to answer it.
  // The strip says WHERE YOU ARE and nothing else now: its verbs moved to the
  // action bar. That is what let the page name come back — as three word keys
  // in here they cost 37px in Italian and pushed the strip past the window,
  // and the name was what got dropped to pay for them.
  const dest =
    DESTINATIONS.find((d) => d.id === s.page) || (INTEL_VIEWS.includes(s.page) ? DESTINATIONS[0] : null);
  setText(crumb.page, dest ? t(dest.label) : '');
  // Position is only meaningful where there is a queue to be positioned in.
  const q = s.queue;
  setText(crumb.pos, s.page === 'brief' && q.current ? `${q.pos + 1} / ${q.total}` : '');

  setText(
    strip.net,
    s.isHost ? t('strip.host', { n: s.peers.length }) : s.connected ? t('strip.joined') : t('strip.nonet'),
  );
  setText(strip.relay, s.connected ? t('strip.online', { t: zulu(s.lastContactAt) }) : t('strip.offline'));
  strip.relay.classList.toggle('strip__seg--fault', !s.connected);
  // Offline needs somewhere to GO, not a paragraph about it. The key appears
  // beside the word and leads to the one page that can do anything.
  fixkey.classList.toggle('is-hidden', Boolean(s.connected));
  fixkey.setAttribute('aria-label', t('net.fix'));
  fixkey.title = t('net.fix');
}

/**
 * The navigation rail. Rebuilt only when the destination set or the active
 * page changes — it is on screen permanently now, so rebuilding it on every
 * 3-second state push would fight the pilot's own scroll and hover.
 */
let renderedNav = '';
function renderNav(s) {
  nav.classList.toggle('is-collapsed', Boolean(s.navCollapsed));
  menukey.classList.toggle('is-active', !s.navCollapsed);
  menukey.setAttribute('aria-expanded', s.navCollapsed ? 'false' : 'true');
  menukey.setAttribute('aria-label', t('nav.toggle'));
  menukey.title = t('nav.toggle');

  const unseen = s.unseen || {};
  // The marks are part of what the rail LOOKS like, so they belong in the
  // signature. Left out, the rail would keep whichever marks it was built
  // with and a card arriving would light nothing until the page changed.
  const signature = `${s.page}|${s.locale}|${unseen.brief ? 1 : 0}${unseen.card ? 1 : 0}`;
  if (signature === renderedNav) return;
  renderedNav = signature;

  nav.textContent = '';
  let lastGroup = null;
  for (const d of DESTINATIONS) {
    // SYSTEM is pushed to the FOOT of the rail. It is not a flight surface —
    // nobody reaches for SETUP while they are flying — and putting it at the
    // bottom keeps the destinations a pilot actually uses under the thumb, in
    // the same order every time, however many pages the roadmap adds above.
    if (d.group === 'system' && lastGroup !== 'system') {
      const spacer = document.createElement('span');
      spacer.className = 'nav__spacer';
      nav.append(spacer);
    } else if (lastGroup !== null && d.group !== lastGroup) {
      const sep = document.createElement('span');
      sep.className = 'nav__sep';
      nav.append(sep);
    }
    lastGroup = d.group;

    const tile = document.createElement('button');
    const active = d.id === s.page || (d.id === 'brief' && ['received', 'share'].includes(s.page));
    tile.className = 'dest' + (active ? ' is-active' : '');
    tile.dataset.dest = d.id;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'dest__icon');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of d.icon) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      svg.append(node);
    }
    tile.append(svg);
    // SETUP carries the gear alone; everything else earns its caption.
    if (d.group !== 'system') {
      const label = document.createElement('span');
      label.className = 'dest__label';
      label.textContent = t(d.label);
      tile.append(label);
    }
    // SOMETHING LANDED HERE WHILE YOU WERE ELSEWHERE. A dot, not a count: the
    // rail collapses to 44px icons on a pilot's knee, and the question it
    // answers is "is there anything over there" — the page holds the detail.
    const marked = Boolean(unseen[d.id]);
    if (marked) {
      const dot = document.createElement('span');
      dot.className = 'dest__dot';
      tile.append(dot);
    }
    // Said out loud too. A coloured dot is not information to a pilot using a
    // screen reader, and it is the whole message here.
    const say = marked ? `${t(d.label)} — ${t('nav.unseen')}` : t(d.label);
    tile.setAttribute('aria-label', say);
    tile.title = say;
    nav.append(tile);
  }
}

/**
 * The template library, the naming panel, and refusals — one page, because
 * they are three states of the same question and only one is ever true.
 *
 * Everything here comes off the snapshot. The naming panel is on screen
 * because MAIN is holding an inspected template, not because this file
 * remembers a key being pressed.
 */
function renderTemplates(s) {
  if (!lib) return;

  // THE NAMING PANEL IS NOT REBUILT WHILE THE PILOT IS TYPING INTO IT. Same
  // rule as the card sheet, and for the same reason: any state push at all
  // rebuilds this — a peer connecting, the funnel polling — and every one
  // would reset the name field to the file's own name mid-word, for a reason
  // having nothing to do with the import.
  if (s.templatePending && lib.querySelector('.tplask')) return;

  lib.textContent = '';

  if (s.templateError) {
    lib.append(refusal(t('tpl.refused'), s.templateError.file, s.templateError.errors, t('tpl.refusedWhy')));
    return;
  }
  if (s.templatePending) return void lib.append(namingPanel(s.templatePending));

  const all = s.templates || [];
  let group = null;
  for (const tpl of all) {
    if (tpl.source !== group) {
      group = tpl.source;
      const head = document.createElement('p');
      head.className = 'lib__group';
      head.textContent = t(group === 'shipped' ? 'tpl.shipped' : 'tpl.yours');
      lib.append(head);
    }
    lib.append(templateTile(tpl, s));
  }
  if (!all.length) {
    const empty = document.createElement('p');
    empty.className = 'lib__empty';
    empty.textContent = t('tpl.none');
    lib.append(empty);
  }
}

function templateTile(tpl, s) {
  const card = s.card || {};
  // IN USE means "this is the sheet you are looking at" — true both for the
  // template your card is built on and for one you chose and have no data for.
  const inUse = (card.blank && card.templateName === tpl.name) || (!card.blank && card.id === tpl.id);

  const tile = document.createElement('div');
  tile.className = 'tpl' + (inUse ? ' tpl--on' : '');

  const choose = document.createElement('button');
  choose.className = 'tpl__choose';
  choose.dataset.template = tpl.id;
  choose.setAttribute('aria-label', tpl.name);

  const name = document.createElement('span');
  name.className = 'tpl__name';
  name.textContent = tpl.name;
  const id = document.createElement('span');
  id.className = 'tpl__id';
  id.textContent = tpl.id;
  const meta = document.createElement('span');
  meta.className = 'tpl__meta';
  meta.textContent = `${tpl.pages.map((p) => p.toUpperCase()).join(' + ')} · ${t('tpl.blocks', { n: tpl.blocks })}`;
  const needs = document.createElement('span');
  needs.className = 'tpl__needs';
  // What a card must carry to fill it. The most useful thing on the tile when
  // you are deciding whether a template is the one you want.
  needs.textContent = tpl.requires.length ? `${t('tpl.needs')} ${tpl.requires.join(' · ')}` : '';
  choose.append(name, id, meta, needs);
  tile.append(choose);

  if (inUse) {
    const flag = document.createElement('span');
    flag.className = 'tpl__flag';
    flag.textContent = t('tpl.inUse');
    tile.append(flag);
  }
  // Shipped templates are not a pilot's to delete.
  if (tpl.source === 'user') {
    const kill = document.createElement('button');
    kill.className = 'tpl__remove';
    kill.dataset.removeTemplate = tpl.id;
    kill.textContent = '×';
    kill.setAttribute('aria-label', t('tpl.remove', { name: tpl.name }));
    kill.title = t('tpl.remove', { name: tpl.name });
    tile.append(kill);
  }
  return tile;
}

function namingPanel(p) {
  const wrap = document.createElement('div');
  wrap.className = 'tplask';

  const title = document.createElement('p');
  title.className = 'tplask__title';
  title.textContent = t(p.replaces ? 'tpl.nameReplace' : 'tpl.name');
  const file = document.createElement('p');
  file.className = 'tplask__file';
  file.textContent = p.file;

  const label = document.createElement('label');
  label.className = 'tplask__label';
  label.textContent = t('tpl.nameLabel');
  label.setAttribute('for', 'tpl-name');

  const input = document.createElement('input');
  input.className = 'tplask__in';
  input.id = 'tpl-name';
  input.maxLength = 60;
  // Prefilled from the name inside the file: whoever wrote the template
  // usually named it well, and retyping a good name is a chore.
  input.value = p.name || p.id;

  const meta = document.createElement('dl');
  meta.className = 'tplask__meta';
  // The ID is SHOWN and not editable. It is what a shared card names on the
  // wire, and the receiver looks up THEIR copy by it — rename it and cards
  // from squadmates stop resolving against a template you are looking at.
  for (const [k, v] of [
    [t('tpl.id'), p.id],
    [t('tpl.pages'), p.pages.map((x) => x.toUpperCase()).join(' + ')],
    [t('tpl.needs'), p.requires.join(' · ') || '—'],
  ]) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    meta.append(dt, dd);
  }

  const keys = document.createElement('div');
  keys.className = 'tplask__keys';
  const cancel = document.createElement('button');
  cancel.className = 'key';
  cancel.id = 'tpl-cancel';
  cancel.textContent = t('tpl.cancel');
  const save = document.createElement('button');
  save.className = 'key key--cta';
  save.id = 'tpl-save';
  save.textContent = t('tpl.save');
  keys.append(cancel, save);

  wrap.append(title, file, label, input, meta, keys);
  return wrap;
}

/** A file that was refused, and every reason why. */
function refusal(title, file, errors, why) {
  const wrap = document.createElement('div');
  wrap.className = 'tplbad';
  const h = document.createElement('p');
  h.className = 'tplbad__title';
  h.textContent = title;
  const f = document.createElement('p');
  f.className = 'tplbad__file';
  f.textContent = file;
  const list = document.createElement('ul');
  list.className = 'tplbad__list';
  for (const err of errors || []) {
    const li = document.createElement('li');
    li.textContent = err;
    list.append(li);
  }
  const tail = document.createElement('p');
  tail.className = 'tplbad__why';
  tail.textContent = why;
  wrap.append(h, f, list, tail);
  return wrap;
}

function renderBanner(s) {
  if (!s.banner) {
    banner.root.classList.add('is-hidden');
    bannerShownAt = null;
    clearTimeout(bannerTimer);
    return;
  }
  setText(banner.who, t('banner.newFrom', { who: (s.banner.who || t('fault.unknown')).toUpperCase() }));
  setText(banner.meta, `${photoWord(s.banner.count)} · ${t(s.banner.switched ? 'banner.switched' : 'banner.queued')}`);
  banner.root.classList.remove('is-hidden');
  if (bannerShownAt !== s.banner.at) {
    bannerShownAt = s.banner.at;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => window.viewerAPI.send('banner-dismiss'), BANNER_DISMISS_MS);
  }
}

function renderStage(s) {
  const q = s.queue;
  const empty = !q.current;
  stage.standby.classList.toggle('is-hidden', !empty);
  if (empty) {
    if (stage.img.getAttribute('src') !== PLACEHOLDER) stage.img.src = PLACEHOLDER;
    setText(stage.file, t('stage.noIntel'));
    setText(stage.posN, '');
    setText(stage.posMeta, '');
    setText(stage.standbyLine1, t('standby.nothing'));
    setText(stage.standbyLine2, t(s.connected ? 'standby.sincePowerUp' : 'standby.offline'));
    return;
  }
  // Only reassign src when it actually changed: re-setting it restarts the
  // decode and flashes the stage, which is the one thing that must never
  // happen on the surface a pilot is reading.
  if (stage.img.getAttribute('src') !== q.current.url) stage.img.src = q.current.url;
  setText(stage.file, (q.current.filename || '').toUpperCase());
  setText(stage.posN, `${q.pos + 1} / ${q.total}`);
  setText(stage.posMeta, ` · ${(q.current.sharedBy || t('fault.unknown')).toUpperCase()} · ${zulu(q.current.receivedAt)}`);
}

function renderReceived(s) {
  autoshow.classList.toggle('is-on', Boolean(s.autoShow));
  autoshow.setAttribute('aria-checked', s.autoShow ? 'true' : 'false');

  batches.textContent = '';
  if (s.batches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'batch';
    const head = document.createElement('div');
    head.className = 'batch__head';
    const who = document.createElement('span');
    who.className = 'batch__who';
    who.textContent = t('received.emptyTitle');
    const meta = document.createElement('span');
    meta.className = 'batch__meta';
    meta.textContent = t('received.emptyHint');
    head.append(who, meta);
    empty.appendChild(head);
    batches.appendChild(empty);
    return;
  }

  for (const batch of s.batches) {
    const root = document.createElement('div');
    root.className = 'batch';
    root.dataset.batchId = String(batch.id);

    const head = document.createElement('div');
    head.className = 'batch__head';
    const who = document.createElement('span');
    who.className = 'batch__who';
    who.textContent = (batch.sharedBy || t('fault.unknown')).toUpperCase();
    const meta = document.createElement('span');
    meta.className = 'batch__meta';
    meta.textContent = t('received.inBrief', {
      sel: batch.selectedCount,
      n: batch.count,
      t: zulu(batch.receivedAt),
    });
    const all = document.createElement('button');
    all.className = 'key key--sm batch__all';
    all.dataset.batchId = String(batch.id);
    all.dataset.on = batch.selectedCount === 0 ? '1' : '0';
    all.textContent = t(batch.selectedCount === 0 ? 'received.restore' : 'received.hide');
    head.append(who, meta, all);

    const tiles = document.createElement('div');
    tiles.className = 'tiles batch__tiles';
    for (const item of batch.items) {
      const tile = document.createElement('button');
      tile.className = 'tile' + (item.selected ? '' : ' is-off');
      tile.dataset.batchId = String(batch.id);
      tile.dataset.filename = item.filename;

      const check = document.createElement('i');
      check.className = 'tile__check';
      const img = document.createElement('img');
      img.className = 'tile__img';
      img.src = item.url || PLACEHOLDER;
      img.alt = '';
      const name = document.createElement('span');
      name.className = 'tile__name';
      name.textContent = item.filename.toUpperCase();

      tile.append(check, img, name);
      tiles.appendChild(tile);
    }

    root.append(head, tiles);
    batches.appendChild(root);
  }
}

function renderShare(s) {
  setText(share.folder, (s.folder ? s.folder.split(/[\\/]/).pop() : t('share.notSet')).toUpperCase());
  setText(
    share.count,
    s.photoCount
      ? t('share.count', { sel: s.selectedCount, n: s.photoCount, size: megabytes(s.stagedBytes) })
      : t('share.noPhotos'),
  );

  share.grid.textContent = '';
  for (const photo of s.photos) {
    const tile = document.createElement('button');
    tile.className = 'tile' + (photo.selected ? '' : ' is-off');
    tile.dataset.filename = photo.filename;

    const check = document.createElement('i');
    check.className = 'tile__check';
    const img = document.createElement('img');
    img.className = 'tile__img';
    img.src = photo.thumbUrl || PLACEHOLDER;
    img.alt = '';
    const name = document.createElement('span');
    name.className = 'tile__name';
    name.textContent = photo.filename.toUpperCase();

    tile.append(check, img, name);
    share.grid.appendChild(tile);
  }

  // "At least one selected" is the deselect state — the common case after
  // picking a couple of photos is wanting to start over, not to add the rest.
  const anySelected = s.selectedCount > 0;
  share.toggle.dataset.on = anySelected ? '1' : '0';
  share.toggle.disabled = s.photoCount === 0;
  setText(share.toggle, t(anySelected ? 'share.none' : 'share.all'));

  share.reveal.disabled = s.selectedCount === 0;
  setText(
    share.reveal,
    s.selectedCount === 0 ? t('share.nothingSelected') : t('share.reveal', { photos: photoWord(s.selectedCount) }),
  );
}

let renderedLocale = null;

function render(s) {
  // Locale first: every string below reads through t().
  if (s.locale !== renderedLocale) {
    renderedLocale = s.locale;
    setLocale(s.locale);
    document.documentElement.lang = s.locale || 'en';
    applyStatic(document);
  }

  body.dataset.page = s.page;
  body.classList.toggle('is-chrome-hidden', s.chromeHidden);
  body.classList.toggle('is-unfocused', !s.focused);

  renderNav(s);
  renderStrip(s);
  // SETUP is a page of this window; settings.js exposes its renderer rather
  // than subscribing separately, so the two cannot show different snapshots.
  if (window.__renderSetup) window.__renderSetup(s);
  renderBanner(s);
  renderStage(s);
  renderActionBar(s);
  renderBrief(s);
  renderCard(s);
  renderTemplates(s);
  renderReceived(s);
  renderShare(s);
}


// --- brief mode -------------------------------------------------------------
// The renderer draws ink and reports gestures. It decides nothing: which tool
// is active, who is presenting and whether we are following all live in main
// (ROADMAP §5.2). The one thing kept locally is the ink itself, because at
// 30 Hz it cannot ride the state push — main pushes deltas on a separate
// channel and a revision per image on the snapshot, so a renderer that missed
// a delta can spot the gap and ask for the whole set again.

const U16 = 65535;
/** hash -> { rev, strokes: [] }. A local mirror of main's store, nothing more. */
const inkByHash = new Map();
let inkHash = null; // the image the canvas is currently showing
let drawing = null; // { id, tool, a } while a gesture is in flight
let presenterCursor = null; // the presenter's pointer, from the last push

// The gesture handlers read the RENDERED DOM rather than a cached snapshot.
// That is not a dodge: the DOM here IS the last snapshot, written by
// renderBrief, and reading it back keeps this file from holding a decision of
// its own — which is the whole point of the invariant in HANDOFF §3. A
// `lastSnapshot` binding would be a second copy of main's state living in one
// surface's DOM, and phase 4 renders two.
const isPresenting = () => stage.ink.classList.contains('is-live');
const activeTool = () => {
  const on = brief.tools.querySelector('[data-tool].is-on');
  return (on && on.dataset.tool) || 'pen';
};

function inkFor(hash) {
  let e = inkByHash.get(hash);
  if (!e) {
    e = { rev: 0, strokes: [] };
    inkByHash.set(hash, e);
  }
  return e;
}

/**
 * Puts the canvas exactly over the image's CONTAINED box.
 *
 * object-fit: contain letterboxes, and only the natural dimensions say where
 * the photo actually landed. A canvas stretched over the whole stage would
 * put marks in the letterbox, and — worse — would resolve the same {u,v} to a
 * different pixel on a differently-shaped window, which is the one thing the
 * normalised coordinates exist to prevent.
 */
function sizeInkCanvas() {
  const img = stage.img;
  const box = img.getBoundingClientRect();
  const nw = img.naturalWidth || 0;
  const nh = img.naturalHeight || 0;
  if (!nw || !nh || !box.width || !box.height) return null;

  const scale = Math.min(box.width / nw, box.height / nh);
  const w = nw * scale;
  const h = nh * scale;
  const left = (box.width - w) / 2;
  const top = (box.height - h) / 2;

  const dpr = window.devicePixelRatio || 1;
  const c = stage.ink;
  c.style.left = `${left}px`;
  c.style.top = `${top}px`;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}

function drawInk() {
  const geom = sizeInkCanvas();
  const c = stage.ink;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  if (!geom) return;
  const { w, h, dpr } = geom;
  ctx.scale(dpr, dpr);

  // One ink style, the EFB's. A second emphasis would have to be semantic,
  // not a palette — see design/brief-mode/HANDOFF.md §5.
  const css = getComputedStyle(document.documentElement);
  ctx.strokeStyle = css.getPropertyValue('--lit').trim() || '#e8ece6';
  ctx.lineWidth = Math.max(2, w / 320);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const X = (u) => (u / U16) * w;
  const Y = (v) => (v / U16) * h;

  for (const stroke of inkFor(inkHash).strokes) {
    if (stroke.tool === 'pen') {
      if (!stroke.points.length) continue;
      ctx.beginPath();
      ctx.moveTo(X(stroke.points[0].u), Y(stroke.points[0].v));
      for (const p of stroke.points.slice(1)) ctx.lineTo(X(p.u), Y(p.v));
      ctx.stroke();
    } else if (stroke.tool === 'arrow') {
      drawArrow(ctx, X(stroke.a.u), Y(stroke.a.v), X(stroke.b.u), Y(stroke.b.v), ctx.lineWidth);
    } else if (stroke.tool === 'ring') {
      // Radius as a fraction of image WIDTH, so it survives any surface size
      // exactly like the coordinates do.
      const r = Math.hypot(X(stroke.b.u) - X(stroke.a.u), Y(stroke.b.v) - Y(stroke.a.v));
      ctx.beginPath();
      ctx.arc(X(stroke.a.u), Y(stroke.a.v), Math.max(r, 1), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // The presenter's pointer. Most of a brief is pointing rather than drawing,
  // which is why this streams even with no tool down.
  const cur = presenterCursor;
  if (cur) {
    const x = X(cur.u);
    const y = Y(cur.v);
    ctx.beginPath();
    ctx.arc(x, y, ctx.lineWidth * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    if (cur.who) {
      ctx.font = `700 ${Math.max(9, w / 60)}px var(--font-mono), monospace`;
      const label = cur.who.toUpperCase();
      const tw = ctx.measureText(label).width;
      ctx.fillRect(x + 8, y - 7, tw + 8, 14);
      ctx.fillStyle = css.getPropertyValue('--ink').trim() || '#1c211c';
      ctx.fillText(label, x + 12, y + 4);
    }
  }
}

function drawArrow(ctx, ax, ay, bx, by, lw) {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  const ang = Math.atan2(by - ay, bx - ax);
  const head = Math.max(lw * 4, 8);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - head * Math.cos(ang - Math.PI / 7), by - head * Math.sin(ang - Math.PI / 7));
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - head * Math.cos(ang + Math.PI / 7), by - head * Math.sin(ang + Math.PI / 7));
  ctx.stroke();
}

/** Applies one delta from main, then redraws if it is the image on screen. */
function applyInkDelta(d) {
  if (!d || !d.hash) return;
  const e = inkFor(d.hash);
  if (d.kind === 'clear') {
    e.strokes = [];
  } else if (d.kind === 'undo') {
    e.strokes = e.strokes.filter((x) => x.id !== d.id);
  } else if (d.kind === 'append') {
    const at = e.strokes.find((x) => x.id === d.id);
    if (at) at.points.push(...d.points);
    else e.strokes.push({ id: d.id, tool: 'pen', by: d.by || '', points: [...d.points] });
  } else if (d.kind === 'upsert') {
    const i = e.strokes.findIndex((x) => x.id === d.id);
    const stroke = { id: d.id, tool: d.tool, by: d.by || '', a: d.a, b: d.b, final: d.final };
    if (i === -1) e.strokes.push(stroke);
    else e.strokes[i] = stroke;
  } else {
    return;
  }
  e.rev = d.rev;
  if (d.hash === inkHash) drawInk();
}

/** Replaces one image's ink wholesale — the answer to a detected gap. */
function loadInk(snap) {
  if (!snap || !snap.hash) return;
  inkByHash.set(snap.hash, { rev: snap.rev || 0, strokes: snap.strokes || [] });
  if (snap.hash === inkHash) drawInk();
}

// --- kneeboard card ---------------------------------------------------------
// The model arrives FINISHED from main (src/main/card.js): every binding is
// already resolved to a plain string, so nothing here interprets card content.
// That is the point — a card is a file a pilot picked today and a file another
// pilot sent tomorrow. Everything below writes textContent.

const card = { root: el('card'), sheet: el('card-sheet') };

// Mirrors s.editing for the duration of a render. Not state: it is read off
// the snapshot at the top of every render, like everything else here.
let editingNow = false;
// A value to re-open after main pushes the next snapshot. Committing an edit
// rebuilds the sheet, so the element the pilot was in no longer exists —
// without this, Tab would commit and land nowhere.
let wantFocus = null;
// The card revision currently on screen. A push that carries the SAME card is
// safe to skip while the pilot is typing; a push carrying a CHANGED one is
// not — skipping that is how a line the pilot added never appeared.
let shownCardRev = null;
// Where the caret goes when `wantFocus` is re-opened. Arriving at a value
// selects it whole; landing mid-line after a dash became a bullet does not.
let wantCaret = 'all';

// The marker a dash turns into. One character, in the DATA, so a bulleted line
// stays bulleted through export, casting and someone else's kneeboard.
const BULLET = '\u2022';

/**
 * Writes a resolved value into a node, split into its editable pieces.
 *
 * With EDIT off this is `textContent = value` and nothing else — byte for
 * byte what it has always been, which is why read mode cannot regress.
 *
 * With EDIT on the value is cut at the spans the resolver measured. The gaps
 * BETWEEN spans are the template's own text — the slash in `24000 / 350`, the
 * arrow in `AL DHAFRA → KHASAB` — and stay untouchable, because they are the
 * shape of the card and not the mission.
 */
function writeValue(node, text, spans) {
  if (!editingNow || !spans || !spans.length) {
    node.textContent = text;
    return;
  }
  node.textContent = '';
  let at = 0;
  for (const sp of spans) {
    if (sp.s > at) node.append(document.createTextNode(text.slice(at, sp.s)));
    const box = document.createElement('span');
    box.className = 'card__ed';
    box.dataset.path = sp.path;
    const piece = text.slice(sp.s, sp.e);
    box.textContent = piece;
    // A value the card does not carry yet renders as nothing, and nothing is
    // not clickable. It still has to be reachable — filling in a blank is the
    // main thing a pilot is here to do.
    if (!piece) box.classList.add('card__ed--empty');
    node.append(box);
    at = sp.e;
  }
  if (at < text.length) node.append(document.createTextNode(text.slice(at)));
}

/** The key that takes one row away. Only in EDIT mode, and only on a block
 *  that actually repeats — a header band has no rows to remove. */
function rowKill(repeat, index) {
  const kill = document.createElement('button');
  kill.className = 'card__rowkill';
  kill.dataset.rowRemove = repeat;
  kill.dataset.rowIndex = String(index);
  kill.textContent = '\u00d7';
  kill.setAttribute('aria-label', t('card.removeRow', { n: index + 1 }));
  kill.title = t('card.removeRow', { n: index + 1 });
  return kill;
}

/**
 * The add key for a repeated block, and the count against its cap.
 *
 * The cap is the template's, not the app's: the layout author is the one who
 * knows how many rows fit a fixed 893x1263 sheet. At the cap the key is GONE
 * rather than present and refusing — the rule the rest of this app follows.
 */
function rowKeys(block) {
  const bar = document.createElement('div');
  bar.className = 'card__rowbar';
  const count = document.createElement('span');
  count.className = 'card__rowcount';
  const n = (block.rows || block.items || []).length;
  count.textContent = t('card.rows', { n, max: block.max });
  bar.append(count);
  if (n < block.max) {
    const add = document.createElement('button');
    add.className = 'card__rowadd';
    add.dataset.rowAdd = block.repeat;
    add.textContent = t('card.addRow');
    bar.append(add);
  }
  return bar;
}

/** One `.card__cell` from a resolved cell. */
function cardCell(cell) {
  const node = document.createElement('span');
  node.className = `card__cell card__w-${cell.width}`;
  if (cell.style === 'mono') node.classList.add('card__cell--mono');
  if (cell.emphasis) node.classList.add(`card__cell--${cell.emphasis}`);
  writeValue(node, cell.value, cell.spans);
  return node;
}

function cardHead(title, subtitle, badge) {
  const head = document.createElement('div');
  head.className = 'card__head';
  const name = document.createElement('span');
  name.className = 'card__head-title';
  name.textContent = title;
  head.append(name);
  if (subtitle) {
    const sub = document.createElement('span');
    sub.className = 'card__head-sub';
    sub.textContent = subtitle;
    head.append(sub);
  }
  if (badge) {
    const chip = document.createElement('span');
    chip.className = 'card__badge';
    chip.textContent = badge;
    head.append(chip);
  }
  return head;
}

function cardBlock(block) {
  const section = document.createElement('section');
  section.className = 'card__section';

  if (block.type === 'fields') {
    const band = document.createElement('div');
    band.className = 'card__band';
    for (const item of block.items) {
      const field = document.createElement('div');
      field.className = `card__field card__w-${item.width}`;
      if (item.emphasis === 'threat') field.classList.add('card__field--threat');
      const label = document.createElement('span');
      label.className = 'card__field-label';
      label.textContent = item.label;
      const value = document.createElement('span');
      value.className = 'card__field-value';
      if (item.style === 'mono') value.classList.add('card__cell--mono');
      writeValue(value, item.value, item.spans);
      field.append(label, value);
      band.append(field);
    }
    return band;
  }

  if (block.type === 'stations') {
    const wrap = document.createElement('div');
    wrap.className = 'card__stations';
    if (block.title) {
      const title = document.createElement('div');
      title.className = 'card__stations-title';
      title.textContent = block.title;
      wrap.append(title);
    }
    const row = document.createElement('div');
    row.className = 'card__stations-row';
    for (const cell of block.cells) {
      const station = document.createElement('div');
      station.className = 'card__station';
      const value = document.createElement('div');
      value.className = 'card__station-value';
      writeValue(value, cell.value, cell.spans && cell.spans.value);
      const label = document.createElement('div');
      label.className = 'card__station-label';
      writeValue(label, cell.label, cell.spans && cell.spans.label);
      station.append(value, label);
      row.append(station);
    }
    wrap.append(row);
    return wrap;
  }

  if (block.type === 'steps') {
    section.append(cardHead(block.title, block.subtitle));
    block.rows.forEach((step, index) => {
      const row = document.createElement('div');
      row.className = 'card__step';
      // DERIVED in main from the ticks — the first step not yet flown — not
      // whichever row the card was written calling itself current. A fixed
      // marker is only true until the first leg is flown, after which it
      // points at something already behind the flight.
      if (step.current) row.classList.add('card__step--current');
      // `done` ONLY. This used to also accept state === 'done', which meant a
      // step the card called done could never be unticked — the tick writes
      // `done`, `state` still said done, and the OR kept the row flown for
      // ever. card.js folds both into `done` now; `state` says CURRENT.
      if (step.done) row.classList.add('card__step--done');
      for (const [cls, key] of [
        ['card__step-name', 'name'],
        ['card__step-ref', 'ref'],
        ['card__step-gate', 'gate'],
        ['card__step-note', 'note'],
      ]) {
        const cell = document.createElement('span');
        cell.className = cls;
        writeValue(cell, step[key], step.spans && step.spans[key]);
        row.append(cell);
      }
      // A plain click marks the step. The design called for hold-to-commit,
      // on the reasoning that a stray tap under turbulence must never mark a
      // step flown — the owner chose the simpler control for now, and a tick
      // is reversible by clicking again, which is what makes that safe.
      if (editingNow && block.repeat) row.append(rowKill(block.repeat, index));
      const tick = document.createElement('button');
      tick.className = 'card__tick';
      tick.dataset.step = String(index);
      tick.setAttribute('aria-label', t('card.tick'));
      const ring = document.createElement('i');
      ring.className = 'card__ring';
      tick.append(ring);
      row.append(tick);
      section.append(row);
    });
    if (editingNow && block.repeat) section.append(rowKeys(block));
    return section;
  }

  if (block.type === 'table') {
    section.append(cardHead(block.title));
    // Wrapped, because the rows have to SHARE their column widths. Laid out as
    // independent flex rows, a row with no TACAN put its frequency at a
    // different x than the row above it — which defeats the one thing a table
    // is for: a column meaning the same thing all the way down.
    const rows = document.createElement('div');
    rows.className = 'card__rows';
    block.rows.forEach((row, index) => {
      const line = document.createElement('div');
      line.className = 'card__row';
      if (row.marked) line.classList.add('card__row--marked');
      for (const cell of row.cells) line.append(cardCell(cell));
      if (editingNow && block.repeat) line.append(rowKill(block.repeat, index));
      rows.append(line);
    });
    section.append(rows);
    if (editingNow && block.repeat) section.append(rowKeys(block));
    return section;
  }

  if (block.type === 'prose') {
    section.className = 'card__section card__prose';
    section.append(cardHead(block.title, '', block.badge));
    // FREE TEXT, NOT A BULLET LIST. A game plan is prose: it may be bulleted,
    // and it may equally be two sentences. The app used to impose a bullet on
    // every line, which made "no bullet" impossible — so the marker is gone and
    // a pilot who wants one types it, the same way they would on paper.
    const list = document.createElement('div');
    list.className = 'card__prose-list';
    block.items.forEach((entry, i) => {
      const item = document.createElement('p');
      item.className = 'card__prose-line';
      // Hanging indent for a line the pilot chose to bullet, so its wrap lines
      // up under the text rather than under the marker. Read off the text, not
      // off a flag, because the marker IS the text.
      if (entry.trimStart().startsWith(BULLET)) item.classList.add('card__prose-line--bullet');
      // A prose line IS its value — no template string between the data and
      // the screen — so the whole line is one editable piece.
      const path = block.itemPaths && block.itemPaths[i];
      writeValue(item, entry, path ? [{ s: 0, e: entry.length, path }] : null);
      if (editingNow && block.repeat) item.append(rowKill(block.repeat, i));
      list.append(item);
    });
    section.append(list);
    if (editingNow) section.append(rowKeys(block));
    return section;
  }

  if (block.type === 'image') {
    const img = document.createElement('img');
    img.className = 'card__image';
    // Already an intel:// or /blob/ URL — main decides which, per surface.
    img.src = block.url;
    img.alt = '';
    img.draggable = false;
    section.append(img);
    if (block.caption) {
      const caption = document.createElement('div');
      caption.className = 'card__caption';
      caption.textContent = block.caption;
      section.append(caption);
    }
    return section;
  }

  return section;
}

/**
 * Scales the fixed 893x1263 sheet to whatever room the surface gives it.
 *
 * The sheet does NOT reflow. Every legibility number in design/kneeboard/ is
 * measured against those dimensions, so the density is fixed and the surface
 * scales — which is also what makes one card render identically here and in an
 * OpenKneeboard tab.
 */
const CARD_W = 893;
const CARD_H = 1263;

// A few px of clearance, and it is not a fudge. `zoom` scales the layout box
// but the two ways of measuring it disagree by a pixel or two — offsetHeight
// comes back UNZOOMED (1263) while getBoundingClientRect is zoomed (1259) —
// and the container's scroll area follows the larger one. Fitting to the last
// pixel therefore left a scrollbar around a sheet that visibly fitted. Sizing
// to slightly less than the room available costs nothing anyone can see and
// removes the whole class of rounding argument.
const CARD_CLEARANCE = 6;

function sizeCard() {
  if (!card.root || card.root.offsetParent === null) return;
  // clientWidth/Height, not getBoundingClientRect: these already exclude a
  // scrollbar, so the fit cannot oscillate between "scrollbar" and "none".
  const width = card.root.clientWidth - CARD_CLEARANCE;
  const height = card.root.clientHeight - CARD_CLEARANCE;
  if (width <= 0 || height <= 0) return;
  const fit = Math.min(width / CARD_W, height / CARD_H);
  card.root.style.setProperty('--card-fit', String(fit));
}

function renderCard(s) {
  if (!card.sheet) return;
  const model = s.card;
  // Read off the snapshot, every render. Not state: main decides whether EDIT
  // is on, this file only draws the consequence.
  editingNow = Boolean(s.editing);
  card.root.classList.toggle('card--editing', editingNow);

  // THE SHEET IS NOT REBUILT WHILE THE PILOT IS TYPING INTO IT. Any state
  // push at all rebuilds this — a peer connecting, the funnel polling, intel
  // landing — and every one of those would otherwise throw away a half-typed
  // value mid-keystroke, for a reason having nothing to do with the card.
  //
  // Committing is safe: commitEditor closes the editor BEFORE it sends, so
  // the push it causes finds nothing open and rebuilds normally.
  // ...unless the card itself changed. Skipping THAT is how a press that adds
  // a line succeeds in main and never reaches the screen.
  const rev = model && model.rev !== undefined ? model.rev : null;
  if (card.sheet.querySelector('.card__ed--open') && rev === shownCardRev) return;
  shownCardRev = rev;

  card.sheet.textContent = '';

  if (!model || !model.pages || !model.pages.length) {
    const empty = document.createElement('p');
    empty.className = 'card__empty';
    empty.textContent = t(model && model.error ? 'card.rejected' : 'card.none');
    card.sheet.append(empty);
    sizeCard();
    return;
  }

  // CARD and MAP are two destinations, not a sub-rail — the nav pages
  // between them. This renders whichever one the snapshot selects.
  // One line of provenance, and deliberately nothing more. A card someone
  // sent simply BECOMES the card — no banner, no prompt, no accept step — so
  // this is the only thing that answers "whose plan am I flying?".
  // A TEMPLATE WITH NOTHING IN IT. Every value on the sheet below is a dash,
  // and without saying so those dashes read as real answers — "TACAN: —" is a
  // sentence a pilot will believe. Said once, at the top, rather than by
  // styling every cell differently.
  if (model.blank) {
    const note = document.createElement('div');
    note.className = 'card__blank';
    const what = document.createElement('span');
    what.className = 'card__blank-what';
    what.textContent = t('card.blank');
    const why = document.createElement('span');
    why.className = 'card__blank-why';
    why.textContent = t('card.blankWhy');
    note.append(what, why);
    card.sheet.append(note);
  }

  if (model.from) {
    const from = document.createElement('div');
    from.className = 'card__from';
    from.textContent = t('card.from', { who: model.from.toUpperCase() });
    card.sheet.append(from);
  }

  const page = model.pages.find((p) => p.id === (s.cardPage || 'card')) || model.pages[0];
  const comms = [];
  for (const block of page.blocks) {
    if (block.band === 'comms') {
      comms.push(cardBlock(block));
      continue;
    }
    card.sheet.append(cardBlock(block));
  }
  if (comms.length) {
    const row = document.createElement('div');
    row.className = 'card__comms';
    row.append(...comms);
    card.sheet.append(row);
  }
  sizeCard();

  // Re-open whatever the pilot Tabbed to. The sheet was rebuilt under them by
  // the commit that got here, so the element they were heading for is new.
  if (editingNow && wantFocus) {
    const next = byPath(wantFocus);
    const caret = wantCaret;
    wantFocus = null;
    wantCaret = 'all';
    if (next) openEditor(next, caret);
  }
}

/**
 * The action bar: what THIS app can do.
 *
 * Hidden entirely where an app has no verbs. SETUP is the case that matters —
 * it already carries a save bar, and a second empty row beneath would spend
 * 44px of a kneeboard saying nothing.
 */
function renderActionBar(s) {
  const inIntel = INTEL_VIEWS.includes(s.page);
  const onCard = CARD_VIEWS.includes(s.page);
  abar.root.classList.toggle('is-hidden', !inIntel && !onCard);
  abar.views.classList.toggle('is-hidden', !inIntel);
  abar.card.classList.toggle('is-hidden', !onCard);
  for (const key of abar.root.querySelectorAll('[data-view]')) {
    key.classList.toggle('is-on', key.dataset.view === s.page);
  }
  // Each view gets its OWN verb and only its own. Loading data into the
  // library, or importing a template while looking at the sheet, are both
  // keys that would sit there meaning nothing.
  const onSheet = s.page === 'card';
  const hasCard = Boolean(s.card && s.card.pages && s.card.pages.length && !s.card.blank);
  el('card-import').classList.toggle('is-hidden', !onSheet);
  el('template-import').classList.toggle('is-hidden', s.page !== 'templates');
  // EDIT and EXPORT need a card to act on, and EDIT is refused while casting
  // — absent rather than present-and-refusing, the rule the rest of this app
  // follows. The same exclusion is enforced in main, because the hotkey
  // reaches the same intent without passing through here.
  const casting = Boolean(s.brief && s.brief.presenting);
  el('card-edit').classList.toggle('is-hidden', !onSheet || !hasCard || casting);
  el('card-edit').classList.toggle('is-on', Boolean(s.editing));
  el('card-edit').setAttribute('aria-label', t(s.editing ? 'card.editStop' : 'card.edit'));
  el('card-edit').title = t(s.editing ? 'card.editStop' : 'card.edit');
  el('card-export').classList.toggle('is-hidden', !onSheet || !hasCard);
}

function renderBrief(s) {
  const b = s.brief || {};
  presenterCursor = b.presenting ? null : b.cursor || null; // never draw our own
  const mine = b.presenting;
  const theirs = Boolean(b.presenter) && !mine;

  stage.cast.classList.toggle('is-live', mine);
  // The count comes with it. Knowing whether anyone is actually watching was
  // the point of the whole lock model, so it must not vanish with the bar —
  // it belongs on the key that starts and stops the thing anyway.
  const castSays = mine
    ? `${t('brief.stop')} — ${t('brief.withYou', { n: countFollowers(s) })}`
    : t('brief.present');
  stage.cast.setAttribute('aria-label', castSays);
  stage.cast.title = castSays;
  brief.tools.classList.toggle('is-hidden', !mine);
  stage.ink.classList.toggle('is-live', mine);

  // Held controls are REMOVED, not left sitting there inert. A chevron that
  // depresses and does not turn the page is indistinguishable from a broken
  // app — this project has already shipped that exact experience once. The
  // cast key goes too: pressing PRESENT while someone else has the brief
  // would take it off them, which is not a thing a follower should be able to
  // do by accident.
  const held = Boolean(b.locked);
  stage.prev.classList.toggle('is-hidden', held);
  stage.next.classList.toggle('is-hidden', held);
  // And nothing to cast is nothing to cast: the library holds no card, and a
  // template being previewed empty has no data to send. A key that would put
  // the PREVIOUS card on everyone's knee is worse than one that is absent.
  const nothingToSend = s.page === 'templates' || (s.page === 'card' && s.card && s.card.blank);
  stage.cast.classList.toggle('is-hidden', held || Boolean(nothingToSend));

  for (const node of brief.tools.querySelectorAll('[data-tool]')) {
    node.classList.toggle('is-on', node.dataset.tool === b.tool);
  }

  // The bar states what is happening. For a follower there is no longer an
  // action on it: the controls are the presenter's until they stop, so the
  // key would be a button that refuses. Saying who holds them is the whole
  // job — chrome that quietly stops responding reads as a frozen app.
  // A card that just went out borrows the same bar. It is the one place the
  // app already says what is happening on the net, and casting a card changes
  // nothing else on the sender's own screen — they are still looking at the
  // card they sent, so without a word here the key looks broken.
  // NO BAR FOR THE PRESENTER. The cast key lit IS the statement that you are
  // casting, and pressing it again is how you stop — a bar repeating that with
  // its own STOP key was a second control for one action.
  //
  // The FOLLOWER's bar stays. It answers a different question — who is holding
  // your controls — and exists because chrome that silently stops responding
  // reads as a frozen app.
  const sent = !mine && !theirs ? b.sent : null;
  const show = theirs || Boolean(sent);
  brief.bar.classList.toggle('is-hidden', !show);
  brief.key.classList.add('is-hidden');
  if (sent) {
    setText(brief.title, t('card.sent'));
    // Naming the number is the point: 0 means nobody is on the net, which is
    // the answer a pilot most needs when they thought they had just shared.
    setText(brief.meta, t('card.sentTo', { n: sent.n }));
    delete brief.key.dataset.act;
  } else if (theirs) {
    setText(brief.title, t('brief.following', { who: (b.presenter || '').toUpperCase() }));
    // A pilot who does not have the presenter's photo is looking at a
    // different image from everyone else. Never let that be silent.
    setText(brief.meta, t(b.focusMissing ? 'brief.notInYourBrief' : 'brief.heldByPresenter'));
    delete brief.key.dataset.act;
  }

  // The capture-clean marker. Only while watching someone else: a presenter
  // knows why their own page turned.
  brief.mark.classList.toggle('is-hidden', !theirs);
  if (theirs) setText(brief.markLabel, t('brief.following', { who: (b.presenter || '').toUpperCase() }));

  // Ink follows the focused image. Which image that is comes from the queue,
  // not from FOCUS: a pilot browsing on their own annotates what THEY are
  // looking at.
  const hash = (s.queue.current && s.queue.current.hash) || null;
  const revs = b.inkRevs || {};
  if (hash !== inkHash) inkHash = hash;
  // Unconditionally, not only when the image changed. The canvas is POSITIONED
  // from measured geometry, so it has to be re-measured whenever anything that
  // affects that geometry might have moved — and gating this on a hash change
  // meant it was never measured at all when the photo carried no hash: the
  // canvas kept its untouched 300x150 default, parked below the photo,
  // covering nothing. Every press then landed on the <img> underneath and
  // started a native image drag instead of drawing. Redrawing a few hundred
  // strokes per state push is not worth optimising against that.
  drawInk();
  // A revision ahead of ours means we missed a delta. Ask for the whole set
  // rather than rendering a brief with a hole in it.
  if (hash && revs[hash] !== undefined && revs[hash] !== inkFor(hash).rev) {
    send('brief-snapshot-req', { hash });
  }
}

function countFollowers(s) {
  // Everyone on the net except us. The relay does not report per-pilot follow
  // state, so this is honestly "pilots who can see it", not "pilots watching".
  return Math.max(0, (s.peers || []).length - 1);
}

// --- gestures ---------------------------------------------------------------
// PEN: hold, draw, release commits. ARROW: press anchors the TAIL, drag
// rubber-bands the head. RING: press anchors the CENTRE, drag sets the radius.

function pointFromEvent(ev) {
  const box = stage.ink.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const u = Math.round(Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width)) * U16);
  const v = Math.round(Math.max(0, Math.min(1, (ev.clientY - box.top) / box.height)) * U16);
  return { u, v };
}

let cursorSentAt = 0;
const CURSOR_HZ_MS = 50; // 20 Hz

if (stage.ink) {
  stage.ink.addEventListener('pointerdown', (ev) => {
    if (!isPresenting()) return;
    const p = pointFromEvent(ev);
    if (!p) return;
    stage.ink.setPointerCapture(ev.pointerId);
    const tool = activeTool();
    drawing = { id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`, tool, a: p };
    if (tool === 'pen') send('brief-stroke', { id: drawing.id, points: [p] });
    else send('brief-shape', { id: drawing.id, tool, a: p, b: p, final: false });
  });

  stage.ink.addEventListener('pointermove', (ev) => {
    if (!isPresenting()) return;
    const p = pointFromEvent(ev);
    if (!p) return;

    if (!drawing) {
      // Pointing, not drawing. Most of a brief is this.
      const now = Date.now();
      if (now - cursorSentAt >= CURSOR_HZ_MS) {
        cursorSentAt = now;
        send('brief-cursor', p);
      }
      return;
    }
    if (drawing.tool === 'pen') send('brief-stroke', { id: drawing.id, points: [p] });
    else send('brief-shape', { id: drawing.id, tool: drawing.tool, a: drawing.a, b: p, final: false });
  });

  const finish = (ev) => {
    if (!drawing) return;
    const p = pointFromEvent(ev) || drawing.a;
    if (drawing.tool !== 'pen') {
      send('brief-shape', { id: drawing.id, tool: drawing.tool, a: drawing.a, b: p, final: true });
    }
    drawing = null;
  };
  stage.ink.addEventListener('pointerup', finish);
  stage.ink.addEventListener('pointercancel', finish);
}

// The canvas is positioned from measured geometry, so anything that changes
// the geometry has to re-run it: a new photo, a resize, a scale change.
if (stage.img) stage.img.addEventListener('load', drawInk);
window.addEventListener('resize', drawInk);
// The sheet is a fixed 893x1263; only its scale follows the surface.
window.addEventListener('resize', sizeCard);

// --- intents ----------------------------------------------------------------
// Every handler sends; none of them mutate. Main decides and pushes back.
// Guarded: under the dev harnesses (preview.html, geometry) there is no
// preload and no main — intents go nowhere.

const send = (intent, payload) => window.viewerAPI && window.viewerAPI.send(intent, payload);

// Navigation
// itself — the label already says where you are, so it is the obvious thing
// to press to go somewhere else.
// The hamburger collapses the rail. It is the only thing left in the strip
// that navigates, because the rail itself is one press to anywhere.
menukey.addEventListener('click', () => send('toggle-nav'));

abar.root.addEventListener('click', (event) => {
  const view = event.target.closest('[data-view]');
  if (view) return send('set-page', view.dataset.view);
  if (event.target.closest('#card-import')) return send('card-import');
  if (event.target.closest('#template-import')) return send('template-import');
  if (event.target.closest('#card-export')) return send('card-export');
  if (event.target.closest('#card-edit')) return send('card-edit-mode', !el('card-edit').classList.contains('is-on'));
});

// The library. Delegated, because the tiles are rebuilt on every push.
if (lib) {
  lib.addEventListener('click', (event) => {
    const kill = event.target.closest('[data-remove-template]');
    if (kill) return send('template-remove', kill.dataset.removeTemplate);
    const pick = event.target.closest('[data-template]');
    if (pick) return send('template-choose', pick.dataset.template);
    if (event.target.closest('#tpl-cancel')) return send('template-cancel');
    if (event.target.closest('#tpl-save')) {
      // The one place this file reads a value out of the DOM rather than off
      // the snapshot, and it is not a state leak: the name exists nowhere else
      // until the pilot commits it, which is what pressing SAVE means.
      const input = el('tpl-name');
      return send('template-save', input ? input.value : '');
    }
  });
  // Enter saves. A one-field form that needs a mouse to submit is a form
  // nobody finishes on a knee.
  lib.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target.id !== 'tpl-name') return;
    event.preventDefault();
    send('template-save', event.target.value);
  });
}

nav.addEventListener('click', (event) => {
  const tile = event.target.closest('.dest[data-dest]');
  if (!tile) return;
  const dest = DESTINATIONS.find((d) => d.id === tile.dataset.dest);
  if (dest) send('set-page', dest.id);
});


// --- editing the card -------------------------------------------------------
// Click a value, type, and move with the keyboard. There is no on-screen
// keyboard by design: writing a card is something you do at a desk before you
// fly, which is what keeps this consistent with brief mode having no TEXT tool
// (typing has no place in VR — PROTOCOL.md).

/** Every editable piece on the sheet, in READING order. */
const editables = () => [...card.sheet.querySelectorAll('.card__ed')];

/** Opens one for typing. Renderer-local: nothing has changed yet, so this
 *  must NOT push state — a re-render would destroy the element mid-keystroke. */
function openEditor(node, caret = 'all') {
  if (!node) return;
  const live = card.sheet.querySelector('.card__ed--open');
  if (live && live !== node) commitEditor(live);
  node.classList.add('card__ed--open');
  node.dataset.was = node.textContent;
  node.contentEditable = 'plaintext-only';
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node);
  // Selecting the whole value is right when you ARRIVE at one — the first
  // keystroke replaces it, which is what you want when filling a card in. It
  // is wrong when you are mid-line, as after turning a dash into a bullet.
  if (caret === 'end') range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function closeEditor(node) {
  // THE CLASS COMES OFF FIRST. Clearing contentEditable blurs the element, and
  // blur fires focusout synchronously — which commits. With the class still
  // on, that re-entered commitEditor, sent a second identical edit, and reset
  // the pending focus to null, so Enter in a list added the line and then
  // landed nowhere.
  node.classList.remove('card__ed--open');
  node.contentEditable = 'false';
  delete node.dataset.was;
}

/** Sends the change, if there is one. Main re-resolves and pushes back. */
function commitEditor(node, focusNext = null) {
  if (!node) return;
  const text = node.textContent;
  const was = node.dataset.was;
  const path = node.dataset.path;
  closeEditor(node);

  if (text !== was && path) {
    // Main re-resolves and pushes a new sheet, so the element the pilot is
    // moving to does not exist yet. renderCard opens it once it does.
    wantFocus = focusNext || null;
    send('card-edit', { path, value: text });
    return;
  }
  // Nothing changed, so nothing is pushed and the DOM stays as it is —
  // move straight there.
  if (focusNext) openEditor(byPath(focusNext));
}

const byPath = (path) => card.sheet.querySelector(`.card__ed[data-path="${CSS.escape(path)}"]`);

/** The value before or after this one, in reading order across the sheet. */
function step(node, delta) {
  const all = editables();
  const at = all.indexOf(node);
  return at === -1 ? null : all[at + delta] || null;
}

/**
 * The value one row up or down in the SAME COLUMN.
 *
 * By geometry, not by counting cells: a row with a missing value has fewer
 * cells than its neighbour, so an index would drift across the table. Nearest
 * left edge is what a pilot means by "the one below this".
 */
function verticalNeighbour(node, delta) {
  const row = node.closest('.card__row, .card__step, .card__prose-line');
  const section = node.closest('.card__section');
  if (!row || !section) return null;
  const rows = [...section.querySelectorAll('.card__row, .card__step, .card__prose-line')];
  const next = rows[rows.indexOf(row) + delta];
  if (!next) return null;
  const x = node.getBoundingClientRect().left;
  const candidates = [...next.querySelectorAll('.card__ed')];
  if (!candidates.length) return null;
  return candidates.reduce((best, c) =>
    Math.abs(c.getBoundingClientRect().left - x) < Math.abs(best.getBoundingClientRect().left - x) ? c : best);
}

/** The list a prose item belongs to — `plan.flow[2]` names `plan.flow`. */
function proseRepeat(node) {
  const m = /^(.*)\[\d+\]$/.exec(node.dataset.path || '');
  return m ? m[1] : null;
}

/** The value before or after this one WITHIN its row. */
function horizontalNeighbour(node, delta) {
  const row = node.closest('.card__row, .card__step, .card__band, .card__prose-line');
  if (!row) return null;
  const inRow = [...row.querySelectorAll('.card__ed')];
  const at = inRow.indexOf(node);
  return at === -1 ? null : inRow[at + delta] || null;
}

card.sheet.addEventListener('click', (event) => {
  const add = event.target.closest('[data-row-add]');
  const kill = event.target.closest('[data-row-remove]');
  if (add || kill) {
    // Commit whatever is open FIRST. A real press blurs the editor on
    // mousedown and gets here with nothing open, but relying on that ordering
    // would mean a row press silently doing nothing whenever it does not
    // hold — the sheet is not rebuilt while an editor is open, by design.
    commitEditor(card.sheet.querySelector('.card__ed--open'));
    if (add) return send('card-row-add', add.dataset.rowAdd);
    return send('card-row-remove', { repeat: kill.dataset.rowRemove, index: Number(kill.dataset.rowIndex) });
  }
  const box = event.target.closest('.card__ed');
  if (box && !box.classList.contains('card__ed--open')) openEditor(box);
});

card.sheet.addEventListener('keydown', (event) => {
  const node = event.target.closest('.card__ed--open');
  if (!node) return;

  // Esc puts the old value back. Nothing is sent, so nothing changed.
  if (event.key === 'Escape') {
    event.preventDefault();
    node.textContent = node.dataset.was;
    closeEditor(node);
    return;
  }
  // Tab is READING order — the next value anywhere on the sheet, carrying on
  // across block boundaries.
  if (event.key === 'Tab') {
    event.preventDefault();
    // A DASH AND TAB MAKES A BULLET. The marker is TEXT, not a flag on the
    // line: it is what the pilot typed, so it exports, casts and reads exactly
    // as written, and no card ever grows a field that means "this one is a
    // bullet". Anywhere else Tab moves on as usual.
    if (!event.shiftKey && node.closest('.card__prose-line') && node.textContent.trim() === '-') {
      node.textContent = `${BULLET} `;
      // Back into the SAME line with the caret after the marker — commitEditor
      // owns `wantFocus`, so it has to be told, not set behind its back.
      wantCaret = 'end';
      return commitEditor(node, node.dataset.path);
    }
    const next = step(node, event.shiftKey ? -1 : 1);
    return commitEditor(node, next && next.dataset.path);
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    // IN FREE TEXT, ENTER IS A NEW LINE, inserted right after this one — what
    // Enter does in anything a pilot has ever typed into. There was previously
    // no way to add a line to the game plan at all.
    const line = node.closest('.card__prose-line');
    const repeat = line && proseRepeat(node);
    if (line && repeat) {
      const at = [...line.parentElement.children].indexOf(line) + 1;
      const value = node.textContent;
      closeEditor(node);
      // ONE intent. Sent as an edit and then an add, main pushes twice: the
      // first render re-opens the editor being moved to, and the second — the
      // one carrying the new line — is skipped, because the sheet is not
      // rebuilt while an editor is open.
      wantFocus = `${repeat}[${at}]`;
      send('card-line-break', { path: node.dataset.path, value, repeat, at });
      return;
    }
    // Everywhere else it commits and drops a row, the spreadsheet convention:
    // a route table is filled in columns, not in rows.
    const down = verticalNeighbour(node, 1) || step(node, 1);
    return commitEditor(node, down && down.dataset.path);
  }
  // The arrows move by GRID position, which is why they earn their place
  // alongside Tab: down from an altitude lands on the next leg's altitude,
  // not on its note. Where a block has no such neighbour they fall back to
  // reading order rather than dead-ending.
  const arrows = { ArrowDown: [verticalNeighbour, 1], ArrowUp: [verticalNeighbour, -1],
                   ArrowRight: [horizontalNeighbour, 1], ArrowLeft: [horizontalNeighbour, -1] };
  if (arrows[event.key]) {
    const [find, delta] = arrows[event.key];
    // Left and right inside the text are how you fix a typo, so they only
    // move between values when the caret is already at the end it is heading
    // for. Up and down always move.
    if (find === horizontalNeighbour) {
      const sel = window.getSelection();
      const at = sel && sel.isCollapsed ? sel.anchorOffset : -1;
      const len = node.textContent.length;
      if (at === -1 || (delta > 0 ? at !== len : at !== 0)) return;
    }
    const target = find(node, delta) || step(node, delta);
    if (!target) return;
    event.preventDefault();
    commitEditor(node, target.dataset.path);
  }
});

// Clicking away commits, the same as Tab. A value left open when the pilot
// looks elsewhere should be saved, not silently dropped.
card.sheet.addEventListener('focusout', (event) => {
  const node = event.target.closest && event.target.closest('.card__ed--open');
  if (node) commitEditor(node);
});

banner.close.addEventListener('click', () => send('banner-dismiss'));

stage.prev.addEventListener('click', () => send('step', -1));
stage.next.addEventListener('click', () => send('step', 1));

// Brief mode. PRESENT toggles; the bar's single key does whatever the state
// needs — STOP, BREAK or REJOIN — so there is never more than one way out.
stage.cast.addEventListener('click', () => send('brief-present', !isPresenting()));
// Window controls. main owns the window, so these are intents like everything
// else — the renderer never touches BrowserWindow.
el('wctl').addEventListener('click', (event) => {
  const key = event.target.closest('[data-window]');
  if (key) send('window-control', key.dataset.window);
});

// Ticking a route step. Local to this instance — whether a lead ticking a
// step pushes to the flight is the same question as brief mode's FOCUS and
// gets the same machinery, not a second one.
card.sheet.addEventListener('click', (event) => {
  const tick = event.target.closest('.card__tick');
  if (tick) send('card-tick', Number(tick.dataset.step));
});

brief.key.addEventListener('click', () => {
  // STOP is the only action this key has ever needed since following stopped
  // being something a pilot leaves.
  if (brief.key.dataset.act === 'stop') send('brief-present', false);
});
brief.tools.addEventListener('click', (event) => {
  const tool = event.target.closest('[data-tool]');
  if (tool) return send('brief-tool', tool.dataset.tool);
  if (event.target.closest('#tool-undo')) return send('brief-undo');
  if (event.target.closest('#tool-clear')) return send('brief-clear');
});

// The auto-switch rule. The desired value derives from the rendered state
// (aria-checked mirrors the snapshot), not from renderer-owned state.
autoshow.addEventListener('click', () => {
  send('set-auto-show', autoshow.getAttribute('aria-checked') !== 'true');
});

// RECEIVED curation: a tile drops/restores one photo; the head key a batch.
batches.addEventListener('click', (event) => {
  const all = event.target.closest('.batch__all[data-batch-id]');
  if (all) {
    send('set-batch', { batchId: Number(all.dataset.batchId), on: all.dataset.on === '1' });
    return;
  }
  const tile = event.target.closest('.tile[data-batch-id][data-filename]');
  if (tile) {
    send('toggle-received', { batchId: Number(tile.dataset.batchId), filename: tile.dataset.filename });
  }
});

share.grid.addEventListener('click', (event) => {
  const tile = event.target.closest('.tile[data-filename]');
  if (tile) send('toggle-photo', tile.dataset.filename);
});

// One key. The action follows the rendered state, so it never disagrees with
// the label: with anything selected it clears, otherwise it selects all.
share.toggle.addEventListener('click', () => {
  send(share.toggle.dataset.on === '1' ? 'select-none' : 'select-all');
});
el('share-folder-btn').addEventListener('click', () => send('browse-folder'));
share.reveal.addEventListener('click', () => send('reveal'));

fixkey.addEventListener('click', () => {
  // Land on NETWORK, not wherever the rail was left — that is the section
  // that can actually do something about being offline.
  if (window.__setupSection) window.__setupSection('net');
  send('set-page', 'setup');
});

// Focus drives the chrome dimming, and counts as the pilot being present —
// main uses that for the auto-switch grace window.
window.addEventListener('focus', () => send('focus', true));
window.addEventListener('blur', () => send('focus', false));

if (window.viewerAPI) {
  window.viewerAPI.onState(render);
window.viewerAPI.onInk(applyInkDelta);
window.viewerAPI.onInkSnapshot(loadInk);
  send('ready');
} else {
  // preview.html / the geometry harness, loading this file without Electron:
  // expose the real render so they can drive it with fake snapshots. The
  // shipped HTML carries no demo content — this hook is what populates it.
  window.__preview = { render };
}
