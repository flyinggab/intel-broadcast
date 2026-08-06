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

// Where OpenKneeboard records its own install location, and where third-party
// plugins are advertised. Reads only — see rule 2 above.
const OKB_KEY = 'HKCU\\Software\\Fred Emmott\\OpenKneeboard';
const PLUGIN_KEY = `HKCU\\Software\\Fred Emmott\\OpenKneeboard\\Plugins\\${PLUGIN_ID}`;

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

function regWrite(key, valueName, value) {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve(false);
    execFile('reg', ['add', key, '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true }, (err) =>
      resolve(!err),
    );
  });
}

function regDelete(key) {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve(false);
    execFile('reg', ['delete', key, '/f'], { windowsHide: true }, (err) => resolve(!err));
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
        ID: `${PLUGIN_ID}.efb`,
        Name: tabName,
        Glyph: '',
        CustomActions: [
          { ID: `${PLUGIN_ID}.present`, Name: 'Present' },
          { ID: `${PLUGIN_ID}.clearInk`, Name: 'Clear ink' },
        ],
        Implementation: 'WebBrowser',
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
  const version = await regQuery(OKB_KEY, 'Version');
  const registeredPath = await regQuery(PLUGIN_KEY, 'Path');

  return {
    platform: 'win32',
    supported: true,
    installed: Boolean(binPath),
    version,
    versionOk: versionAtLeast(version, MIN_OKB_VERSION),
    // Registered means the value is there AND points at the file we would
    // write. A stale path from an older install is not registered.
    registered: Boolean(registeredPath && pluginPath && path.resolve(registeredPath) === path.resolve(pluginPath)),
    connected,
  };
}

/**
 * Writes the manifest into OUR directory and points the registry at it.
 *
 * `dir` must be somewhere we own — never anywhere under OpenKneeboard.
 */
async function register({ dir, version, url, tabName = 'Tac Link' }) {
  const file = path.join(dir, 'okb-plugin.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(pluginManifest({ version, url, tabName }), null, 2));
  const ok = await regWrite(PLUGIN_KEY, 'Path', file);
  return { file, ok };
}

/** Removes the registry entry. The JSON stays: it is ours, it is inert, and
 *  deleting files on a toggle-off is more surprising than leaving one. */
async function unregister() {
  return regDelete(PLUGIN_KEY);
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
};
