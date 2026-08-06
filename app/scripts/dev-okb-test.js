'use strict';

// OpenKneeboard integration — the parts that can be checked without Windows
// and without OpenKneeboard. Pure Node.
//
// Usage: node scripts/dev-okb-test.js
//
// BE CLEAR ABOUT WHAT THIS DOES NOT COVER. Nothing here has ever run against a
// real OpenKneeboard. It cannot: DCS and OpenKneeboard are Windows-only and
// development is on macOS. What it does cover is the half that is ours — the
// manifest shape, the version gate, the rule that we never write into
// OpenKneeboard's directories, and the one-page-for-the-stage decision that
// would be expensive to unpick later. The API calls themselves are unverified
// and the design handoff says so.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const okb = require('../src/main/okb');

// ---------------------------------------------------------------------------
// The version gate. "Probably fine" is how a pilot gets a blank tab.
// ---------------------------------------------------------------------------
{
  assert.strictEqual(okb.versionAtLeast('1.9.0', '1.9.0'), true);
  assert.strictEqual(okb.versionAtLeast('1.9.2', '1.9.0'), true);
  assert.strictEqual(okb.versionAtLeast('1.10.0', '1.9.0'), true, '1.10 is newer than 1.9, not older');
  assert.strictEqual(okb.versionAtLeast('2.0', '1.9.0'), true);
  assert.strictEqual(okb.versionAtLeast('1.8.9', '1.9.0'), false);
  assert.strictEqual(okb.versionAtLeast('1.8', '1.9.0'), false);
  assert.strictEqual(okb.versionAtLeast(null, '1.9.0'), false, 'unknown version is too old, not assumed fine');
  assert.strictEqual(okb.versionAtLeast('', '1.9.0'), false);
  assert.strictEqual(okb.versionAtLeast('garbage', '1.9.0'), false);
  console.log('[test] version gate, including the 1.10-vs-1.9 string trap');
}

// ---------------------------------------------------------------------------
// The manifest.
// ---------------------------------------------------------------------------
{
  const m = okb.pluginManifest({ version: '0.8.0', url: 'http://127.0.0.1:8788/viewer.html', tabName: 'Tac Link' });
  assert.strictEqual(m.ID, 'net.flyinggab.taclink');
  assert.ok(m.ID.includes('.'), 'a plugin id must be namespaced so it cannot collide');
  assert.strictEqual(m.Metadata.OKBMinimumVersion, okb.MIN_OKB_VERSION);
  // MaximumTested is a promise about what we ran against, and OpenKneeboard
  // parses it. 1.12.10 is where the plugin was confirmed to register and the
  // dashboard page confirmed to serve. Do not raise it any further without
  // running against that build.
  assert.strictEqual(m.Metadata.OKBMaximumTestedVersion, okb.MAX_TESTED_OKB_VERSION);
  assert.ok(
    okb.versionAtLeast(okb.MAX_TESTED_OKB_VERSION, okb.MIN_OKB_VERSION),
    'the maximum tested version cannot be older than the minimum supported one',
  );
  assert.strictEqual(m.TabTypes.length, 1, 'one tab type: the EFB');
  assert.strictEqual(m.TabTypes[0].ImplementationArgs.URI, 'http://127.0.0.1:8788/viewer.html');
  assert.strictEqual(m.TabTypes[0].Implementation, 'WebBrowser');

  // THE NAMESPACE SEPARATOR IS A SEMICOLON. A tab type ID starts with the
  // plugin ID plus ';', an action ID with its tab type ID plus ';'. This was
  // written with dots, which OpenKneeboard would not accept — and the old
  // version of this test split action IDs on '.' and took the last segment,
  // so it read `net.flyinggab.taclink.present` as "present" and passed. It
  // asserted our own mistake back at us.
  assert.strictEqual(m.TabTypes[0].ID, 'net.flyinggab.taclink;efb');
  const actionIds = m.TabTypes[0].CustomActions.map((a) => a.ID);
  for (const id of actionIds) {
    assert.ok(
      id.startsWith('net.flyinggab.taclink;efb;'),
      `an action ID must be prefixed with its tab type ID and a semicolon, got "${id}"`,
    );
  }

  // Every brief-mode control is bindable, because a pilot inside VR cannot
  // click one. `follow` is deliberately absent: a follower is held in the
  // presenter's brief until the presenter ends it, so there is nothing to
  // bind — see viewState.isFollower().
  const actions = actionIds.map((id) => id.split(';').pop());
  assert.ok(!actions.includes('follow'), 'follow is not a control any more');
  for (const need of ['present', 'clearInk']) {
    assert.ok(actions.includes(need), `${need} must be bindable as a custom action`);
  }
  console.log('[test] manifest: semicolon-namespaced tab and action ids, one tab, every control bindable');
}

// ---------------------------------------------------------------------------
// THE RULE THAT MATTERS: we never write into OpenKneeboard's directories.
// Their FAQ is explicit that it is unsupported and likely to break a pilot's
// setup on update. Worst case is corrupting someone's existing kneeboard.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'okb.js'), 'utf8');
  const forbidden = [
    /Program Files[\\/]+OpenKneeboard/i,
    /LOCALAPPDATA[\\%]*[\\/]+OpenKneeboard/i,
    /Saved Games/i,
    /Tabs\.json/i,
    /profiles/i,
  ];
  for (const pattern of forbidden) {
    // Comments naming these paths are the point — they say what NOT to do.
    // Strip them before checking for real usage.
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !pattern.test(code),
      `okb.js must not touch OpenKneeboard's own files (matched ${pattern})`,
    );
  }
  // Reads of their install location are fine and necessary; writes are not.
  // Call sites only — the `function regWrite(key, ...)` definition is not one.
  const writes = (src.match(/(?<!function )\breg(?:WriteDword|DeleteValue)\([^)]*\)/g) || []).filter(
    (w) => !/^\w+\(key[,)]/.test(w),
  );
  assert.ok(writes.length > 0, 'the test must actually find the write call sites it is policing');
  for (const w of writes) {
    assert.ok(
      w.includes('PLUGIN_KEY'),
      `the only registry key we ever write or delete is our own plugin key, got ${w}`,
    );
  }
  console.log('[test] we read OpenKneeboard\'s install location and write only our own plugin key');
}

// ---------------------------------------------------------------------------
// The registration contract itself. This is the one that was wrong, it failed
// completely silently — the plugin is simply never discovered and no tab ever
// appears — and nothing in this file noticed, because every assertion was
// about our own shape rather than theirs.
// ---------------------------------------------------------------------------
{
  assert.ok(
    /\\Plugins\\v1$/.test(okb.PLUGIN_KEY),
    'plugins are advertised under ...\\Plugins\\v1 — a SCHEMA version. ' +
      `Not a key named after our plugin id. Got "${okb.PLUGIN_KEY}"`,
  );
  assert.ok(
    !okb.PLUGIN_KEY.includes(okb.PLUGIN_ID),
    'the plugin id belongs in the manifest, never in the registry key path',
  );

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'okb.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    /REG_DWORD/.test(code),
    'the registration value is a REG_DWORD (1 = enabled). It was written as a REG_SZ path.',
  );
  assert.ok(
    !/'Path'/.test(code) && !/"Path"/.test(code),
    'there is no "Path" value: the value NAME is the full path to the manifest',
  );
  console.log('[test] registration contract: DWORD under Plugins\\v1, manifest path as the value name');
}

// ---------------------------------------------------------------------------
// EXCLUSIVITY. Registration is keyed by PATH, so every instance with its own
// user-data directory adds another entry for the same plugin ID: a dev
// checkout, a packaged install, and the two-PC script's temp dirs — which that
// script then deletes, leaving entries pointing at nothing. OpenKneeboard then
// sees several plugins all claiming net.flyinggab.taclink and stops offering
// the tab, which survives restarting it and therefore looks like anything
// except a registration problem.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okb-stale-'));
  const ours = path.join(dir, 'current', 'okb-plugin.json');
  fs.mkdirSync(path.dirname(ours), { recursive: true });
  fs.writeFileSync(ours, JSON.stringify(okb.pluginManifest({ version: '0.8.3', url: 'http://x', tabName: 'Tac Link' })));

  // An older instance of ours, still on disk. Identified BY ITS ID.
  const oldOurs = path.join(dir, 'old', 'okb-plugin.json');
  fs.mkdirSync(path.dirname(oldOurs), { recursive: true });
  fs.writeFileSync(oldOurs, JSON.stringify(okb.pluginManifest({ version: '0.1.0', url: 'http://y', tabName: 'Tac Link' })));
  assert.strictEqual(okb.isStaleOurs(oldOurs, ours), true, 'an older manifest of ours is stale');

  // Somebody else's plugin, on disk. NEVER ours to remove.
  const theirs = path.join(dir, 'them', 'their-plugin.json');
  fs.mkdirSync(path.dirname(theirs), { recursive: true });
  fs.writeFileSync(theirs, JSON.stringify({ ID: 'com.example.someone-else', TabTypes: [] }));
  assert.strictEqual(okb.isStaleOurs(theirs, ours), false, 'another vendor is never touched');

  // Dangling — the two-PC case. Unreadable, so identity cannot be checked and
  // only our own layout may be claimed.
  assert.strictEqual(
    okb.isStaleOurs(path.join(dir, 'gone', 'okb', 'okb-plugin.json'), ours),
    true,
    'a dangling entry in our own layout is ours to clean up',
  );
  assert.strictEqual(
    okb.isStaleOurs(path.join(dir, 'gone', 'someone-else', 'plugin.json'), ours),
    false,
    'a dangling entry that is not our layout is left alone',
  );

  // And we never delete the one we are about to write.
  assert.strictEqual(okb.isStaleOurs(ours, ours), false, 'our current registration is not stale');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('[test] registration is exclusive: our stale entries go, other vendors never do');
}

// ---------------------------------------------------------------------------
// The one-page decision, asserted against the bridge source. This is the
// cheapest possible guard on a choice that is expensive to unpick: if someone
// later reaches for RequestPageChanged to sync the stage, this fails and says
// why.
// ---------------------------------------------------------------------------
{
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'okb-bridge.js'), 'utf8');
  const code = bridge.replace(/^\s*\/\/.*$/gm, '');

  assert.ok(
    !/RequestPageChanged\s*\(/.test(code),
    'The intel stage must be ONE OpenKneeboard page with images swapping inside our DOM. ' +
      'RequestPageChanged is the call their docs warn may stop working unless it follows a ' +
      'local cursor event within 100ms — which a FOCUS message off the relay never does. ' +
      'Calling it for stage sync means brief mode breaks silently on someone else\'s update.',
  );
  assert.ok(
    !/DoodlesOnly/.test(code),
    'DoodlesOnly is OpenKneeboard\'s own draw-on-top: those strokes are LOCAL and never reach ' +
      'the relay, and it disables mouse emulation so the page stops being interactive. ' +
      'Brief-mode ink must be our canvas under MouseEmulation.',
  );
  assert.ok(/MouseEmulation/.test(code), 'the cursor mode we DO want must be set');
  assert.ok(/data-surface|dataset\.surface/.test(bridge), 'the third surface value must be set');
  console.log('[test] the stage stays one page, ink stays ours, the third surface is declared');
}

// ---------------------------------------------------------------------------
// Off Windows everything reports "not found" rather than throwing. An
// unguarded native require took the whole app down once already.
// ---------------------------------------------------------------------------
{
  (async () => {
    const p = await okb.probe();
    if (process.platform === 'win32') {
      assert.strictEqual(p.supported, true);
      console.log(`[test] on Windows: installed=${p.installed} version=${p.version || '(none)'}`);
    } else {
      assert.strictEqual(p.supported, false, 'unsupported platforms say so plainly');
      assert.strictEqual(p.installed, false);
      assert.strictEqual(p.registered, false);
      console.log(`[test] on ${process.platform} the probe degrades quietly instead of throwing`);
    }

    // register() writes only into the directory it is given.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taclink-okb-'));
    try {
      const { file } = await okb.register({ dir, version: '0.8.0', url: 'http://127.0.0.1:8788/viewer.html' });
      assert.ok(file.startsWith(dir), 'the manifest lands in OUR directory and nowhere else');
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(written.ID, okb.PLUGIN_ID);
      assert.strictEqual(fs.readdirSync(dir).length, 1, 'exactly one file is written');
      console.log('[test] register() writes one manifest, inside the directory it was given');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // -----------------------------------------------------------------------
    // The dashboard server. It binds loopback and serves a fixed set of static
    // files; anything that could turn it into a way onto this machine, or into
    // a reader of arbitrary files, is a real problem rather than a style one.
    // -----------------------------------------------------------------------
    const { resolveSafe, RENDERER_DIR } = require('../src/main/okbServer');

    assert.ok(resolveSafe('/viewer.html'), 'the EFB itself resolves');
    assert.ok(resolveSafe('/'), 'the root serves the viewer');
    assert.ok(resolveSafe('/css/components.css'), 'stylesheets resolve');

    for (const attack of [
      '/../../../../etc/passwd',
      '/..%2f..%2f..%2fetc%2fpasswd',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/....//....//etc/passwd',
      '/viewer.html%00.png',
      '/../package.json',
      '/../../resources/config.local.json',
    ]) {
      const got = resolveSafe(attack);
      if (got !== null) {
        assert.ok(
          path.relative(RENDERER_DIR, got).startsWith('..') === false,
          `traversal escaped the renderer directory: ${attack} -> ${got}`,
        );
      }
    }
    // The property that matters is CONTAINMENT, not that traversal returns
    // null: `path.posix.normalize` strips leading `..` above root, so
    // "/../../resources/config.local.json" resolves to a path INSIDE the
    // renderer directory which simply does not exist and 404s. Either
    // outcome is safe; escaping the directory is not.
    //
    // Checked explicitly because config.local.json holds the token, and the
    // token IS the squad password.
    const realConfig = path.join(__dirname, '..', 'resources', 'config.local.json');
    for (const attack of ['/../../resources/config.local.json', '/../src/main/index.js', '/../../package.json']) {
      const got = resolveSafe(attack);
      if (got === null) continue;
      assert.ok(
        !path.relative(RENDERER_DIR, got).startsWith('..'),
        `${attack} escaped the renderer directory`,
      );
      assert.notStrictEqual(path.resolve(got), path.resolve(realConfig), 'the squad token is never servable');
    }
    assert.strictEqual(resolveSafe('/viewer.exe'), null, 'unknown extensions are refused');
    console.log('[test] dashboard server: loopback-only, no traversal, no config, known types only');

    // -----------------------------------------------------------------------
    // THE TRANSPORT. Without it a dashboard tab renders the empty shipped
    // markup and sits on STANDBY no matter what the app is doing — which is
    // exactly what it did, because nothing here exercised it. WebView2 has no
    // Electron preload, so state, intents and photos all have to cross on
    // this server or they do not cross at all.
    // -----------------------------------------------------------------------
    const { createOkbServer } = require('../src/main/okbServer');
    const WebSocket = require('ws');
    const crypto = require('crypto');

    const bytes = Buffer.from('not really a jpeg, but content-addressed all the same');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const fakeBlobs = { get: (h) => (h === hash ? { buffer: bytes, mimeType: 'image/jpeg' } : null) };

    const intents = [];
    const PORT = require('./dev-ports').okbTransport || 8799;
    const srv = createOkbServer({
      port: PORT,
      onLog: () => {},
      blobs: fakeBlobs,
      onIntent: (intent, payload) => intents.push({ intent, payload }),
      getSnapshot: () => ({ page: 'brief', queue: { total: 1 } }),
    });
    await new Promise((r) => srv.server.once('listening', r));

    const get = (p) =>
      new Promise((resolve) => {
        require('http').get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
        });
      });

    const blobRes = await get(`/blob/${hash}`);
    assert.strictEqual(blobRes.status, 200, 'a photo must be reachable by content hash');
    assert.ok(blobRes.body.equals(bytes), 'and the bytes must be the ones we stored');
    assert.strictEqual(blobRes.headers['content-type'], 'image/jpeg');

    assert.strictEqual((await get(`/blob/${'0'.repeat(64)}`)).status, 404, 'an unknown hash is 404, not an error');
    // The blob route takes a HASH, never a path: there is nothing to traverse.
    assert.strictEqual((await get('/blob/../../package.json')).status, 404);
    assert.strictEqual((await get('/blob/short')).status, 404);

    // State down.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const opening = await new Promise((resolve, reject) => {
      ws.once('message', (d) => resolve(JSON.parse(d.toString())));
      ws.once('error', reject);
      setTimeout(() => reject(new Error('no opening snapshot within 3s')), 3000);
    });
    assert.strictEqual(opening.type, 'state');
    assert.strictEqual(opening.snapshot.page, 'brief', 'a tab added mid-flight is sent the CURRENT state');

    // Intents up, into the same door the window uses.
    ws.send(JSON.stringify({ type: 'intent', intent: 'step', payload: 1 }));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(intents, [{ intent: 'step', payload: 1 }], 'the tab must be able to drive the app');

    // Garbage must not take the server down with it.
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'nonsense' }));
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(intents.length, 1, 'unparseable and unknown frames are dropped, not dispatched');

    // ...and later pushes reach an already-open tab.
    const pushed = new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
    srv.pushState({ page: 'received' });
    assert.strictEqual((await pushed).snapshot.page, 'received', 'state changes must reach an open tab');

    ws.close();
    await new Promise((r) => srv.close(r));
    console.log('[test] transport: blobs by hash, state down, intents up, junk dropped');

    console.log('[dev-okb-test] PASS');
  })().catch((err) => {
    console.error(`[dev-okb-test] FAIL: ${err.message}`);
    process.exit(1);
  });
}
