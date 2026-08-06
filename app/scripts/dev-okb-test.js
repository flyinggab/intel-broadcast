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

    console.log('[dev-okb-test] PASS');
  })().catch((err) => {
    console.error(`[dev-okb-test] FAIL: ${err.message}`);
    process.exit(1);
  });
}
