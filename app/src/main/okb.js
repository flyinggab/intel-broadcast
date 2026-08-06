'use strict';

// OpenKneeboard integration — the web-dashboard tab path.
// See design/okb-integration/HANDOFF.md.
//
// Today OpenKneeboard *window-captures* the EFB. From v1.9 it can also render
// a web page directly in WebView2 with a JavaScript API. The EFB is already a
// web app, so this is a supported, native path: better text, one-click setup,
// HOTAS page turns and pen input, with no C++ and no config-file tampering.
//
// THIS IS A TOGGLE, NOT A MIGRATION. Window capture keeps working and stays
// the default. Turning this on registers our plugin and starts serving the
// page; turning it off unregisters cleanly. A pilot must always be able to go
// back, and nothing about the existing path changes.
//
// TWO HARD RULES, both from OpenKneeboard's own docs:
//
//   1. NEVER write into a directory that belongs to OpenKneeboard — not
//      Program Files, not %LOCALAPPDATA%\OpenKneeboard, not Saved Games. Our
//      plugin JSON lives in OUR install directory and a registry value points
//      at it. That registry entry is the sanctioned mechanism for exactly our
//      case: a third-party program with locally running software.
//   2. NEVER read or write OpenKneeboard's configuration. Their FAQ is
//      explicit that it is unsupported and likely to break a pilot's setup on
//      update. Worst case here is corrupting someone's existing kneeboard.
//
// Windows-only, and it degrades the same way keyHook.js does: on macOS every
// probe simply reports "not found" and the SETUP panel says so, rather than
// the module throwing at require time and taking the app down (which is
// exactly what an unguarded native require did once already).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// The version that introduced web dashboards and the JS API. Below this the
// panel should say which version is needed rather than failing obscurely.
const MIN_OKB_VERSION = '1.9.0';

// Must never collide with anyone else's plugin, ever.
const PLUGIN_ID = 'net.flyinggab.taclink';

// Where OpenKneeboard records its own install location. Reads only — rule 2.
const OKB_KEY = 'HKCU\\Software\\Fred Emmott\\OpenKneeboard';

// Where third-party plugins are advertised, and the shape is unusual enough
// to be worth spelling out, because getting it wrong is silent: the plugin is
// simply never discovered and the tab never appears in OpenKneeboard's list.
//
//   key    …\OpenKneeboard\Plugins\v1     <- a SCHEMA version, not our ID
//   name   C:\…\okb-plugin.json           <- the value NAME is the full path
//   type   REG_DWORD
//   data   1 = enabled, 0 = disabled
//
// This was first implemented as a REG_SZ "Path" under a key named after our
// plugin ID, which is a location OpenKneeboard never reads.
const PLUGIN_KEY = 'HKCU\\Software\\Fred Emmott\\OpenKneeboard\\Plugins\\v1';

// Tab types and custom actions are namespaced with SEMICOLONS, not dots: a tab
// type ID starts with the plugin ID plus ';', and an action ID starts with its
// tab type ID plus ';'. The dots in PLUGIN_ID are part of the reverse-domain
// name and carry no structure.
const TAB_TYPE_ID = `${PLUGIN_ID};efb`;
const ACTION_PRESENT = `${TAB_TYPE_ID};present`;
const ACTION_CLEAR_INK = `${TAB_TYPE_ID};clearInk`;

const isWindows = () => process.platform === 'win32';

/** `reg query` as a promise. Resolves null rather than throwing: a missing
 *  key is the normal answer on a machine without OpenKneeboard. */
function regQuery(key, valueName) {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve(null);
    execFile('reg', ['query', key, '/v', valueName], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // reg's output is `    <name>    REG_SZ    <value>` — take everything
      // after the type, since a path can contain spaces.
      const m = /REG_[A-Z_]+\s+(.+?)\s*$/m.exec(stdout);
      resolve(m ? m[1].trim() : null);
    });
  });
}

function regWriteDword(key, valueName, value) {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve(false);
    execFile(
      'reg',
      ['add', key, '/v', valueName, '/t', 'REG_DWORD', '/d', String(value), '/f'],
      { windowsHide: true },
      (err) => resolve(!err),
    );
  });
}

/** Deletes one VALUE, not the key: `…\Plugins\v1` is shared with every other
 *  third party's plugin, so removing the key would unregister theirs too. */
function regDeleteValue(key, valueName) {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve(false);
    execFile('reg', ['delete', key, '/v', valueName, '/f'], { windowsHide: true }, (err) => resolve(!err));
  });
}

/** Whether `valueName` under `key` exists and is a non-zero DWORD. `reg query`
 *  prints DWORDs as `0x1`, so parse rather than string-compare. */
function regDwordIsSet(key, valueName) {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve(false);
    execFile('reg', ['query', key, '/v', valueName], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(false);
      const m = /REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(stdout);
      resolve(Boolean(m) && parseInt(m[1], 16) !== 0);
    });
  });
}

/** "1.9.2" >= "1.9.0". Missing or unparseable compares as too old, because
 *  guessing "probably fine" is how a pilot ends up with a blank tab. */
function versionAtLeast(have, want) {
  if (!have) return false;
  const a = String(have).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(want).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

/**
 * The plugin manifest. One web-dashboard tab pointing at the page we serve.
 *
 * Version numbers are pinned deliberately: the API is young and moving, and
 * OKBMaximumTestedVersion is a promise about what we actually ran against.
 * Do not raise it without running against that version.
 */
function pluginManifest({ version, url, tabName }) {
  return {
    ID: PLUGIN_ID,
    Metadata: {
      PluginName: 'Tac Link',
      PluginReadableVersion: version,
      PluginSemanticVersion: version,
      OKBMinimumVersion: MIN_OKB_VERSION,
      // Honest until a real OpenKneeboard has been tested against: the
      // minimum IS the maximum tested, because nothing has been tested.
      OKBMaximumTestedVersion: MIN_OKB_VERSION,
    },
    TabTypes: [
      {
        ID: TAB_TYPE_ID,
        Name: tabName,
        Glyph: '',
        CustomActions: [
          { ID: ACTION_PRESENT, Name: 'Present' },
          { ID: ACTION_CLEAR_INK, Name: 'Clear ink' },
        ],
        Implementation: 'WebBrowser',
        // No InitialSize yet: it is optional and its exact field shape has not
        // been confirmed against a real build. An unknown key here risks the
        // whole manifest being rejected, which looks exactly like the bug this
        // change fixes.
        ImplementationArgs: { URI: url },
      },
    ],
  };
}

/**
 * Everything the SETUP panel needs, in one object.
 *
 * The step order mirrors the Tailscale panel exactly, and for the same reason:
 * only the LAST step is ground truth. 01-03 exist to explain why 04 has not
 * happened. `connected` is the one that actually matters — it means a
 * WebView2 running our page has said hello.
 */
async function probe({ pluginPath = null, connected = false } = {}) {
  if (!isWindows()) {
    return {
      platform: process.platform,
      supported: false,
      installed: false,
      version: null,
      versionOk: false,
      registered: false,
      connected,
    };
  }

  const binPath = await regQuery(OKB_KEY, 'InstallationBinPath');
  // Registered means OUR path is present as a value name, enabled. There is
  // no path comparison to do any more: the path IS the name, so a stale entry
  // from an older install location is simply a different value.
  const registered = pluginPath ? await regDwordIsSet(PLUGIN_KEY, path.resolve(pluginPath)) : false;

  return {
    platform: 'win32',
    supported: true,
    installed: Boolean(binPath),
    // Deliberately not read from the registry. There is no `Version` value on
    // a real install — the nearest thing is `AppVersionAtLastBackup`, which is
    // what its name says and would be a lie here. `OpenKneeboard.GetVersion()`
    // from inside the page is the only reliable answer, so the version is
    // unknown until a WebView2 has connected and told us.
    version: null,
    versionOk: null,
    registered,
    connected,
  };
}

/**
 * Writes the manifest into OUR directory and points the registry at it.
 *
 * `dir` must be somewhere we own — never anywhere under OpenKneeboard.
 */
async function register({ dir, version, url, tabName = 'Tac Link' }) {
  const file = path.resolve(path.join(dir, 'okb-plugin.json'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(pluginManifest({ version, url, tabName }), null, 2));
  // The file's own path is the value NAME; the data is just the enabled flag.
  const ok = await regWriteDword(PLUGIN_KEY, file, 1);
  return { file, ok };
}

/** Removes our value from the shared plugin key. The JSON stays: it is ours,
 *  it is inert, and deleting files on a toggle-off is more surprising than
 *  leaving one. */
async function unregister({ dir } = {}) {
  if (!dir) return false;
  return regDeleteValue(PLUGIN_KEY, path.resolve(path.join(dir, 'okb-plugin.json')));
}

module.exports = {
  probe,
  register,
  unregister,
  pluginManifest,
  versionAtLeast,
  isWindows,
  MIN_OKB_VERSION,
  PLUGIN_ID,
  PLUGIN_KEY,
  OKB_KEY,
  TAB_TYPE_ID,
  ACTION_PRESENT,
  ACTION_CLEAR_INK,
};
