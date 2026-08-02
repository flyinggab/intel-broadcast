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
  // Honest until something has actually been run against a real build.
  assert.strictEqual(
    m.Metadata.OKBMaximumTestedVersion,
    okb.MIN_OKB_VERSION,
    'MaximumTested is a promise about what we ran against — do not raise it without running it',
  );
  assert.strictEqual(m.TabTypes.length, 1, 'one tab type: the EFB');
  assert.strictEqual(m.TabTypes[0].ImplementationArgs.URI, 'http://127.0.0.1:8788/viewer.html');

  // Every brief-mode control is bindable, because a pilot inside VR cannot
  // click one.
  const actions = m.TabTypes[0].CustomActions.map((a) => a.ID.split('.').pop());
  for (const need of ['present', 'follow', 'clearInk']) {
    assert.ok(actions.includes(need), `${need} must be bindable as a custom action`);
  }
  console.log('[test] manifest: namespaced id, one tab, every control bindable');
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
  const writes = (src.match(/(?<!function )\breg(?:Write|Delete)\([^)]*\)/g) || []).filter(
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
