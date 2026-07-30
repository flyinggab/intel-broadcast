# HANDOFF — read this first

You have the repo and nothing else. This file is the missing context.

---

## 0. Read order, and one trap

1. **This file.**
2. `ROADMAP.md` — four phases, and §5 "what phase 1 must not foreclose".
3. `PROTOCOL.md` — current wire format, authoritative.
4. `PROTOCOL-V2.md` — the v2 design, needed for phase 2.
5. `BRIEF.md` — phase 1's spec. **Historical now**; phase 1 is done. Useful for
   the class contract in §4 and the token/spacing rationale.

**The trap:** `app/PLAN.md` is stale. It says the current release is `v0.2.1`
and documents a **viewer side panel that no longer exists** — phase 1 deleted
it and replaced it with the tab bar. `CLAUDE.md` used to point at PLAN.md as
the handoff doc. It is now history: good for the original architecture writeup
and the packaging bug post-mortem, wrong about current state. Trust
`git log` and this file.

---

## 1. Where the project is

**Current release: `v0.5.0`.** Phase 1 shipped 2026-07-30 as `v0.3.0`. The
2026-07-31 refinement pass shipped as two releases: `v0.4.0` (queue-first
BRIEF, RECEIVED as curation, settings save bar) and `v0.5.0` (settings
navigation rail, three settings removed, EN/IT internationalisation). The
commit messages carry the full models. Verify with `git log --oneline -5`;
don't trust hashes written down anywhere.

**Adding a user-facing string?** It goes in `app/src/renderer/i18n.js`, in
BOTH locales — `dev-i18n-test` fails on a key present in one and not the
other. Console and log lines stay English on purpose.

The app is an Electron companion for DCS. Any pilot hits a hotkey and their
selected photos appear on every connected pilot's kneeboard, captured by
OpenKneeboard. One instance hosts the relay; Tailscale Funnel exposes it.

Unified mode: **every instance both shares and receives.** There is no GM role.
The only distinction is "host the relay" (`relayHostEnabled`). A client's batch
goes *up* to the host, which fans it out to everyone including the sender —
the echo is the sharer's own render path, not redundancy.

### What phase 1 delivered — do not rebuild any of this

- New UI in `app/src/renderer/`: `viewer.html`, `settings.html`, `css/`,
  vendored B612 fonts. EFB layout, tab bar, four settings sub-pages.
- `viewState.js` — all viewer state lives in main, pushed to the renderer.
- `blobStore.js` — content-addressed, served over the `intel://` protocol.
  The base64 data URL is gone.
- `imagePrep.js` — sender-side downscale before upload.
- `squadCode.js` — one pasteable string carrying host, port and token.
- `HELLO`/`HELLO_ACK` version handshake.
- Hardening: `maxPayload`, `bufferedAmount` ceiling, `timingSafeEqual`,
  minimum token length.
- Tests: `app/scripts/dev-*-test.js`, plain `node`, no framework.

---

## 2. Invariants — deliberate decisions that look wrong

Each of these has cost someone something. Do not "simplify" them without
reading the reason.

**The renderer owns no state.** `viewer.js` holds no index, no selection, no
batch list. Main owns it; the renderer is a pure function of what it is pushed.
Its only mutable module binding is a timer handle. In phase 4 this same HTML is
rendered offscreen into a VR layer *alongside* the desktop window, and state in
the DOM cannot be shared between two surfaces. Adding `let currentIndex` for
convenience breaks phase 4 silently.

**Settings is a separate window, not a tab.** OpenKneeboard captures the
*entire* viewer window. If settings were a page in it, opening settings would
put the config form on the pilot's knee mid-flight. The SETUP tab is a
launcher. Never merge them.

**`data-surface="window"` is not redundant.** All chrome-hiding rules are scoped
to it. Phase 4 sets `"vr"`, where we own the compositor and chrome lives outside
the captured quad. Deleting the attribute means unpicking six CSS rules later.

**Mid-tone surface, ~4.2:1 both directions.** Dark engraved labels and light
values share one surface. 4.2 is the mathematical ceiling for a mid tone —
raising one lowers the other. It is slightly under the 4.5 AA body-text bar and
that is accepted, because everything at that contrast is short bold labels. If
you add long-form copy, use `--lit` on `--dn`, don't lighten `--bg`.

**44px minimum touch targets.** Looks generous for a desktop app. From phase 4
you point at this with a controller ray in VR, where precision is far worse
than a mouse. Do not tighten to desktop density.

**B612 / B612 Mono, vendored.** Commissioned by Airbus with ENAC for cockpit
displays. SIL OFL, files in `app/src/renderer/fonts/`. Never load from a CDN —
the app must work offline. B612 is wide, ~0.64em per cap; **measure new strings
against their containers**, it is the first thing that breaks.

**Tab bar caps at six.** Measured: four comfortable, five fit, six is the
ceiling, then labels clip. `TOOLS` is the launcher for new pages so the bar
stops growing. Do not let each feature claim a tab.

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
not in crash output.

**No `perMessageDeflate`.** JPEGs do not compress; it would burn CPU per socket
for nothing.

---

## 3. Your task

### Right now: refining phase 1 (current, 2026-07-31)

**Phase 2 has not started.** Phase 1 shipped as `v0.3.0` without ever having
been looked at — the UI was designed by measurement and never seen rendered.
It has now been seen, and two rounds of corrections shipped as `v0.4.0` and
`v0.5.0`. The work continues in that mode: small corrections driven by what
the app actually looks like when it runs.

That makes §4's two by-eye checks the starting point, not an afterthought, and
it makes §2 the binding constraint: a refinement that reintroduces renderer
state, merges settings into a tab, tightens touch targets below 44px or drops
`data-surface` is not a refinement, it is phase 4 breakage bought with a small
convenience today.

Keep changes in this period **reversible and narrow**: spacing, wording, sizing,
contrast, obvious bugs. Anything that changes a contract — the wire format, the
squad code, the class names in `BRIEF.md` §4 — is phase 2 work, not a detail.

### Next: phase 2

EFB features that earn their place in DCS. Full detail in `ROADMAP.md` §2.

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

### Don't build

A mission planner. The F10 map, the DCS briefing and the mission editor exist
and you will not beat them. This app's job is what is **live**, **shared**, or
**annoying to look up**.

---

## 4. Verifying

```bash
cd app && npm install
node scripts/dev-squad-code-test.js      # and the other dev-*-test.js
npm start                                 # runs the app
```

Tests are plain `node`, no framework. `dev-auth-test` and `dev-hardening-test`
need `ws` installed.

Open `app/src/renderer/preview.html` over a local server (not `file://`) to see
every UI state at true size without launching Electron.

**Check these two by eye, because nobody has yet:**

1. Frame page with chrome hidden — the photo and nothing else. That is what
   reaches the cockpit.
2. Opening settings must not change what the viewer window displays.

---

## 5. Honest gaps

- ~~The UI was designed without ever being seen rendered.~~ **Closed
  2026-07-31.** It has been seen, at 430×604 and in Electron, in both locales.
  `preview.html` drives the REAL render functions with fake snapshots
  (`preview-state.js`), so the harness exercises renderer code rather than
  parallel markup that drifts. Still: trust your eyes over the numbers.
- ~~`imagePrep`'s `prepareOne` has never run in Electron.~~ **Closed
  2026-07-31**, on macOS against real files: 311KB→140KB, a 6366KB PNG→263KB,
  and the two-condition passthrough firing correctly. Not yet exercised on
  Windows.
- **Phase 1 deleted several e2e tests** — `dev-e2e-panel-test`,
  `dev-e2e-live-apply-test`, `dev-e2e-clients-list-test` — because the side
  panel they covered is gone. Check nothing still-relevant went with them.
- **`app/PLAN.md` is stale.** See §0.
- **README still claims** "No DCS scripting, mission file, or Hooks install is
  involved anywhere." True today and true for all of phase 2. It stops being
  true in phase 3, when voice needs the DCS export. Keep the integration
  **opt-in** and update the claim then — that promise is why people try this
  app.
- **No telemetry seam yet.** `ROADMAP.md` §5.5 defines the `NullTelemetry`
  interface to add before phase 3 so DCS integration can be optional.
- **`dev-packaged-config-test` asserts a `dist/linux-unpacked/` path**, which
  electron-builder only produces on x64 — on arm64 it writes
  `dist/linux-arm64-unpacked/`. A WSL-era hardcoding; the test fails on this
  Mac for that reason alone. One line to derive the suffix.
- **Nothing is verified on Windows**, which is the only platform where the
  capture path (DCS + OpenKneeboard) actually exists.
