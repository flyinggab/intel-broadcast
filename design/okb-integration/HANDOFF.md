# OpenKneeboard integration — native web dashboard, instead of window capture

**Status** — **partly built, and the built part cannot work.** Phase 2/3.

Verified on 2026-08-06 against the live API docs and against the owner's
Windows machine. That check found the registration contract was implemented
from a wrong reading, which is why "add a tab in OpenKneeboard" shows nothing:
OpenKneeboard never discovers the plugin. See §0.

Built: `main/okb.js` (registry probe, plugin manifest, register/unregister),
`main/okbServer.js` (loopback static server), `renderer/okb-bridge.js`
(detection, `data-surface="okb"`, `SetPages`, `MouseEmulation`, custom
actions), config toggle `okb.enabled` default **off**, and `dev-okb-test`.

Not built, and this is the real work: **the page has no way to reach the app.**
`okbServer.js` serves static files only, and `okb-bridge.js` sends intents
through `window.viewerAPI` — the *Electron preload*, which does not exist in
WebView2. So the dashboard tab today would render the shipped empty markup and
nothing else: no snapshots, no intents, no photos. §5 is the answer.

Owner's environment, read from the registry on 2026-08-06:

| | |
|---|---|
| OpenKneeboard | **v1.12.10+gha.2882** — far past every gate below |
| `…\OpenKneeboard\Plugins\v1` | absent; nothing of ours registered |
| `okb.enabled` | unset → off, so `startOkb()` has never run |

Sources — re-read before starting, this API is young and moving:
- <https://openkneeboard.com/api/web-dashboards/> ·
  `/api/web-dashboards/page-based-content/` · `/api/web-dashboards/plugins/`
- <https://openkneeboard.com/faq/third-party-developers/>
- <https://openkneeboard.com/changelog/> — check version gates every time

---

## 0. What is wrong in the shipped code

Found by reading the live docs against `okb.js` / `okb-bridge.js`. None of it
has ever run, which is exactly how all five survived. Fix these before
anything else; until §0.1 is right, nothing else is observable.

**0.1 The registry contract is wrong — this is the one that hides the tab.**

```
we write   HKCU\…\OpenKneeboard\Plugins\net.flyinggab.taclink
             Path  REG_SZ  C:\…\okb-plugin.json

docs say   HKCU\…\OpenKneeboard\Plugins\v1
             C:\…\okb-plugin.json   REG_DWORD   1
```

The value **name** is the full path to the JSON, the **data** is `0`/`1`
(disabled/enabled), the type is DWORD, and the container key is `…\Plugins\v1`
— a schema version, not our plugin ID. `HKLM` works too. Our key is in a
location OpenKneeboard never reads.

**0.2 Tab-type and custom-action IDs are joined with `;`, not `.`.** The docs
require a tab type ID to start with the plugin ID *followed by a semicolon*,
and a custom action ID to be prefixed with its tab type ID and a semicolon:

```
net.flyinggab.taclink;efb
net.flyinggab.taclink;efb;present
```

We emit `net.flyinggab.taclink.efb` and `net.flyinggab.taclink.present`.
`okb-bridge.js` matches with `id.endsWith('.present')` and has to move with it.

**0.3 The experimental-feature gates are placeholders.** We send
`{ Name: 'PageBasedContent', Version: 2021 }`. Both the key case and the
number are wrong; the docs use lowercase keys and dated versions:

| feature | version | needs |
|---|---|---|
| `PageBasedContent` | `2024073001` | v1.9+ |
| `SetCursorEventsMode` | `2024071801` | v1.9+ |
| `GraphicsTabletInfo` | `2025012901` | v1.9.15+ |

**0.4 `SetPages` is called unconditionally.** The docs are explicit: call
`GetPages()` first and only call `SetPages()` when it reports no pre-existing
pages, so that multiple browser instances stay consistent. We also pass
`pixelSize: null`; it must be integers ≥ 1.

**0.5 The version probe reads a value that does not exist.**
`regQuery(OKB_KEY, 'Version')` returns null on a real install — the owner's
registry has `SettingsPath`, `InstallationBinPath`,
`InstallationUtilitiesPath`, `AppVersionAtLastBackup`, and no `Version`. Use
`OpenKneeboard.GetVersion()` from inside the page (v1.9+) as ground truth, and
treat the registry as presence-detection only. `AppVersionAtLastBackup` is
what its name says and must not be used as the installed version.

One thing the code got **right** and must stay right: the manifest is written
to `app.getPath('userData')/okb`, which is the third-party LocalAppData
location the docs recommend, and never into any OpenKneeboard directory.

---

## 1. What the API gives us

Requires **v1.9+**; the owner runs 1.12.10, so no gate below is a constraint
in practice — but keep the gates, because a squadmate may not.

| capability | what it buys |
|---|---|
| Web Dashboard tab (`Implementation: "WebBrowser"`) | WebView2 renders the EFB natively — no capture, no resample |
| `SetPages` / `GetPages` / `pageChanged` / `pagesChanged` | our pages become OKB pages, turned by the pilot's existing HOTAS binding |
| `RequestPageChange(guid)` | ask to navigate — "might or might not" be honoured |
| `SetCursorEventsMode("MouseEmulation")` | pen/cursor input into our DOM, no OTD-IPC, no injection |
| `SetPreferredPixelSize(w, h)` | v1.8+; v1.9+ returns a Promise |
| `GetVersion()` | v1.9+; the only reliable version answer |
| `OpenDeveloperToolsWindow()` | v1.9+; Edge devtools on the tab — the debugging story for §5 |
| Plugin JSON via registry | "Tac Link" appears in OKB's own tab-type list |
| `CustomActions` | HOTAS/StreamDeck-bindable, delivered as a `plugin/tab/customAction` DOM event with optional JSON payload |

**Detection inside the page:** `window.OpenKneeboard` exists and is valid; the
user agent contains `OpenKneeboard/a.b.c.d`. The docs' own idiom is
`if (window.OpenKneeboard?.SetPreferredPixelSize)`. The old `<body>` CSS
classes were removed in v1.9 — do not rely on them.

## 2. What it does NOT give us

- Quad size and position stay OpenKneeboard's. The legibility maths in
  `design/kneeboard/HANDOFF.md` §2 stays theirs to set. **This remains the only
  real argument for `design/xr-layer/`** — and it is a smaller argument than
  "replace OpenKneeboard".
- We render inside their process and inherit their frame timing.
- The maintainer describes a trust-first stance and says restrictions are
  likely if the APIs are misused. Design for that — see §4.

## 3. Plugin registration

A plugin is a JSON file defining custom tab types, discovered through the
Windows registry — the sanctioned mechanism for a third-party program with
locally running software, which is exactly us.

```jsonc
{
  "ID": "net.flyinggab.taclink",           // must not collide, ever
  "Metadata": {
    "PluginName": "Tac Link",
    "PluginReadableVersion": "0.8.3",
    "PluginSemanticVersion": "0.8.3",
    "OKBMinimumVersion": "1.9.0",
    "OKBMaximumTestedVersion": "1.12.10"   // ONLY what we actually ran against
  },
  "TabTypes": [{
    "ID": "net.flyinggab.taclink;efb",     // plugin ID + SEMICOLON
    "Name": "Tac Link",
    "Implementation": "WebBrowser",
    "ImplementationArgs": { "URI": "…", "InitialSize": { "Width": 1024, "Height": 1448 } },
    "CustomActions": [
      { "ID": "net.flyinggab.taclink;efb;present",  "Name": "Present" },
      { "ID": "net.flyinggab.taclink;efb;clearInk", "Name": "Clear ink" }
    ]
  }]
}
```

The plugin `ID` must be stable and owned — the docs explicitly forbid UUIDs
generated at install time or when writing the file. Ours is a reverse-domain
constant; keep it that way.

**Hard rules, from their docs, unchanged:**
- The JSON MUST NOT live in `C:\Program Files\OpenKneeboard`, OpenKneeboard's
  LocalAppData, or `Saved Games\OpenKneeboard`. Ours lives in our own
  LocalAppData (`userData/okb`), which is what they recommend.
- Never read or write OpenKneeboard's configuration. Their FAQ says it is
  unsupported and likely to break a pilot's setup on update. The registry
  entry is the sanctioned path to the same outcome — use it and nothing else.

## 3b. When OpenKneeboard notices — and why a reboot really did seem necessary

OpenKneeboard reads `…\Plugins\v1` **at startup** (`Loading plugin `{}` from
registry...` in `OpenKneeboardApp.exe`). So registering a plugin for the first
time needs one genuinely fresh OpenKneeboard process. Nothing else does: the
registry entry outlives Tac Link quitting, so the tab type stays in the list,
and content flows over the socket (§5).

**"Restarting OpenKneeboard" often is not one.** It is single-instance, and
launching it while an instance is alive does not start a new one — it switches
to the existing window. Its own strings say so:

```
OpenKneeboard is already running, but can't find the existing window to switch to it.
OpenKneeboard is already running, but unable to switch to the existing window.
```

It tracks the live instance in `%LOCALAPPDATA%\OpenKneeboard\instance.txt`
(PID, HWND, mailslot), and it is not one process but `OpenKneeboardApp` plus
about five `OpenKneeboard-Chromium` helpers. Close the window and relaunch
promptly and you re-attach to the instance still tearing down — the plugin
registry is never re-read, and the tab never appears. A reboot is the one thing
that reliably produces a fresh process, which is why the owner hit "it only
works after a reboot" twice and was right both times.

The procedure that works without rebooting: quit OpenKneeboard, wait until
**no** process matching `OpenKneeboard*` remains, then start it.

**A second, independent cause with the same symptom** — fixed, but worth
knowing because it also survives restarting OpenKneeboard. Registration is
keyed by PATH, so before the exclusivity fix every instance with its own
user-data directory added *another* entry for the same plugin ID: a dev
checkout, a packaged install, and the two-PC script's temp dirs, which that
script deletes on exit and which therefore pointed at nothing. OpenKneeboard
then sees several plugins claiming one ID, some unreadable, and stops offering
the tab. `register()` is exclusive now; `dev-two-pcs` no longer registers at
all.

**Do not explain a symptom with a timeline you did not observe.** The first
theory here was that the reboots were coincidence — the first OKB start after
the registry happened to be clean. The timestamps were consistent with it and
it was wrong, because the owner had restarted OpenKneeboard after the fix and
said so. Their observation was the evidence; the inference was not.

## 4. The page-mapping decision — settled, and now confirmed

**The problem.** Presenter-driven page turns are remote-driven by definition,
and the docs both hedge `RequestPageChange` ("might or might not honor the
request") and forbid using pages as a generic input channel.

**The decision: split the page mapping.**

| surface | mapping |
|---|---|
| Card pages (PLAN / CARD / MAP) | real OKB pages via `SetPages` — small, static, user-driven. HOTAS page-turn works. |
| Intel stage / brief | **exactly one** OKB page. Images swap inside our DOM. |

The presenter changes what is *rendered within* one page, so OpenKneeboard
never sees a page change and `RequestPageChange` is never called for sync. The
live docs strengthen this: you **MUST NOT** create pages in response to page
changes, and must not treat a page as changed until `pageChanged` fires.
Breaking those risks "crashes, undefined behavior". Our intel queue is dozens
deep and changes constantly — mapping it to pages was never viable.

**Related traps:**

- **Never use `DoodlesOnly` for brief mode.** It is OpenKneeboard's own
  draw-on-top: those strokes are *local* and would never reach the relay, and
  it disables mouse emulation entirely so the page stops being interactive.
  Brief-mode ink must be **our** canvas under `MouseEmulation`.
- **Two renderers of one state.** The Electron window and the WebView2 tab
  both receive snapshots. That is the same shape as any two clients, but
  anything assuming a single renderer needs auditing, and `PANEL_PROBE` should
  report which surface it is.
- **Does OKB suspend a tab that is not active?** Unknown, and it decides
  whether a follower misses FOCUS while the pilot is on their charts tab.
  `okb-bridge.js` already re-syncs on `visibilitychange`; the spike must
  confirm that is the right signal and that a resync path exists rather than
  being discovered in the air.
- `data-surface` gains its third value (`window`, `okb`, later `xr`). The
  chrome-hiding CSS is already scoped by it — this is what it was for.

## 5. The transport — the actual missing piece

The page runs in WebView2, not Electron. It therefore has **no preload, no
`window.viewerAPI`, and no `intel://` protocol**. Three things have to cross
that boundary, and the loopback server is the only bridge.

**State — a WebSocket on the same loopback server.** `pushState` already fans
a snapshot to the Electron window; it gains a second sink. The payload is
identical, so the renderer stays a pure function of the snapshot and nothing
about the Electron path changes.

**Intents — the same socket, upward.** Messages land in the existing
`handleViewerIntent` / `handleSettingsIntent` switches. Anything sent from the
OKB surface must go through the same door as the window's IPC, or the two
surfaces will drift — and note the trap `HANDOFF.md` §6 already records: those
are *two* switches, and a settings-shaped intent in the viewer one fails
silently as `unknown intent`.

**Photos — `GET /blob/<sha256>` off the blob store.** Content-hash keyed, the
same bytes `intel://` serves.

The URL rewrite belongs in **main, per transport**, not in the renderer:
main knows which sink it is pushing to, so it maps `intel://blob/<hash>` to
`/blob/<hash>` on the way out to the OKB socket. One place, no renderer
change, and no surface-sniffing in `viewer.js`. (The alternative — snapshots
carrying bare hashes and each surface composing its own URL — is cleaner in
the abstract and touches every render path; not worth it for one consumer.)

**Keep what `dev-okb-test` already asserts:** loopback-only, no path
traversal, no config reads, known content types only. Blob serving must not
widen any of those; serve only by 64-hex hash, never by a caller-supplied
path.

**Origin and stability.** The tab URI is saved by OpenKneeboard when the pilot
adds the tab, so it must survive a restart: the port and any token have to be
**stable and persisted in config**, not generated per session. A per-launch
token would silently break the pilot's saved tab on the next flight.

## 6. Toggle and guided setup

**Toggle.** SETUP · KNEEBOARD, default **ON** *(changed 2026-08-06 by the
owner; it shipped off)*. Window capture keeps working untouched either way, so
"on" costs a pilot a loopback server and a registry value and gains them the
tab in OpenKneeboard's own list without hunting for a setting. Turning it off
unregisters cleanly and a pilot can always go back — that part is unchanged and
is what makes defaulting to on defensible.

Built, in `settings.js` `renderOkb()`: the toggle plus three status rows
(OpenKneeboard found / plugin offered / tab). Row 03 does NOT claim to detect
the tab — that needs a WebView2 talking back to us, i.e. §5 — so it says what
the pilot must do instead of reporting a guess.

**Guided steps — mirror `tailscale.js` + the NETWORK panel exactly.** Read
`main/tailscale.js` and `renderer/settings/settings.js` first; copy the shape,
not just the look.

```
01  OPENKNEEBOARD FOUND     InstallationBinPath in HKCU
02  PLUGIN REGISTERED       our path present under …\Plugins\v1, DWORD 1
03  TAB ADDED BY THE PILOT  window.OpenKneeboard has connected to us   <- ground truth
04  VERSION                 reported by GetVersion() once connected
```

Note the reorder against the earlier draft: the version check moved **after**
connection, because §0.5 showed there is no reliable version in the registry to
gate on beforehand. Do not block setup on a number we cannot read.

Two conventions from the shipped NETWORK panel that must carry over:

- **Steps are STATUS, not controls.** There is **one** button, whose label and
  action follow whichever step needs doing. And per the newer lesson in
  `HANDOFF.md` §3: that button must use `.key--cta`, the only treatment in the
  app that reads as pressable. A flat panel is why hosts could not tell they
  had to press SHARE OVER THE INTERNET.
- **Only the "tab added" step is ground truth.** The others exist to explain
  why it has not happened. Adding the tab is a manual step in OpenKneeboard's
  own UI and cannot be automated — say so plainly rather than implying the app
  can do it.

## 7. Build order

1. **Fix §0 and register for real (half a day).** Correct registry contract,
   `;` IDs, real feature versions, `GetPages` before `SetPages`. Success is
   narrow and checkable: *"Tac Link" appears in OpenKneeboard's Add-Tab list.*
   Nothing below is observable until this passes.
2. **Spike the URI scheme (§8.1) before writing any transport.** If
   `http://127.0.0.1` is refused, the whole of §5 changes shape.
3. **The transport (§5).** State socket, intents, `/blob/<hash>`. This is the
   bulk of the work and the point at which the tab shows real intel.
4. **The SETUP panel (§6).**
5. **Brief mode over the OKB surface**, with the §4 one-page split assumed.
6. Re-judge `design/xr-layer/` on what is *left*: quad control only.

## 8. Open questions the spike must answer

**8.1 Does `ImplementationArgs.URI` accept `http://`?** The docs enumerate
`file://`, `https://` and `plugin://`. Our server is
`http://127.0.0.1:8788/viewer.html`. **This is the highest-risk unknown in the
whole design** — everything in §5 assumes it. Chromium treats
`http://127.0.0.1` as a secure context, so mixed content is not the obstacle;
the question is purely whether OpenKneeboard's URI validation allows the
scheme. Fallbacks, in order of preference, if it does not:
  - `plugin://` or `file://` for the page, with `fetch`/WebSocket to
    `http://127.0.0.1` for data — localhost being a secure context is what
    makes this plausible, but the page origin's CORS treatment must be checked;
  - loopback **https** with a locally-trusted certificate — real friction, a
    cert to generate and trust, and the last resort.

**8.2 Is a non-active tab suspended?** Decides the FOCUS-resync path (§4).

**8.3 Does WebView2 render B612 and the mid-tone palette identically?** The
whole card design assumes exact type metrics. Compare against the Electron
window with `dev-visual-test`'s harness, which already captures frames.

**8.4 Text quality vs window capture, through the headset.** The entire
premise of this work. Look at the Foxhunt card in WebView2 through the Crystal
Light before building further.

## 9. Honest gaps

- **Nothing here has run against OpenKneeboard.** §0 is read from the live
  docs and from the owner's registry; it is not a test result. Every claim in
  §0 should be re-confirmed by watching the tab appear.
- The `RequestPageChange` hedge is documented behaviour, not an observed
  failure. §4 avoids it by construction, which costs nothing — do not report
  it as a live bug.
- `OKBMaximumTestedVersion` is a promise. It currently claims the minimum,
  which is honest because nothing has been tested. Raise it only after running
  against that version — 1.12.10 is available on the owner's machine.
- Version drift has already bitten this document twice: settings moved to
  `%LOCALAPPDATA%\OpenKneeboard`, and the registration schema is `…\Plugins\v1`
  with a DWORD, not what an earlier reading assumed. Assume more.
