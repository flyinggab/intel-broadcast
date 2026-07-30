# Intel Photo Broadcast System (keybind-triggered, cross-client)

## Session status / how to resume (2026-07-30)

**Read this section first in a fresh session.** Everything below it is the original design
writeup — still accurate architecturally, but some implementation details (`--gm` flag, fixed
window frame, restart-to-apply settings, fixed 850×1202 window size) it describes were later
superseded; the "How it works" section of `README.md` and this section reflect current reality
more precisely than the body text further down.

**Repo**: `~/intel-broadcast`, pushed to `https://github.com/flyinggab/intel-broadcast` (public).
Current `main` HEAD as of this writing: `6fa5d9f`. Run `git log --oneline` for the authoritative
list — don't trust hardcoded hashes here once more commits land.

**⚠️ The published release is stale — rebuild before further cross-machine/Tailscale testing.**
`v0.1.0` (https://github.com/flyinggab/intel-broadcast/releases/tag/v0.1.0) is tagged at commit
`d1ed98d`, which is **missing every feature commit since**, including:
- `bb80b7e` — replaced the `--gm` launch flag with a Settings checkbox (`gmModeEnabled` in config).
  The released build still needs `--gm` on the command line to enable GM mode at all — there's no
  way to turn it on from the UI in that build.
- `6fa5d9f` — `INTEL_BROADCAST_LOCAL_CONFIG_PATH` for testing two instances on one machine.
- the 2026-07-30 session's work: display-proportional UI scaling (4K fix), live settings apply
  (no more restart), and the Connected-clients list — see "What's built" below.

To cut a fresh release: bump/retag `v0.1.0` (delete the old release + tag first —
`gh release delete v0.1.0 --repo flyinggab/intel-broadcast --yes --cleanup-tag`, then
`git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0 && git tag v0.1.0 && git push origin v0.1.0`)
to trigger `.github/workflows/release.yml`, which builds Windows + both Mac archs and publishes
automatically (`releaseType: "release"` in `app/package.json`, not a draft). Takes ~2-3 minutes;
watch with `gh run watch <run-id> --repo flyinggab/intel-broadcast`. Known release-pipeline
footguns already hit and fixed once — don't reintroduce them: (a) CLI args like
`electron-builder --mac zip` override `package.json`'s `build.mac` config entirely, including
`arch` — the npm scripts must be bare (`electron-builder --mac`, `--win`) so config controls it;
(b) validate config changes locally first via `npx electron-builder --linux dir --publish never`
from `app/` — validates the *entire* config object (all platforms) without needing a real CI
round-trip.

**What's built and verified** (all via automated `dev-e2e-*.js`/`dev-*-test.js` scripts in
`app/scripts/`, run with plain `node`, no test framework):
- Phase 0 — relay protocol (`relayServer.js`, `auth.js`): token auth, `reveal-batch` broadcast,
  binary-frame reassembly. `dev-e2e-test.js`, `dev-auth-test.js`.
- Phase 1 — Electron viewer window, renders received batches, next/prev local browsing.
  `dev-e2e-electron-test.js`.
- Phase 2 — GM hotkey + embedded relay, fan-out to viewers. `dev-e2e-gm-test.js` (now runs GM +
  viewer as genuinely concurrent processes with isolated configs).
- Settings window: folder picker, relay port/token, click-to-record hotkeys (not typed
  accelerator strings), GM-mode toggle, callsign/username field. `dev-e2e-settings-test.js`
  (real IPC path), `dev-e2e-hotkey-record-test.js` (real click + synthetic keydown → capture),
  `dev-settings-save-test.js` (deep-merge unit test), `dev-hotkey-config-load-test.js` (fresh
  process picks up saved hotkeys).
- **Live settings apply (2026-07-30)** — saving no longer relaunches the app. index.js was
  restructured around mutable state + `applyNewConfig()`: hotkeys always re-register
  (unregisterAll → re-register); the embedded relay server stops/starts on GM-toggle or
  port/token change (relayServer.close() now *terminates* client sockets and takes a completion
  callback — `wss.close()` alone leaves the port held and old sockets dangling); the relay
  client reconnects on URL/token/callsign change; photos folder is resolved at reveal time.
  `dev-e2e-live-apply-test.js` (replaced `dev-e2e-relaunch-test.js`, which tested the removed
  relaunch flow) proves the same process swaps the reveal hotkey AND restarts the relay on a new
  port/token, with a real ws probe receiving a broadcast. `dev-e2e-settings-test.js` now *fails*
  if the app exits after a save.
- **Display-proportional UI scaling (2026-07-30, the "text is tiny on 4K" fix)** — `scaling.js`
  (pure math, no Electron): windows are sized from the display's DIP work area (viewer keeps A4
  portrait at 85% of work height; settings scales from its 480×760 design size vs. a
  1080p-baseline 1040px work height, clamped [1,3]) and renderer content is zoomed to match via
  `webFrame.setZoomFactor` in the preloads (per-window; `webContents` zoom is per-origin and
  both windows share `file://`, so one would clobber the other). Zoom value travels via a
  `uiZoom` load-URL query param. `"uiScale": <number>` in config.local.json overrides
  auto-detection; saves preserve it (tested). `dev-scaling-test.js` (unit math),
  `dev-e2e-settings-test.js`'s ZOOM_PROBE (renderer innerWidth confirms the zoom really applied).
  This sandbox's WSLg reports a 3840×2160 work area at scale factor 1 — exactly the reported bug.
- **Connected-clients list in Settings (2026-07-30)** — relayServer tracks authenticated
  clients' `{role, callsign, connectedAt}` (Map, was a bare Set), exposes `getConnectedClients()`
  + an `onClientsChanged` callback; index forwards to the settings window via
  `pushConnectedClients()` and the init payload. GM-mode Settings renders the live list
  (callsigns are remote strings — rendered with textContent, never innerHTML). Pilot field
  relabeled "Callsign / username (shown to your GM)". `dev-e2e-clients-list-test.js` (join AND
  leave reach the settings DOM).

**Real bugs found and fixed this session** (via the tests above, not just code review — worth
knowing the *shape* of what broke, since it's the kind of thing that could regress):
1. `render()` toggled `photoEl.style.display = ''` to show the image, but CSS had
   `#photo { display: none }` as a stylesheet rule — clearing an inline style doesn't override a
   stylesheet rule, so the image (and index indicator) never actually appeared. Fixed by using
   explicit `'block'`.
2. `viewer.setConnectionState()`/`showBatch()` could fire after the BrowserWindow was destroyed
   (shutdown-ordering race), throwing "Object has been destroyed". Fixed with `isDestroyed()`
   guards.
3. **The hotkey bug that took the longest to nail down**: after Settings "Save & Restart", a newly
   recorded custom hotkey wouldn't fire — the old default kept working instead. Root cause:
   `app.exit(0)` (needed for an immediate restart) does **not** fire Electron's `will-quit` event
   the way `app.quit()` does, so the cleanup handler that unregisters hotkeys never ran on that
   path, and the old process's registrations could linger through the handoff to the relaunched
   process. Fixed by calling `globalShortcut.unregisterAll()` explicitly in the save handler.
   **2026-07-30: this whole class of bug is gone** — the save → relaunch flow was removed
   entirely (settings apply live in the same process now; `INTEL_BROADCAST_NO_RELAUNCH` and
   `dev-e2e-relaunch-test.js` no longer exist), so there is no process handoff for registrations
   to linger through. Kept here because the `app.exit()`-doesn't-fire-`will-quit` asymmetry is
   still true and worth remembering if a relaunch path ever comes back.
4. Release pipeline: `mac.arch` isn't a valid top-level property (must nest under
   `mac.target[].arch`); npm script CLI args silently override `package.json` build config;
   electron-builder's GitHub publisher defaults to draft releases with a placeholder
   `untagged-...` URL until published (`releaseType: "release"` fixes both).

**Known environment limitations of this WSL/WSLg sandbox** (don't re-investigate these — they're
sandbox artifacts, not app bugs, per hands-on testing already done):
- `capturePage()`-based screenshot verification doesn't reliably work here (GPU compositor issues:
  "Exiting GPU process due to errors during initialization"). A dev-only hook for it still exists
  (`INTEL_BROADCAST_SCREENSHOT_PATH` env var) in case it's useful on a real display, but don't
  trust it here.
- System Tray icon support under WSLg is unverified — `tray.js` wraps creation in try/catch so it
  can never crash the app if unsupported. This is why a menu-bar item and a hotkey
  (`Ctrl+Shift+O` default) were added as guaranteed-to-work fallbacks for reaching Settings.
- GUI windows in this sandbox render onto the user's real Windows desktop via WSLg — be careful
  about spawning test instances without warning; several rounds of this session caused
  unexpected windows/dialogs to appear on the user's actual screen.

**Local dev environment notes**: this WSL sandbox has no native `node` — one was installed via nvm
and symlinked into `~/.local/bin` (already on `PATH` per `.zshrc`). `npm install` in `app/` needed
`npm approve-scripts electron` once, to let Electron's postinstall download its binary (blocked by
npm's install-script allowlist by default) — already done, recorded in `app/package.json`'s
`allowScripts` field, shouldn't need repeating.

**Not yet done / open items**:
- Rebuild and republish the GitHub release (see above) once ready to resume cross-machine testing.
- Phase 3 (Tailscale Funnel on the GM's real machine) and Phase 4 (full squad rehearsal) haven't
  started for real — everything so far has been local/WSL testing plus one release build cycle.
- Window size/position persistence (`%APPDATA%`) mentioned in the design below was never
  implemented — flagged as a TODO back in Phase 2, still outstanding.
- No icon asset for the app/tray — currently a 1x1 placeholder PNG scaled up (`tray.js`).

## Context

The user wants to share a recon/intel photo with their whole flight during a DCS multiplayer mission: one person (the GM, who is also flying) presses a keybind and the photo pops up simultaneously on every connected pilot's screen — pilots are on separate physical PCs spread across the internet, not a LAN party. Each pilot's screen shows the photo in an Electron window that OpenKneeboard's Window Capture source can grab and present as a virtual kneeboard page in the cockpit.

Earlier design iterations considered wiring the trigger through DCS itself — an F10 radio menu command. That turned out to add real, unproven complexity: DCS's Mission Lua environment (where F10 handlers run) is authoritative server-side only in multiplayer, so reaching it reliably requires a `Scripts/Hooks/*.lua` bridge polling `net.dostring_in('mission', …)` on the host, plus an unverified DCS API question (whether the built-in Game Master role has any direct scripting hook, vs. needing a dedicated slot/group workaround).

**Decision: drop DCS scripting from the trigger path entirely**, following the pattern in `rkusa/dcs-scratchpad` (a global OS-level hotkey, independent of DCS) rather than `ciribob/dcs-simpleradiostandalone`'s DCS-integrated trigger. The GM's Electron app registers a global hotkey (Electron's `globalShortcut`, works whether DCS has focus or not) that reveals the photo. What's *kept* from the SRS-inspired design is the cross-client fan-out: DCS has no reliable way to push data to every client machine on its own, so a relay is still required to get the photo from the GM's press to every other pilot's screen over the internet. This removes the entire `dcs-bridge/` component, the Hooks script, the mission-side F10 script, and the biggest unverified risk from the previous design — no DCS-side installation or scripting is needed anywhere, on any machine.

**Decision: no separate relay server/device.** Rather than deploying a standalone relay to a Raspberry Pi (or a VPS), the relay is folded directly into the Electron app itself: when launched in `--gm` mode, the app starts a small embedded WebSocket server in its main process, and every other pilot's app (plain viewer mode) connects straight to the GM's machine. Reachability is still solved with Tailscale Funnel (see Wire protocol below), just running on the GM's own PC instead of a dedicated always-on box. This means the entire system — trigger, relay, and display — lives in one Electron codebase with two modes, and there is nothing to deploy, maintain, or keep powered on separately from a normal flight session. Trade-off accepted: the relay's uptime is now tied to the GM's own machine/session (if their app or PC goes down, the relay goes with it), which is fine since the GM has to be running the app anyway to fly.

MVP scope: **one pre-bundled folder of photos per mission**, one hotkey. Pressing it batch-sends every photo currently in that mission's folder to all clients at once; each pilot's viewer receives the whole set and lets them browse/cycle through it locally (not locked to a single revealed image). Load-bearing design decision kept from the earlier discussion: the wire protocol carries actual **image bytes** through the relay at reveal time, not "photo IDs" the client looks up locally — because the user's stated next step is swapping the source for **live-captured imagery** (F-14B TARPS pod, F/A-18C FLIR/DDI), which can't be pre-synced to every machine. Sending bytes today means that future swap is a source-side change only, not a protocol rewrite.

## Architecture

```
GM's machine (also flying)                                    Every other pilot's machine
┌───────────────────────┐                                    ┌───────────────────────┐
│ Electron app, --gm mode │                                    │ Electron app, viewer   │
│ - global hotkey          │   wss://<gm>.<tailnet>.ts.net       │   mode                 │
│   (e.g. Ctrl+Shift+I)    │  ─────────────────────────────────▶│ - fullscreen photo,     │
│ - reads pre-bundled       │        (batch of images,             │   browsable via its     │
│   mission folder,          │         via Tailscale Funnel)         │   own local hotkeys      │
│   sends every photo in it  │                                    │ - OpenKneeboard          │
│                            │                                    │   Window Capture         │
│ - embedded WS relay        │                                    │                        │
│   server (fans out to      │                                    │                        │
│   every connected viewer)  │                                    │                        │
│ - also shows locally        │                                    │                        │
│   immediately (no             │                                    │                        │
│   round-trip wait)             │                                    │                        │
└───────────────────────┘                                    └───────────────────────┘
```

No DCS process, mission script, or Hooks file appears anywhere in this diagram — DCS is not involved in the trigger or transport at all. There is no separate relay device either — the GM's own app instance is the relay. OpenKneeboard only ever looks at the Electron viewer window's contents.

## Repo layout

**Own repository**, separate from `dcs-workspace` — this is a standalone companion app, not a mission asset, so it lives in its own git repo as a sibling directory: `~/intel-broadcast/` (i.e. `../intel-broadcast` relative to `dcs-workspace`), with its own `git init` / remote, independent of the DCS mission-dev repo's `.gitignore` and commit conventions (in particular it's fine to commit built artifacts/lockfiles here — CLAUDE.md's "never commit `.miz`" and other dcs-workspace-specific rules don't apply).

```
intel-broadcast/                    # ~/intel-broadcast, sibling to ~/dcs-workspace
├── README.md                       # architecture + setup
├── PROTOCOL.md                     # wire protocol spec, source of truth
└── app/                             # single Electron app, "viewer" and "gm" modes
    ├── package.json
    ├── electron-builder.yml         # portable .exe, no installer wizard
    ├── src/
    │   ├── main/
    │   │   ├── index.js             # picks mode from config/--mode flag
    │   │   ├── relayServer.js       # embedded ws server, only started in --gm mode
    │   │   ├── relayClient.js       # ws client (every instance, incl. GM's own, connects as a viewer too)
    │   │   ├── auth.js              # token check on connect (relayServer side)
    │   │   ├── viewerWindow.js      # capture-friendly BrowserWindow
    │   │   ├── gmHotkey.js          # registers globalShortcut, reads photo folder, sends + shows locally
    │   │   ├── tray.js              # Tray icon + "Settings"/"Quit" context menu
    │   │   └── settingsWindow.js    # GM/pilot config form -> config.local.json, applies live
    │   ├── preload/
    │   └── renderer/
    │       ├── viewer/              # fullscreen <img>, idle/disconnected states
    │       └── settings/            # plain form: folder picker (GM) or relay URL/token (pilot)
    ├── resources/config.default.json # relay hostname/token baked in per squad build
    └── photos/<mission-name>/          # bundled test-fixture convention; real use points the
        ├── 01-target-area.jpg          # settings page's folder picker at any arbitrary folder
        ├── 02-tarps-recon.jpg          # instead (photosFolder in config.local.json overrides this)
        └── ...
```

Photos: for quick testing, `app/photos/<mission-name>/` holds bundled JPEGs (e.g. copied from `dcs-workspace/briefings/src/roman-sead-joker1-intel1.jpg`) with a numeric filename prefix (`01-`, `02-`, …) setting browsing order. For real use, the GM instead points the settings page's folder picker at wherever their mission photos actually live — no copying into the repo required.

## Wire protocol (relay)

- **Auth**: on WS connect, client sends `{type:"auth", token, role:"viewer"|"gm", callsign}` within 5s; server validates against `RELAY_TOKEN`, closes with code `4001` on failure. Single shared squad secret for MVP — accepted risk for a small trusted group, not a hard security boundary.
- **Reveal-batch**: one text frame `{type:"reveal-batch", batchId, count, sourceType:"prebundled"|"live-capture", ts, items:[{itemId, filename, mimeType, byteLength, sha256}, …]}` describing every photo in the batch, followed by `count` binary frames — each prefixed with its `itemId` so the viewer can match payload to metadata regardless of arrival order. A viewer that receives a new `reveal-batch` replaces its currently-browsable set entirely (no merging across batches); the "one hotkey press = one full folder snapshot" model keeps this simple. A future live-capture source that only ever produces one frame at a time just sends a batch of `count:1`.
- **Fan-out**: the embedded relay server (running inside the GM's own app process) re-sends the metadata frame + all binary frames to every connected viewer socket. This means the GM's home uplink is doing the N-way fan-out of the *entire folder* itself, on top of already running DCS — with a small squad (single-digit pilots), a modest folder (handful of photos), and capped per-photo size (below), this stays within typical residential upload bandwidth, but total-folder-size discipline matters more now that it's not just one image. Keep mission folders to a reasonable count (low double digits at most) rather than dumping in dozens of high-res images.
- **Transport**: plain `ws://` from the embedded server in the GM's app, exposed publicly via **Tailscale Funnel** running on the GM's own PC. Every other pilot's machine needs nothing beyond the Electron app itself — no Tailscale client, no VPN, no manual network config. Funnel gives the GM's machine a public `https://<gm-machine>.<tailnet>.ts.net` HTTPS/WSS endpoint with TLS handled automatically, without touching the home router (no port-forward, sidesteps CGNAT entirely) and without exposing the home IP. That fixed hostname gets baked into `config.default.json` at build time (see Installation/distribution) so pilots never see or configure it. Since it's the GM's *personal* Tailscale identity/machine, the hostname is stable across sessions as long as they don't reset their Tailscale setup.
- Recommend GM-side pre-resize (Electron's built-in `nativeImage`, no extra dep) to a capped long edge (~2000px) / JPEG q85 before sending — bounds bandwidth regardless of source photo size, and matters even more here since the GM's residential uplink is both running the game and doing the fan-out simultaneously.

## Electron app details

**Viewer window** (every instance runs this, including the GM's own — OpenKneeboard Window Capture compatibility):
- Fixed `title: "Intel Broadcast Viewer"`, set once, never mutated.
- **Normal framed window**, not frameless — OpenKneeboard's Window Capture already handles ordinary framed windows fine (confirmed: it captures WhatsApp, which has a titlebar, without issue), so there's no reason to give up native drag/resize/minimize behavior for a benefit that doesn't exist. (An earlier iteration tried `frame:false` + a hand-rolled CSS drag region; reverted after manual testing showed frameless bought nothing and cost basic window movability.)
- **A4-portrait proportions by default** (~1:1.414, e.g. 850×1202px) — matches kneeboard-page orientation, consistent with how this user's other DCS kneeboards are laid out.
- Current photo rendered via CSS `object-fit: contain` in a full-viewport black container — clean letterboxing for any aspect ratio. A small, unobtrusive `"3 / 7"`-style index indicator (corner overlay) shows position within the batch — kept minimal so it doesn't clutter the capture.
- **Browsing its own local hotkeys** (mirrors `rkusa/dcs-scratchpad`'s page-switch pattern): `globalShortcut`-registered next/previous (e.g. `Ctrl+Shift+Right` / `Ctrl+Shift+Left`) so the pilot can flip through the received batch without alt-tabbing out of DCS or needing mouse focus on the window. This is every pilot's own local browsing state — it doesn't touch the network or affect anyone else's view. Known limitation when running two instances on one machine (e.g. local dev/demo): OS-level global hotkeys can only be owned by one process at a time, so only whichever instance registered first responds — not an issue once pilots are on separate physical machines.
- Explicit idle (`"Waiting for reveal…"`) and disconnected (red banner) states — never a blank/crashed capture target.
- Window is kept open and restored (not minimized) during a session — same as any other app the user already runs behind OpenKneeboard's Window Capture (e.g. WhatsApp), so no special-casing needed. Always-on-top default OFF.
- Window size/position persisted to `%APPDATA%` so OpenKneeboard's capture region stays valid across restarts. *(Not yet implemented as of Phase 2 — still a TODO, tracked separately from the settings page below.)*

**GM hotkey behavior** (`gmHotkey.js`): registers a single global shortcut (default `Ctrl+Shift+I`, configurable) via Electron's `globalShortcut` module — fires regardless of which window/app has OS focus, including while DCS is fullscreen. On press: reads every file in the configured photos folder (see Settings page below), updates the GM's own viewer window immediately with the full batch (direct IPC, no network round-trip needed for self), and hands the same batch to the local `relayServer` for fan-out to everyone else. The GM's machine therefore runs the exact same viewer window (with the same next/prev browsing hotkeys) as everyone else, plus the embedded relay server and this one extra reveal hotkey — not a separate UI, just extra background responsibilities enabled by `--gm`.

**Settings page** (new, added after initial Phases 0–2 build-and-test; superseded the `--gm` launch flag entirely afterward — see below): rather than requiring anyone to hand-edit `config.local.json`, a small settings window — reached via a system Tray icon, the app's own minimal menu bar, or a configurable hotkey (default `Ctrl+Shift+O`) — lets each role configure what it needs through a normal form, saved to `config.local.json` (already the established override mechanism) and applied live on save (see last bullet):
- **A "Enable Game Master mode" checkbox is the mode switch now, not a launch flag.** One app, one shortcut/build for everyone — checking the box and saving is how a session's GM is designated, toggleable live in the same settings window (fields for both roles are always in the DOM; the checkbox just shows/hides them).
- **GM fields**: which folder to share (native folder picker, `dialog.showOpenDialog`, replaces the earlier fixed `photos/<mission-name>/` convention with an arbitrary absolute path so nothing needs to be copied into the app's own directory), the embedded relay's listen port, and the shared token. Also surfaces read-only guidance for the Tailscale Funnel step (the local `ws://localhost:<port>` address, and instructions for running `tailscale funnel <port>` so pilots outside the LAN can reach it) — full Tailscale CLI automation is out of scope, this is guidance text plus the values needed, not a driver for the `tailscale` binary.
- **Pilot fields**: relay URL, token, callsign — lets them override a squad build's baked-in defaults without needing a rebuild if the GM's Funnel hostname ever changes.
- **Hotkeys** (reveal, next/prev browsing, open-settings) are click-to-record, not typed accelerator strings: click "Record," press the combo, it's captured and formatted automatically (Escape cancels).
- Settings changes apply live on save *(superseded the original restart-to-apply design on 2026-07-30)*: hotkeys re-register, the embedded relay server restarts only when its port/token/GM-toggle changed, and the relay client reconnects only when URL/token/callsign changed — an unrelated save never drops anyone's connection. The GM's settings window also shows a live "Connected clients" list (each client's callsign/username, pushed on join/leave).

## Installation/distribution

- **Pilots**: one portable `.exe` (electron-builder, `"win":{"target":"portable"}`, no admin install) is the *only* thing they install — no Tailscale, no VPN client, no config file to edit, no separate server to run. Client-side setup is entirely: download the exe, run it, add it as an OpenKneeboard Window Capture source once.
- **GM**: the same portable `.exe`, launched with a `--gm` flag (or a second desktop shortcut) that additionally starts the embedded relay server and the hotkey listener. One-time setup on the GM's own PC: install Tailscale and enable Funnel for the app's relay port — this is the only machine that needs Tailscale at all. The resulting public Funnel hostname + shared token are baked into `resources/config.default.json` at build time, so pilots never see or configure them. The GM's copy also needs the mission's `photo.jpg` bundled locally.

## Phasing (smallest solo-testable slice first)

0. **Relay skeleton** — embedded Node `ws` server module + `PROTOCOL.md`. Test standalone (`node relayServer.js` or equivalent) with `wscat`/test scripts simulating a `reveal-batch` (metadata frame + a couple binary frames) and a viewer receive, no Electron GUI yet.
1. **Viewer app MVP** — connects to a local relay instance, renders a received batch correctly (idle/disconnected/aspect states, index indicator, next/prev local hotkeys). Test by pushing 2-3 sample images (e.g. `dcs-workspace/briefings/src/roman-sead-joker1-intel1.jpg` plus a couple more) as a batch via a Phase-0 test script. Quick sanity check as part of this phase: add the running viewer as an OpenKneeboard Window Capture source once, just to confirm the fixed-title/frameless setup captures cleanly — not treated as a separate high-risk phase, since Window Capture itself is already proven (the user runs it for WhatsApp today).
2. **GM hotkey + embedded relay** — wire `globalShortcut` + folder read (all files) + immediate local display + the app's own embedded `relayServer`. Test solo: one `--gm` instance + one viewer instance, both on one machine, DCS not even running.
3. **Tailscale Funnel on the GM's machine**, tested across two networks (e.g. home WiFi + phone hotspot) to validate genuine internet round-trip through the tunnel, not just localhost.
4. **Full squad rehearsal** — the only phase that needs the whole squad online: 2+ remote pilots on the pre-built viewer exe, GM presses the hotkey (with DCS actually running and in focus, to confirm the global hotkey really fires through it), confirm simultaneous reveal.
5. *(Explicitly out of scope for this plan, but protocol-compatible)* — swap the pre-bundled-file read behind the hotkey for a live TARPS/FLIR capture source feeding the same `reveal` message shape (`sourceType:"live-capture"`).

## Verification plan

- **Relay correctness**: small Node test client scripts, run from WSL — fastest inner loop through Phases 0–1.
- **Hotkey-through-DCS**: manual check in Phase 4 that the global shortcut actually fires while DCS has exclusive fullscreen focus (Electron's `globalShortcut` is normally OS-wide, but DCS's fullscreen-exclusive mode is worth confirming doesn't swallow it).
- **Internet-distributed behavior**: Phase 3's two-network trick substitutes for needing the whole squad online every cycle.

## Unknowns flagged for hands-on verification (not asserted as fact)

1. Whether Electron's `globalShortcut` reliably fires while DCS holds fullscreen-exclusive input focus — check in Phase 4; if it doesn't, the fallback is running DCS in borderless-windowed mode (common practice for VR/overlay tools already).
2. Tailscale Funnel account/plan requirements (it's available on Tailscale's free tier for personal use as of last check, but confirm current terms before relying on it) and exact `tailscale funnel` port-forwarding syntax for the relay's WS port — a five-minute check during Phase 3 setup, not a design risk.

### Key reference files
- `/home/gabri/dcs-workspace/briefings/src/roman-sead-joker1-intel1.jpg` — sample photo for viewer rendering tests (lives in the existing dcs-workspace repo, copied into the new `intel-broadcast` repo for testing)
