# HANDOFF — read this first

You have the repo and nothing else. This file is the missing context: enough to
resume work without re-deriving it from the code.

---

## 0. Read order, and one trap

1. **This file.**
2. `CHANGELOG.md` — what shipped in each release, and why.
3. `ROADMAP.md` — four phases, and §5 "what phase 1 must not foreclose".
4. `PROTOCOL.md` — current wire format, authoritative.
5. `PROTOCOL-V2.md` — the v2 design, needed for phase 2.
6. `BRIEF.md` — phase 1's spec. **Historical.** Its §4 class contract is
   superseded by §4 of this file; its token and spacing rationale still holds.
7. `design/` — features designed ahead of implementation, one folder each, with
   the decisions already settled and the measurements behind them. Read the
   relevant one *before* starting that feature; they exist so the reasoning is
   not repeated. They describe what to build, **not what the app does today** —
   this file and `CHANGELOG.md` are the record of shipped behaviour.

**The trap:** `app/PLAN.md` is stale. It says the current release is `v0.2.1`
and documents a **viewer side panel that no longer exists**. It is kept for the
original architecture writeup and the `v0.2.0` packaging post-mortem, both of
which are still accurate. Trust `git log` and this file.

---

## 1. Where the project is

**Current release: `v0.7.0`.** Verify with `git log --oneline -5`; don't trust
hashes written down anywhere.

The app is an Electron companion for DCS. Any pilot hits a hotkey and their
selected photos appear on every connected pilot's kneeboard, captured by
OpenKneeboard. One instance hosts the relay; Tailscale Funnel exposes it.

Unified mode: **every instance both shares and receives.** There is no GM role.
The only distinction is "host the relay" (`relayHostEnabled`). A client's batch
goes *up* to the host, which fans it out to everyone including the sender —
the echo is the sharer's own render path, not redundancy.

### Release history in one line each

| | |
|---|---|
| `v0.3.0` | Phase 1: the EFB UI, state in main, `intel://` blobs, squad codes, hardening |
| `v0.4.0` | BRIEF became the kneeboard: one flat photo queue, RECEIVED curates it |
| `v0.5.0` | Settings navigation rail; three settings removed; English + Italian |
| `v0.5.1` | The app icon, everywhere it was missing |
| `v0.5.2` | Language follows the OS preferred-language list, subtag-matched |
| `v0.6.0` | Pass-through keybinds; the chrome hides itself after six idle seconds |
| `v0.7.0` | One window: SETUP is a page; grid launcher replaces the tab bar; ONLINE/OFFLINE in place of "relay" |

`CHANGELOG.md` has the detail. The commit messages have the reasoning — they
are long on purpose and are the best record of *why*.

---

## 2. Architecture in one page

```
   ┌── main process ────────────────────────────┐
   │  viewState.js   THE state. Nothing else     │
   │      │          holds any.                  │
   │      │ snapshot()                           │
   │      ▼                                      │
   │  index.js ──pushState()──┐                  │
   │      ▲                   │                  │
   └──────│───────────────────│──────────────────┘
          │ intents           │ snapshots
   ┌──────┴───────────────────▼──────────────────┐
   │  viewer.js  +  settings.js (SETUP page)     │
   │  ONE window, one snapshot                   │
   │  pure functions of the snapshot they get    │
   └─────────────────────────────────────────────┘
```

- **Renderers own nothing.** They render a pushed snapshot and send back
  *intents* (`send('step', 1)`), never decisions. See §3.
- `viewState.js` is pure Node with an injectable clock — that is why
  `dev-viewstate-test` can test the auto-switch rules without Electron.
- Photos never reach a renderer as bytes. `blobStore.js` keys them by SHA-256
  and they are served over the custom `intel://` protocol.
- The relay is `ws`. `protocol.js` owns all framing, in one module, so a
  future native implementation can replace the file wholesale.

### The viewer's model (v0.4 onward)

Every received photo forms **one flat queue**, newest batch first. An arrival
*prepends*. The stage tracks **photo identity**, not an index — so curating
elsewhere in the queue renumbers the position but never moves what is on the
pilot's knee. RECEIVED is where you curate: a tile toggled off leaves the
queue; HIDE drops a whole batch.

---

## 3. Invariants — deliberate decisions that look wrong

Each of these has cost someone something. Do not "simplify" them without
reading the reason.

**The renderer owns no state.** `viewer.js` holds no index, no selection, no
batch list. Its only mutable module bindings are two timer handles. In phase 4
this same HTML is rendered offscreen into a VR layer *alongside* the desktop
window, and state in the DOM cannot be shared between two surfaces. Adding
`let currentIndex` for convenience breaks phase 4 silently.

**The stage tracks identity, not index.** `state.current` is
`{batchId, filename}`. If it were an index, hiding any earlier photo would
silently slide a different image under the pilot. Dropping the *current* photo
falls to the same position — the next photo — clamped.

**`banner.at` exists so the dismiss timer can be keyed per arrival.** The
renderer's 10s auto-dismiss must not restart on every state push; with the
settings window open, pushes arrive every 3 s, which would make the banner
immortal. The old render-keyed timer had exactly that bug.

**The shell is flex, not `grid-template-rows`.** The arrival banner is
`display:none` in the normal case, so a fixed four-row grid shifted every later
child up a row — the tab bar floated off the bottom edge with dead space
beneath it, and the layout was only correct while the banner happened to show.
Flex skips hidden children. Do not go back to grid rows without giving each
child an explicit `grid-row`.

**Settings is a PAGE of the viewer — one window.** This reverses an earlier
invariant, deliberately. The old rule said OpenKneeboard captures the whole
window, so a settings page could land on the pilot's knee. True, but it was
reasoning about a utility with a config dialog; the product is an EFB — the
tablet a pilot actually flies with carries its own settings, and reaching them
should not conjure a second window to manage. If SETUP is on screen it is
because the pilot put it there. `settings.js` runs in the viewer document,
scoped in an IIFE (both files would otherwise declare `body` and collide), and
exposes `window.__renderSetup` so viewer.js drives it from the one snapshot.

**`data-surface="window"` is not redundant.** All chrome-hiding rules are scoped
to it. Phase 4 sets `"vr"`, where we own the compositor and chrome lives outside
the captured quad. Deleting the attribute means unpicking the CSS later.

**Mid-tone surface, ~4.2:1 both directions.** Dark engraved labels and light
values share one surface. 4.2 is the mathematical ceiling for a mid tone —
raising one lowers the other. It is slightly under the 4.5 AA body-text bar and
that is accepted, because everything at that contrast is short bold labels. If
you add long-form copy, use `--lit` on `--dn`, don't lighten `--bg`.

**Two hues, both rationed.** `--fault` red means the relay is broken. `--go`
green means **a requirement is satisfied** — the SAVE & APPLY key when there is
something to commit, and the mark on a completed setup step (host *and* join).
Both are dynamic state, never decoration: an unfinished step keeps the plain
lit/hollow mark, so scanning the column for green answers "what still needs
doing". The moment either hue decorates something static, it stops meaning
anything. `dev-e2e-settings-test` asserts the done mark's *computed* colour
rather than its class, because a class name would not prove it renders green.

**44px minimum touch targets on the flight surfaces.** Looks generous for a
desktop app. From phase 4 you point at this with a controller ray in VR, where
precision is far worse than a mouse. SETUP is exempt — it is a form used on the
ground — and `dev-ui-geometry-test` enforces the floor on every other page
while merely reporting it for `setup/*`. The window moved; the reasoning did
not.

**B612 / B612 Mono, vendored.** Commissioned by Airbus with ENAC for cockpit
displays. SIL OFL, files in `app/src/renderer/fonts/`. Never load from a CDN —
the app must work offline. B612 is wide, ~0.64em per cap; **measure new strings
against their containers**, it is the first thing that breaks.

**Settings intents go in `handleSettingsIntent`, viewer intents in
`handleViewerIntent`.** They are two switches on two IPC channels, and several
settings-shaped cases (`toggle-photo`, `select-all`, `browse-folder`,
`set-auto-show`) live in the VIEWER one because that is where those controls
are. Adding a settings case next to them compiles, runs, and does nothing: the
click fires, the IPC arrives, and main logs `unknown intent` while the UI looks
correct. That shipped once. `dev-e2e-settings-test` now asserts a toggle
changes config and that no `unknown intent` appears.

**Keybinds have two backends, and the default one EATS the key.**
`globalShortcut` uses Windows' `RegisterHotKey`, which is exclusive (a second
app asking for the same combination just fails) *and* consuming (the key never
reaches anything else). Bind plain `B` that way and the letter b stops working
machine-wide. `passthroughKeys` switches to a low-level hook (`keyHook.js`,
uiohook-napi) that observes keys and passes them on, so bare letters are usable
bindings and DCS/OpenKneeboard still see the same press. It is **off by
default**: the hook sees every keystroke, which is worth an explicit opt-in on
an unsigned build that AV may flag.

Two things that make the hook safe to have:
- **It never records anything.** The handler matches against the configured
  accelerators and discards the event in the same tick — nothing is logged,
  buffered or sent. `dev-keyhook-test` asserts this against the source, because
  "we intended not to" is not a guarantee.
- **Modifiers match exactly.** `B` fires on B alone, never on Ctrl+B — so
  binding a bare letter cannot hijack every combination built on it.

**A native dependency changes packaging.** `uiohook-napi` ships N-API prebuilds
for every target we build, but electron-builder runs `@electron/rebuild` by
default and tries to *compile* it, which fails without a toolchain and cannot
produce both mac arches from one builder anyway. `npmRebuild: false` plus
`asarUnpack` for the module is what makes packaged builds work — do not remove
them. Verify a pack after touching build config: `npx electron-builder --linux
dir --publish never`, then check `dist/*/resources/app.asar.unpacked` actually
contains the `.node`.

**Navigation is a launcher, not a bar, and `launcherOpen` lives in main.**
A bar divides a fixed width by the number of destinations, so it stopped
working at six; the roadmap needs far more than six. The grouped grid scales,
and the strip that replaced the bar costs 44px instead of 28+58. Adding a page
is one entry in `DESTINATIONS` in `viewer.js` plus two i18n keys. The open
state is main's, like everything else — phase 4 drives a second surface from
the same snapshot, and a menu open in one DOM would be invisible to the other.
The strip had to grow to 44px when it took the trigger: it holds interactive
targets now, and the viewer's touch floor is not negotiable.

**The pilot never reads the word "relay", and going offline never changes
the page.** The relay is an implementation detail; the interface says ONLINE
and OFFLINE. And a dead connection does not lose the intel already received —
the queue is local — so replacing a photo being read with an error page cost
more than it told anyone. The `fault` page is gone; a fault bar reports it in
place, and it is chrome, so the capture stays clean.

**The viewer prints no hotkey, anywhere.** Printed bindings went stale the
moment a pilot recorded a new one. SETUP → KEYBINDS is the single source.

**Shipped HTML boots empty.** No demo batches, no fake callsigns, no
placeholder tiles — the first frame a pilot can see is truthful. All demo
content lives in `preview-state.js` and is pushed through the *real* render
functions via the `window.__preview` hook each renderer exposes when it loads
without Electron. Never re-add demo content to the shipped markup: the harness
would then be exercising markup instead of renderer code, and the two drift.

**Language follows the OS, and matches on the language subtag only.**
`i18n.pickLocale(preferred, configured)` walks the user's *ordered* OS
language list and takes the first one we ship; an explicit choice in settings
overrides it; anything unrecognised falls back to English. It matches the
subtag before the `-`, never a substring — the dev Mac reports `en-IT`
(English language, Italian *region*), and `includes('it')` would flip it to
Italian. Source is `app.getPreferredSystemLanguages()`, which is the right
list on Windows, macOS and Linux alike; `app.getLocale()` is only the
fallback, because it is Chromium's own UI locale and disagrees (`en-GB` here).
Set `INTEL_BROADCAST_SYSTEM_LANGUAGES=it-IT,en-US` to test a translation
without changing your machine. Boot logs one `[i18n]` line saying what the OS
asked for and what was chosen.

**Every user-facing string goes through `i18n.js`, in BOTH locales.**
`dev-i18n-test` fails on a key present in one and missing in the other. A
missing key renders *as the key* — a visible canary, not a silent fallback.
Console and log lines stay English on purpose: they are diagnostics, grepped by
tests and pasted into bug reports.

**The icon has two masters.** Downscaling the full artwork to 16px turns the
kneeboard page into a featureless white rectangle, so `icon-small.svg` redraws
it for ≤48px. `.icns` and `.ico` are containers of independent bitmaps, which
is what makes this possible.

**`imagePrep` passthrough needs both conditions** — under 400 KB *and* already
within the target long edge. A 6000px image at 300 KB still costs every client
a decode. Do not collapse to one test.

**`sharedBy` is stamped server-side** from the authenticated callsign, never
trusted from the frame.

**The squad code format is frozen.** `IB1-` + base64url of `host:port:token`,
split from the right. Conformance vector in `protocol-vectors.json`; it must
keep round-tripping. `MIN_TOKEN_LENGTH` is 12 — a public Funnel URL makes the
token the entire security model.

**Never log the squad code or the token.** Not in the log tail on the LOG page,
not in crash output. `dev-e2e-settings-test` asserts this against both stdout
and the log file.

**No `perMessageDeflate`.** JPEGs do not compress; it would burn CPU per socket
for nothing.

---

## 4. The class contract

JS toggles these. JS never writes inline styles. This supersedes `BRIEF.md` §4.

| Element | Attribute / class | Values |
|---|---|---|
| `<body>` | `data-page` | `brief` `received` `share` `setup` |
| `<body>` viewer | `data-surface` | `window` today, `vr` in phase 4 |
| `<body>` viewer | `.is-chrome-hidden` | blanks all chrome for the capture |
| `<body>` viewer | `.is-unfocused` | DCS has focus; chrome dims |
| `<body>` | `data-setup` | `net` `keys` `log` — SETUP's own sub-navigation |
| `<body>` | `data-mode` | `host` `join` — SETUP's NETWORK section. Also decides which `.mode__body` shows, via the exclusivity rule in `components.css`; the two bodies still carry `[data-mode="host"|"join"]` even though they now sit inside their cards, because that rule and the `hostVisible`/`joinVisible` probe both key off it |
| `.rail__item` (settings) | `.is-active` | one per rail |
| `.dest` (launcher) | `.is-active` | the page you are on |
| `.launcher` | `.is-hidden` | closed; it is chrome, so capture-clean hides it |
| `.faultbar` | `.is-hidden` | connected; also chrome. CSS additionally hides it on SETUP → NETWORK, where it would be redundant |
| `.menukey` | `.is-active` | launcher open |
| `.mode__head` | `.is-on` | the selected host/join mode. The head, not the `.mode` wrapper — `settings.js` toggles `.is-on` on the `[data-set-mode]` element |
| `.tile` | `.is-off` | deselected (SHARE *and* RECEIVED) |
| `.step` | `.is-done`, `.is-running` | |
| `.toggle` | `.is-on` + `aria-checked` | keep both in sync |
| `.key` | `.is-active`, `.key--cta`, `[disabled]` | |
| `.field` | `.field--recording` | keybind capture in progress |
| `.banner` | `.is-hidden` | |
| `.stage__standby` | `.is-hidden` | shown when the queue is empty |
| any element | `data-i18n="key"` | static string, rewritten by `applyStatic()` |

Gone since BRIEF: `.row` / `.row__*` (RECEIVED is tiles now), `.subtab` (a
rail), `.tab__badge` (no unread state), the `frame` page (BRIEF *is* the
stage), the `pilot` settings page, and — since v0.7 — `.tabbar` / `.tab`
entirely.

---

## 5. Verifying

```bash
cd app && npm install
node scripts/dev-viewstate-test.js       # and the other dev-*-test.js
npm start                                # runs the app
```

Plain `node`, no framework. 23 scripts. Most take no arguments; the exceptions:

- `dev-e2e-test` and `dev-e2e-electron-test` need a photo folder:
  `node scripts/dev-e2e-test.js photos/roman-sead-joker1`
- `dev-packaged-config-test` **currently fails** — see §7.

Fast loop while working on the UI:

```bash
cd app/src/renderer && python3 -m http.server 8080
```

then open `preview.html`. Both frames load the same `viewer.html` — one showing
a flight page, one showing `page: 'setup'` — and drive its **real render
functions** with the fake snapshots in `preview-state.js`, so what you see is
what `render()` produces. EN/IT buttons switch both frames.

**By-eye checks that matter:**

1. Chrome hidden on BRIEF — the photo and nothing else. That is what reaches
   the cockpit. *(Verified 2026-07-31.)*
2. Opening settings must not change what the viewer window displays.
   *(Verified 2026-07-31.)*

---

## 5b. Releases

Two paths, deliberately separate:

- **Real release** — push a `v*` tag. `release.yml` builds Windows + both mac
  arches and publishes. Bump `app/package.json` first and add a `CHANGELOG.md`
  entry.
- **Dev pre-release** — every commit on `main` triggers `dev-release.yml`,
  which publishes `v<version>-dev.<short sha>` as a pre-release **and deletes
  the previous one**, so exactly one dev build exists at a time. It sorts below
  every real release in semver, so it can never present itself as newer, and
  `releases/latest` keeps pointing at the real one. The deletion only ever
  touches tags matching `-dev.`.

Note `gh release list` prints "Latest" next to a pre-release; that is the CLI's
own labelling. `gh api repos/OWNER/REPO/releases/latest` is the authority and
excludes pre-releases.

## 6. Environment and traps

### Windows dev box (2026-07-31) — where Tailscale is actually real

There is now a **second dev environment: the owner's Windows machine**, driven
from a WSL2/Ubuntu-24.04 sandbox on the same box. This is the only environment
where DCS, OpenKneeboard and a real Tailscale all exist, so it is where the
funnel is verified.

WSL reaches Windows both ways, which makes this fast:

- `/mnt/c/...` is the Windows filesystem. The app's log a user actually
  produced is at
  `/mnt/c/Users/<user>/AppData/Roaming/taclink/taclink.log` —
  read it before theorising.
- **Windows binaries execute from WSL.** `"/mnt/c/Program Files/Tailscale/tailscale.exe" status --json`
  works from a Linux shell, so `INTEL_BROADCAST_TAILSCALE_BIN` pointed there
  runs the app's real Tailscale code against the real daemon without leaving
  WSL. That is how the parser was finally confirmed.
- `cmd.exe /c "..."` runs anything Windows-side. Windows has its own
  `node` (v25) and `git`; the WSL `node_modules` are Linux binaries and cannot
  be shared, so the Windows checkout needs its own `npm install`.

**A native Windows checkout lives at `C:\Users\gabri\taclink-dev`**,
cloned from GitHub (a `\\wsl.localhost\...` clone path does NOT work) with
its own `node_modules` and Electron. Refresh and run it with:

```bash
cmd.exe /c "cd /d C:\Users\gabri\taclink-dev && git pull && cd app && npm start"
```

Confirmed there on 2026-07-31: `findBinaryDetailed()` resolves
`C:\Program Files\Tailscale\tailscale.exe` via PATH, and `getState()`
returns `Running / loggedIn / funnelOn` with target `http://127.0.0.1:8787`
against Tailscale 1.98.10. **The funnel detection code is correct on the real
platform** — the long-running doubt about it is closed.

One WSL2 detail worth knowing if you ever run the relay in WSL while the
funnel points at Windows: WSL2 forwards Windows `localhost` to listening
sockets inside WSL, so `tailscale funnel --bg 8787` on Windows can reach a
relay bound in the sandbox.

### macOS

Development was on **macOS (Apple Silicon)** from 2026-07-30. Everything before
that was a WSL/Linux sandbox, so environment claims in `app/PLAN.md` — unreliable
`capturePage()`, invisible tray icons, WSLg windows — were **WSL artifacts, not
app bugs**. Don't carry them forward.

**The trap that wastes the most time:** if the packaged `Tac Link.app`
is running, it holds `app.requestSingleInstanceLock()`, and *any* dev instance
exits **code 0 with zero output**. It reads exactly like a broken build. The
symptom is an Electron test failing with an empty `--- full output ---`. Check
with `ps aux | grep -i "Tac Link"`. To diagnose without quitting it,
pass `--user-data-dir=/tmp/ib-scratch`.

Other things that have bitten:

- **There is exactly one DOM probe now: `PANEL_PROBE`**, emitted by
  `attachViewerProbe()` in `main/index.js` under `INTEL_BROADCAST_VIEWER_PANEL_PROBE`.
  SETUP is a page of the viewer, so its fields ride along in the same payload.
  Two traps came out of that merge, both of which hid real breakage:
  *(a)* a test still looking for the old `SETTINGS_PROBE` name times out on a
  message that never arrives, and reads like a UI bug —
  `dev-e2e-funnel-flow-test` did exactly this and silently verified nothing for
  four commits; *(b)* fields get dropped in the merge and nothing complains
  until a test needs them (`joinSteps`, `doneMarkColour` and `funnelAction` all
  had to be recovered from git). If you touch the probe, grep `scripts/` for
  every field name you removed.
- **No double hyphen inside SVG comments.** It is illegal in XML; the file then
  fails to decode as an image with no useful error. It broke `branding/icon.svg`
  once already.
- **`timeout` does not exist on macOS** (it is GNU coreutils). Don't wrap test
  commands in it.
- **Homebrew can't install the current `node` formula here** — macOS 14 Sonoma
  is outside the bottle window. `brew install node@22` works. `brew update`
  does not help; only a macOS upgrade would.
- The app's own log is the fastest way to see what a run did:
  `~/Library/Application Support/taclink/taclink.log`
- **Target platform is still Windows.** DCS and OpenKneeboard are Windows-only,
  so the part that actually matters — a captured window on a pilot's knee —
  cannot be verified on macOS at all.

Regenerating the icon (macOS only, needs `iconutil`):

```bash
cd app && node scripts/dev-make-icons.js
```

Edit `branding/*.svg`, never the PNGs, and commit what lands in `app/build/`
and `app/src/renderer/img/`. CI never runs this — it consumes the committed
outputs.

---

## 7. Honest gaps

- **`dev-packaged-config-test` fails on arm64.** It asserts a bundle at
  `dist/linux-unpacked/`, but electron-builder writes
  `dist/linux-arm64-unpacked/` here. A WSL-era hardcoding, one line to fix by
  deriving the arch suffix. Nothing else is wrong with the test.
- **Windows is now partly verified.** Tailscale detection, login state and
  funnel status all run correctly against the real daemon there (§6), and the
  packaged app's own log shows `funnel --bg` succeeding. Still unverified on
  Windows: the OpenKneeboard capture path itself, `imagePrep` (proven on
  macOS), and a real two-machine reveal across the funnel.
- **Neither build is code-signed, and on Windows that is no longer only a
  SmartScreen warning.** Defender has started quarantining the build as
  `Trojan:Win32/Wacatac.B!ml` — an ML heuristic, not a signature. Three
  ordinary properties of this app feed that score: it is unsigned, so there is
  no reputation to weigh against the guess; it ships `uiohook-napi`, a
  low-level keyboard hook, which is the keylogger primitive; and it opens a
  listening socket. Until v0.8.0 it was also a `portable` self-extracting exe,
  which unpacks to `%TEMP%` and runs from there — structurally a dropper. That
  one is fixed (NSIS installer, per-user, no UAC).

  What is left to do, in order of value:
  1. **Report it.** <https://www.microsoft.com/en-us/wdsi/filesubmission>,
     "Software developer" → "Incorrectly detected". `!ml` detections clear by
     retraining, usually within days. This needs doing for each new binary
     until signing is in place.
  2. **Sign it.** The LICENSE is now GPL-3.0-or-later, so SignPath Foundation
     (free for OSS) is open. Azure Trusted Signing is the cheap paid
     alternative; a traditional OV cert now requires a registered company.
     Terms on all of these change — check before committing to one.
  3. **Consider whether `uiohook-napi` earns its place in the shipped binary.**
     It powers an opt-in feature most pilots never turn on, and it is the
     single most malware-shaped thing we ship. Not removed yet: confirm it is
     actually the trigger first, by testing `v0.5.2` (before it) against
     `v0.6.0` (after it).

  macOS is unchanged: Gatekeeper, $99/yr, issued to individuals.
- **No telemetry seam yet.** `ROADMAP.md` §5.5 defines the `NullTelemetry`
  interface to add before phase 3 so DCS integration can be optional.
- **README claims** "No DCS scripting, mission file, or Hooks install is
  involved anywhere." True today and for all of phase 2. It stops being true in
  phase 3, when voice needs the DCS export. Keep the integration **opt-in** and
  update the claim then — that promise is why people try this app.
- **Phase 1 deleted several e2e tests** — `dev-e2e-panel-test`,
  `dev-e2e-live-apply-test`, `dev-e2e-clients-list-test` — with the side panel
  they covered. `dev-intel-history-test` was also removed in v0.4.0 after its
  module was deleted; its coverage was re-homed into `dev-viewstate-test` and
  `dev-format-test`.
- **`app/PLAN.md` is stale.** See §0.

---

## 8. Your task

### Phase 2 — EFB features that earn their place in DCS

Phase 1 shipped, and then had two rounds of refinement driven by actually
looking at it (`v0.4.0`, `v0.5.0`). The UI is in good shape. Full phase-2
detail is in `ROADMAP.md` §2.

### The constraint that decides everything

Until phase 4 the pilot sees a *captured window*. They can look at it. **They
cannot reliably touch it in VR.** So features rank by how little in-flight
interaction they need:

- **Tier A — pushed to you, zero interaction.** Shared 9-line, comms plan,
  annotated photos, synchronised timers, lineup card.
- **Tier B — hotkey paging, no pointing.** Checklists, brevity reference,
  weapons quick-ref, your own kneeboard cards as pages.
- **Tier C — needs input.** Scratchpad, coordinate converter, 9-line *builder*,
  bingo calc. Ground use only until phase 4.

### Suggested order — value before the protocol lift

1. **F10 map grab.** Hotkey screenshots the DCS F10 map into the share folder;
   annotate, push. No DCS integration — it is a screen capture. Reuses the
   photo pipeline and `imagePrep` unchanged. Replaces the alt-tab/snip/Discord
   workflow every squad does badly. Best value-to-effort in the whole phase.
2. **Theatre reference data.** Airfield runway headings, elevations, TACAN/ILS,
   ATC frequencies; carrier BRC, TACAN, ICLS, recovery cases. Static JSON, no
   integration, kills a common alt-tab.
3. **Protocol v2** — `PROTOCOL-V2.md`. Now it is needed: a 9-line and a comms
   plan are *structured artifacts*, not photo blobs, and `reveal-batch` cannot
   carry them without becoming an unversionable union type.
4. **Tier A shared artifacts**, once v2 lands. `RECEIVED` generalises from
   "photos" to "anything the squad pushed", with the kind shown per row.

Steps 1 and 2 need no protocol change and ship independently.

Note that RECEIVED already renders per-photo tiles grouped by batch, so
generalising it to "artifacts of several kinds" is a rendering change, not a
restructure.

### Don't build

A mission planner. The F10 map, the DCS briefing and the mission editor exist
and you will not beat them. This app's job is what is **live**, **shared**, or
**annoying to look up**.
