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
};
const batches = el('batches');
const autoshow = el('tg-autoshow');
const share = {
  folder: el('share-folder'),
  count: el('share-count'),
  grid: el('share-grid'),
  reveal: el('share-reveal'),
};
const fault = { bar: el('faultbar'), attempt: el('fault-attempt') };

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
}

function renderLauncher(s) {
  launcher.classList.toggle('is-hidden', !s.launcherOpen);
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

  share.reveal.disabled = s.selectedCount === 0;
  setText(
    share.reveal,
    s.selectedCount === 0 ? t('share.nothingSelected') : t('share.reveal', { photos: photoWord(s.selectedCount) }),
  );
}

function renderFault(s) {
  // Reported in place. The relay being down does not take the screen: the
  // photos already received are still there to read, and replacing one the
  // pilot is looking at with an error page told them less than this line does.
  fault.bar.classList.toggle('is-hidden', s.connected);
  if (s.connected) return;
  const r = s.reconnect || {};
  setText(
    fault.attempt,
    r.attempt
      ? t('fault.attempt', { n: r.attempt, s: Math.ceil((r.nextInMs || 0) / 1000) })
      : t('fault.reconnecting'),
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
  renderReceived(s);
  renderShare(s);
  renderFault(s);
}

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

el('share-all').addEventListener('click', () => send('select-all'));
el('share-none').addEventListener('click', () => send('select-none'));
el('share-folder-btn').addEventListener('click', () => send('browse-folder'));
share.reveal.addEventListener('click', () => send('reveal'));

el('fault-retry').addEventListener('click', () => send('reconnect'));
el('fault-setup').addEventListener('click', () => send('set-page', 'setup'));

// Focus drives the chrome dimming, and counts as the pilot being present —
// main uses that for the auto-switch grace window.
window.addEventListener('focus', () => send('focus', true));
window.addEventListener('blur', () => send('focus', false));

if (window.viewerAPI) {
  // Report that someone is at the machine, so main can show the chrome and
// restart its idle countdown. Throttled hard: this fires on mouse movement and
// it must not become an IPC storm. Main owns the timer and the state; this only
// says "still here".
let lastActivitySent = 0;
function reportActivity() {
  const now = Date.now();
  if (now - lastActivitySent < 1000) return;
  lastActivitySent = now;
  send('activity');
}
for (const type of ['mousemove', 'mousedown', 'keydown', 'wheel']) {
  window.addEventListener(type, reportActivity, { passive: true });
}

window.viewerAPI.onState(render);
  send('ready');
} else {
  // preview.html / the geometry harness, loading this file without Electron:
  // expose the real render so they can drive it with fake snapshots. The
  // shipped HTML carries no demo content — this hook is what populates it.
  window.__preview = { render };
}
