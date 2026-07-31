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

**The trap:** `app/PLAN.md` is stale. It says the current release is `v0.2.1`
and documents a **viewer side panel that no longer exists**. It is kept for the
original architecture writeup and the `v0.2.0` packaging post-mortem, both of
which are still accurate. Trust `git log` and this file.

---

## 1. Where the project is

**Current release: `v0.5.1`.** Verify with `git log --oneline -5`; don't trust
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
   │  viewer.js          settings.js             │
   │  (captured window)  (separate window)       │
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

**Settings is a separate window, not a tab.** OpenKneeboard captures the
*entire* viewer window. If settings were a page in it, opening settings would
put the config form on the pilot's knee mid-flight. The SETUP tab is a
launcher. Never merge them.

**`data-surface="window"` is not redundant.** All chrome-hiding rules are scoped
to it. Phase 4 sets `"vr"`, where we own the compositor and chrome lives outside
the captured quad. Deleting the attribute means unpicking the CSS later.

**Mid-tone surface, ~4.2:1 both directions.** Dark engraved labels and light
values share one surface. 4.2 is the mathematical ceiling for a mid tone —
raising one lowers the other. It is slightly under the 4.5 AA body-text bar and
that is accepted, because everything at that contrast is short bold labels. If
you add long-form copy, use `--lit` on `--dn`, don't lighten `--bg`.

**Two hues, both rationed.** `--fault` red means the relay is broken. `--go`
green means "there is something to commit" and today lights exactly one
control, the settings SAVE & APPLY key while dirty. The moment either
decorates something static, it stops meaning anything.

**44px minimum touch targets, viewer only.** Looks generous for a desktop app.
From phase 4 you point at this with a controller ray in VR, where precision is
far worse than a mouse. The settings window is exempt — never captured, never
in the headset — and `dev-ui-geometry-test` enforces the floor on the viewer
while merely reporting it for settings.

**B612 / B612 Mono, vendored.** Commissioned by Airbus with ENAC for cockpit
displays. SIL OFL, files in `app/src/renderer/fonts/`. Never load from a CDN —
the app must work offline. B612 is wide, ~0.64em per cap; **measure new strings
against their containers**, it is the first thing that breaks.

**The viewer prints no hotkey, anywhere.** Printed bindings went stale the
moment a pilot recorded a new one. SETUP → KEYBINDS is the single source.

**Shipped HTML boots empty.** No demo batches, no fake callsigns, no
placeholder tiles — the first frame a pilot can see is truthful. All demo
content lives in `preview-state.js` and is pushed through the *real* render
functions via the `window.__preview` hook each renderer exposes when it loads
without Electron. Never re-add demo content to the shipped markup: the harness
would then be exercising markup instead of renderer code, and the two drift.

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
| `<body>` viewer | `data-page` | `brief` `received` `share` `fault` |
| `<body>` viewer | `data-surface` | `window` today, `vr` in phase 4 |
| `<body>` viewer | `.is-chrome-hidden` | blanks all chrome for the capture |
| `<body>` viewer | `.is-unfocused` | DCS has focus; chrome dims |
| `<body>` settings | `data-page` | `net` `keys` `log` |
| `<body>` settings | `data-mode` | `host` `join` |
| `.tab`, `.rail__item` | `.is-active` | one per bar |
| `.choice` | `.is-on` | the selected relay mode |
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
stage), the `pilot` settings page.

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

then open `preview.html`. It loads the real `viewer.html` / `settings.html` in
iframes and drives their **real render functions** with the fake snapshots in
`preview-state.js`, so what you see is what `render()` produces. EN/IT buttons
switch both frames.

**By-eye checks that matter:**

1. Chrome hidden on BRIEF — the photo and nothing else. That is what reaches
   the cockpit. *(Verified 2026-07-31.)*
2. Opening settings must not change what the viewer window displays.
   *(Verified 2026-07-31.)*

---

## 6. Environment and traps

Development is on **macOS (Apple Silicon)** since 2026-07-30. Everything before
that was a WSL/Linux sandbox, so environment claims in `app/PLAN.md` — unreliable
`capturePage()`, invisible tray icons, WSLg windows — were **WSL artifacts, not
app bugs**. Don't carry them forward.

**The trap that wastes the most time:** if the packaged `Intel Broadcast.app`
is running, it holds `app.requestSingleInstanceLock()`, and *any* dev instance
exits **code 0 with zero output**. It reads exactly like a broken build. The
symptom is an Electron test failing with an empty `--- full output ---`. Check
with `ps aux | grep -i "Intel Broadcast"`. To diagnose without quitting it,
pass `--user-data-dir=/tmp/ib-scratch`.

Other things that have bitten:

- **No double hyphen inside SVG comments.** It is illegal in XML; the file then
  fails to decode as an image with no useful error. It broke `branding/icon.svg`
  once already.
- **`timeout` does not exist on macOS** (it is GNU coreutils). Don't wrap test
  commands in it.
- **Homebrew can't install the current `node` formula here** — macOS 14 Sonoma
  is outside the bottle window. `brew install node@22` works. `brew update`
  does not help; only a macOS upgrade would.
- The app's own log is the fastest way to see what a run did:
  `~/Library/Application Support/intel-broadcast/intel-broadcast.log`
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
- **Nothing is verified on Windows** — the only platform where the capture path
  exists. `imagePrep` has now run for real on macOS but not there.
- **No LICENSE file.** The repo is public but legally all-rights-reserved: no
  one can fork or redistribute, and it disqualifies the project from free
  code-signing programmes (SignPath Foundation). One commit to fix; the choice
  is the owner's.
- **Neither build is code-signed.** Windows shows SmartScreen, macOS shows
  Gatekeeper. Apple needs $99/yr and issues to individuals; Windows now
  requires a registered company for a commercial cert, so the free OSS route
  is the realistic one — and it needs the LICENSE first.
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
