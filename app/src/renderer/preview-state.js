'use strict';

// DEV HARNESS DATA — not loaded by the app, ever.
//
// The shipped viewer.html contains no demo content (SETUP is a page of it): it
// boot empty and truthful. Everything preview.html (and the geometry
// harness) shows comes from HERE, pushed through the real render functions
// via the window.__preview hook each renderer exposes when it loads without
// Electron. One file, so the two harnesses cannot drift apart.
//
// Shapes mirror viewState.snapshot() plus the settings-only fields from
// index.js settingsSnapshot(). If a field is added there, add it here.

(function (root) {
  const T0 = Date.UTC(2026, 6, 31, 14, 19, 0); // 1419Z

  const PLACEHOLDER = 'img/frame-placeholder.svg';
  const item = (filename, selected = true) => ({ filename, url: PLACEHOLDER, selected });

  const batches = [
    {
      id: 3,
      sharedBy: 'JOKER 2-1',
      receivedAt: T0,
      count: 2,
      selectedCount: 2,
      items: [item('TGT-BRIDGE.JPG'), item('TGT-BRIDGE-IR.JPG')],
    },
    {
      id: 2,
      sharedBy: 'UZI 1-1',
      receivedAt: T0 - 21 * 60000, // 1358Z
      count: 3,
      selectedCount: 2,
      items: [item('SAM-SITE.JPG'), item('SAM-SITE-2.JPG', false), item('EGRESS-RTE.JPG')],
    },
    {
      id: 1,
      sharedBy: 'WILDCAT 3-2',
      receivedAt: T0 - 57 * 60000, // 1322Z
      count: 4,
      selectedCount: 4,
      items: [item('AAA-NEST.JPG'), item('AAA-NEST-2.JPG'), item('FARP-LZ.JPG'), item('FARP-LZ-ALT.JPG')],
    },
  ];

  const queueItems = batches.flatMap((b) =>
    b.items.filter((it) => it.selected).map((it) => ({
      batchId: b.id,
      filename: it.filename,
      url: it.url,
      sharedBy: b.sharedBy,
      receivedAt: b.receivedAt,
    })),
  );

  const photos = [
    { filename: '01-TARGET.JPG', selected: true, thumbUrl: PLACEHOLDER },
    { filename: '02-SECOND.JPG', selected: true, thumbUrl: PLACEHOLDER },
    { filename: '03-INGRESS.JPG', selected: false, thumbUrl: PLACEHOLDER },
    { filename: '04-EGRESS.JPG', selected: true, thumbUrl: PLACEHOLDER },
    { filename: '05-SAM-RING.JPG', selected: true, thumbUrl: PLACEHOLDER },
    { filename: '06-BDA.JPG', selected: false, thumbUrl: PLACEHOLDER },
  ];

  const peers = [
    { callsign: 'GHOSTRIDER 1-1', connectedAt: T0 - 80 * 60000, self: true, host: true },
    { callsign: 'JOKER 2-1', connectedAt: T0 - 65 * 60000, self: false, host: false },
    { callsign: 'UZI 1-1', connectedAt: T0 - 62 * 60000, self: false, host: false },
    { callsign: 'WILDCAT 3-2', connectedAt: T0 - 31 * 60000, self: false, host: false },
  ];

  const base = {
    callsign: 'GHOSTRIDER 1-1',
    isHost: true,
    connected: true,
    peers,
    relayLabel: 'gab-pc.tail9f2b.ts.net',
    lastContactAt: T0 + 12 * 60000, // 1431Z
    reconnect: null,

    page: 'brief',
    launcherOpen: false,
    chromeHidden: false,
    focused: true,
    autoShow: true,
    locale: 'en',
    banner: null,

    queue: { total: queueItems.length, pos: 0, current: queueItems[0] },
    batches,

    // Nobody is presenting in the default snapshot; the two brief scenarios
    // below override it. Shaped exactly like viewState's snapshot, `locked`
    // and `live` included, because those are derived there and the renderer
    // must never compute them itself.
    brief: {
      presenting: false,
      presenter: null,
      focusHash: null,
      tool: 'pen',
      cursor: null,
      inkRevs: {},
      live: false,
      locked: false,
      focusMissing: false,
    },

    folder: '/dcs/missions/roman-sead-joker1',
    photos,
    selectedCount: 4,
    photoCount: 6,
    stagedBytes: 1.4 * 1024 * 1024,
    profile: 'kneeboard',

    funnel: { installed: true, loggedIn: true, funnelOn: true, dnsName: 'gab-pc.tail9f2b.ts.net', since: T0 - 17 * 60000 },
    okb: { enabled: true, supported: true, installed: true, registered: true, connected: false, url: 'http://127.0.0.1:8788/viewer.html' },
    update: {
      supported: true, checking: false, available: true, downloading: false, downloaded: false,
      percent: 0, version: '0.9.0', error: null,
      notes: '0.9.0\n· Kneeboard cards: one page at 893x1263, paper palette\n· OpenKneeboard tab reaches the app over a loopback socket\n\n0.8.4\n· A follower\'s view belongs to the presenter',
    },
    counters: { sent: 12, received: 5, drops: 0 },
    logPath: '/home/pilot/.config/taclink/taclink.log',
    version: '0.4.0-preview',
  };

  const scenario = (over) => ({ ...base, ...over });

  const withLocale = (base, l) => {
    const out = {};
    for (const [k, v] of Object.entries(base)) out[k] = { ...v, locale: l };
    return out;
  };

  root.PreviewState = {
    withLocale,
    viewer: {
      queue: scenario({}),
      'queue mid': scenario({ queue: { total: queueItems.length, pos: 4, current: queueItems[4] } }),
      standby: scenario({ queue: { total: 0, pos: -1, current: null }, batches: [] }),
      'banner switched': scenario({ banner: { who: 'JOKER 2-1', count: 2, switched: true, at: T0 } }),
      'banner queued': scenario({ banner: { who: 'UZI 1-1', count: 3, switched: false, at: T0 } }),
      launcher: scenario({ launcherOpen: true }),
      // The two halves of a live brief. "following" is the one to look at
      // after touching the bar: a follower's controls are held, so the bar
      // carries no key at all and has to say who has them.
      presenting: scenario({
        brief: { ...base.brief, presenting: true, presenter: 'GHOSTRIDER 1-1', live: true },
      }),
      following: scenario({
        brief: { ...base.brief, presenter: 'JOKER 2-1', live: true, locked: true },
      }),
      received: scenario({ page: 'received' }),
      share: scenario({ page: 'share' }),
      fault: scenario({
        page: 'fault',
        connected: false,
        reconnect: { attempt: 3, nextInMs: 4000 },
      }),
    },
    settings: scenario({
      page: 'setup',
      relayPort: 8140,
      tokenMasked: '•••• KD93',
      squadCode: 'IB1-UFJFVklFVy1PTkxZLU5PVC1BLVJFQUwtQ09ERQ',
      hotkeys: { reveal: 'Ctrl+Shift+I', next: 'Ctrl+Shift+Right', prev: 'Ctrl+Shift+Left', hide: 'Ctrl+Shift+H', settings: 'Ctrl+Shift+O' },
      logTail: [
        '1432:07  RECV  GHOSTRIDER 1-1  5',
        '1429:44  SCAN  FOLDER  6 FILES',
        '1419:02  RECV  JOKER 2-1  2',
        '1402:11  FNNL  UP',
      ],
    }),
  };
})(typeof self !== 'undefined' ? self : globalThis);
