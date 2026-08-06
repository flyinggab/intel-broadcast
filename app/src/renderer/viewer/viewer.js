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
// The launcher is generated from this. Adding a page is ONE entry here plus
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
    id: 'brief',
    group: 'intel',
    label: 'tab.brief',
    icon: [['rect', { x: 3, y: 2, width: 14, height: 16 }], ['path', { d: 'M6 7h8M6 11h8M6 15h5' }]],
  },
  {
    id: 'received',
    group: 'intel',
    label: 'tab.received',
    icon: [
      ['path', { d: 'M10 2v9M6 8l4 4 4-4', 'stroke-linecap': 'round' }],
      ['path', { d: 'M3 14h14v4H3z' }],
    ],
  },
  {
    id: 'share',
    group: 'intel',
    label: 'tab.share',
    icon: [
      ['path', { d: 'M10 13V4M6 7l4-4 4 4', 'stroke-linecap': 'round' }],
      ['path', { d: 'M3 14h14v4H3z' }],
    ],
  },
  {
    id: 'setup',
    group: 'system',
    label: 'tab.setup',
    icon: [
      ['path', { d: 'M2 5h16M2 10h16M2 15h16' }],
      ['circle', { cx: 7, cy: 5, r: 2, fill: 'currentColor', stroke: 'none' }],
      ['circle', { cx: 13, cy: 10, r: 2, fill: 'currentColor', stroke: 'none' }],
      ['circle', { cx: 6, cy: 15, r: 2, fill: 'currentColor', stroke: 'none' }],
    ],
  },
];
// Group order is the order they appear; a group with no destinations is
// simply not rendered, so this list can run ahead of the pages.
const GROUPS = ['intel', 'mission', 'reference', 'tools', 'system'];

const strip = { net: el('strip-net'), relay: el('strip-relay') };
const crumb = { root: el('crumb'), page: el('crumb-page'), pos: el('crumb-pos') };
const menukey = el('menukey');
const launcher = el('launcher');
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
  const dest = DESTINATIONS.find((d) => d.id === s.page);
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

function renderLauncher(s) {
  launcher.classList.toggle('is-hidden', !s.launcherOpen);
  // The menu key goes while a presenter holds this pilot's controls, for the
  // same reason the chevrons do: main refuses to open the launcher, so the
  // key would press and do nothing. Same rule everywhere — a control that
  // cannot act is not shown.
  const held = Boolean(s.brief && s.brief.locked);
  menukey.classList.toggle('is-hidden', held);
  menukey.classList.toggle('is-active', Boolean(s.launcherOpen));
  menukey.setAttribute('aria-expanded', s.launcherOpen ? 'true' : 'false');
  crumb.root.setAttribute('aria-expanded', s.launcherOpen ? 'true' : 'false');
  // Rebuilding a hidden menu every push is waste, and it would also fight the
  // pilot's scroll position inside it.
  if (!s.launcherOpen) return;

  launcher.textContent = '';
  for (const group of GROUPS) {
    const members = DESTINATIONS.filter((d) => d.group === group);
    if (members.length === 0) continue;

    const heading = document.createElement('span');
    heading.className = 'launcher__group';
    heading.textContent = t(`group.${group}`);
    launcher.appendChild(heading);

    const tiles = document.createElement('div');
    tiles.className = 'launcher__tiles';
    for (const d of members) {
      const tile = document.createElement('button');
      tile.className = 'dest' + (d.id === s.page ? ' is-active' : '');
      tile.dataset.dest = d.id;
      tile.setAttribute('role', 'menuitem');

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'dest__icon');
      svg.setAttribute('viewBox', '0 0 20 20');
      svg.setAttribute('aria-hidden', 'true');
      for (const [tag, attrs] of d.icon) {
        const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
        svg.appendChild(node);
      }

      const name = document.createElement('span');
      name.textContent = t(d.label);

      tile.append(svg, name);
      tiles.appendChild(tile);
    }
    launcher.appendChild(tiles);
  }
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

  renderLauncher(s);
  renderStrip(s);
  // SETUP is a page of this window; settings.js exposes its renderer rather
  // than subscribing separately, so the two cannot show different snapshots.
  if (window.__renderSetup) window.__renderSetup(s);
  renderBanner(s);
  renderStage(s);
  renderBrief(s);
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

function renderBrief(s) {
  const b = s.brief || {};
  presenterCursor = b.presenting ? null : b.cursor || null; // never draw our own
  const mine = b.presenting;
  const theirs = Boolean(b.presenter) && !mine;

  stage.cast.classList.toggle('is-on', mine);
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
  stage.cast.classList.toggle('is-hidden', held);

  for (const node of brief.tools.querySelectorAll('[data-tool]')) {
    node.classList.toggle('is-on', node.dataset.tool === b.tool);
  }

  // The bar states what is happening. For a follower there is no longer an
  // action on it: the controls are the presenter's until they stop, so the
  // key would be a button that refuses. Saying who holds them is the whole
  // job — chrome that quietly stops responding reads as a frozen app.
  const show = mine || theirs;
  brief.bar.classList.toggle('is-hidden', !show);
  brief.key.classList.toggle('is-hidden', !mine);
  if (mine) {
    setText(brief.title, t('brief.youArePresenting'));
    setText(brief.meta, t('brief.withYou', { n: countFollowers(s) }));
    setText(brief.key, t('brief.stop'));
    brief.key.dataset.act = 'stop';
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

// --- intents ----------------------------------------------------------------
// Every handler sends; none of them mutate. Main decides and pushes back.
// Guarded: under the dev harnesses (preview.html, geometry) there is no
// preload and no main — intents go nowhere.

const send = (intent, payload) => window.viewerAPI && window.viewerAPI.send(intent, payload);

// Two ways into the launcher, both in the strip: the key, and the breadcrumb
// itself — the label already says where you are, so it is the obvious thing
// to press to go somewhere else.
menukey.addEventListener('click', () => send('toggle-launcher'));
crumb.root.addEventListener('click', () => send('toggle-launcher'));

launcher.addEventListener('click', (event) => {
  const tile = event.target.closest('.dest[data-dest]');
  if (!tile) return;
  const dest = DESTINATIONS.find((d) => d.id === tile.dataset.dest);
  if (dest) send('set-page', dest.id);
});

// Escape closes it — the launcher covers the whole window, so there has to be
// a way out that is not "find the key again".
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') send('close-launcher');
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
