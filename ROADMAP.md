# Roadmap

Four phases.

| | phase | shape of the work |
|---|---|---|
| **1** | New UI + cheap optimisations | JavaScript only |
| **2** | EFB features that earn their place in DCS | JavaScript + protocol v2 |
| **3** | Voice, replacing SRS | opt-in DCS integration, UDP transport |
| **4** | Own the compositor, replacing OpenKneeboard | native OpenXR layer |

The ordering is right: each phase makes the next one worth doing. Building the
OpenXR layer before there are pages worth rendering would be effort spent on an
empty frame.

**Two consequences of putting features before the compositor** — both land now,
§2.1 and §2.2.

---

## 1. Phase 1 — new UI, cheap wins

Scope for the next Claude Code session. `BRIEF.md` is this phase and only this
phase.

**Build** — the UI package (`BRIEF.md` §1–7) · `imagePrep.js` (§8) · kill the
base64 data URL (§9.1).

**Harden** — set `maxPayload` on the `WebSocketServer`, currently unset so `ws`
defaults to 100 MiB per message · add a `bufferedAmount` ceiling to the
broadcast loop · `crypto.timingSafeEqual` for the token plus per-IP attempt
limiting · enforce a minimum token length when generating a squad code.

**Do once, for free, because everything later needs it**

- `HELLO` / `HELLO_ACK` as an optional pre-auth exchange. **There is no version
  field anywhere in the current protocol** — until one exists, no later change
  is safe. Highest-leverage line of code in the phase.
- Key the local blob store by SHA-256 of content rather than a fresh UUID.

**Not in phase 1** — protocol v2 bulk · Rust · hooks · voice · in-VR rendering.

---

## 2. Phase 2 — EFB features worth having

The relay is the thing nobody else has. OpenKneeboard shows *you* documents;
you have a live link to the whole flight. So the features that matter are the
ones where **one person publishes and everyone's kneeboard updates.** Building
another single-user PDF viewer is the low-value path.

### 2.1 The constraint that decides the feature list

Until phase 4 the pilot is looking at a *captured window*. They can see the
page. **They cannot reliably touch it in VR.** Input into a captured window
from inside the headset is limited at best, so anything needing precise
pointing or typing is unusable in flight until you own the compositor.

Phase 2 features therefore rank by how little in-flight interaction they need.

**Tier A — pushed to you, zero interaction.** The best fit, and the whole
reason the relay exists.

- **Shared 9-line / CAS brief.** JTAC or mission commander fills it in, pushes
  it, and it lands on every kneeboard already formatted.
- **Comms and frequency plan.** One person publishes; the whole package has the
  same card. No more "say again your button".
- **Annotated recon photos.** Arrows, circles, target labels drawn before the
  reveal. Extends what already exists instead of adding a subsystem.
- **Synchronised timers.** Someone sets push time or TOT and every countdown
  agrees, because they came from one clock.
- **Lineup card.** Roster, callsigns, aircraft, loadouts.

**Tier B — hotkey only, page through without pointing.**

- Checklists per airframe.
- Brevity reference — searchable on the ground, paged in the air.
- Weapons employment quick-reference.
- Your own kneeboard cards as pages. This is the first real step toward not
  needing OpenKneeboard at all.

**Tier C — needs input. Ground use in phase 2, in-flight from phase 4.**

- Scratchpad.
- Coordinate converter — MGRS ↔ L/L DDM, since the Hornet and the Viper do not
  agree on format.
- 9-line *builder*, as opposed to receiver.
- Fuel and bingo calculations.

Tier C is the concrete argument for phase 4: those features can exist earlier
but stay half-useful until the kneeboard is touchable in the pit.

### 2.2 Protocol v2 moves into this phase

Phase 2 is what forces it. A 9-line, a comms plan and an annotation are
**structured artifacts, not photo blobs** — the wire needs typed payloads, and
`reveal-batch` cannot carry them without becoming a union type nobody can
version.

So `PROTOCOL-V2.md` ships with phase 2, not later:

- The channel/type envelope gives every artifact kind its own type code.
- Content addressing stops re-sending an unchanged comms card every time
  somebody re-publishes.
- Capability negotiation lets a pilot on an older build keep receiving photos
  while ignoring artifact kinds they do not understand.

`RECEIVED` generalises from "photos that arrived" to "anything the squad
pushed", with the kind shown per row.

### 2.3 The tab bar has room for one or two more

Measured against B612 at 11.5px: four tabs fit comfortably, **five fit, six is
the ceiling**, and past that labels clip. Suggested landing point:

```
BRIEF · RECEIVED · SHARE · TOOLS · SETUP
```

`TOOLS` is the launcher for Tier B and C pages, so the bar stops growing. Do
not let each new feature claim a tab.

---

## 3. Phase 3 — voice, replacing SRS

Transport is roughly 20% of SRS. The rest is radio state, modulation,
line-of-sight, encryption and the jitter buffer that makes it sound acceptable
— and **all the radio state comes from DCS.** Detail in `PROTOCOL-V2.md` §8.

Two hard constraints:

- **Voice cannot share a socket with bulk.** A 3 MB photo ahead of a voice
  packet in the same TCP stream delays it by the whole transfer. Head-of-line
  blocking is not tuneable away — channel 2 needs its own transport.
- **Funnel cannot carry it.** Funnel is a TLS/TCP proxy through DERP relays, so
  UDP voice will not traverse it. Voice needs a direct tailnet path or a real
  server with a public UDP port. This is the strongest argument for the
  standalone relay, and therefore for Rust.

This is where DCS integration arrives. Keep it **opt-in** and keep the promise
intact for anyone who only wants intel and pages — that is the difference
between a companion app people try and one they do not. Update the README when
it lands so the "no DCS scripting" claim stays honest: the integration is
optional, intel-only still needs nothing.

---

## 4. Phase 4 — own the compositor, replacing OpenKneeboard

**It is an OpenXR API layer, not a hook.** You sit in the loader chain,
intercept `xrEndFrame`, and composite a quad layer into the submitted frame.
OpenKneeboard's own guidance is that writing an overlay layer is approachable
*if you do not need to handle input* — and by phase 4 input is exactly the
point, because it unlocks every Tier C feature.

You will need to copy your surface into the composition layer swapchains — real
D3D11 and D3D12 work — plus 3D math to place the quad. DirectXTK and the OpenXR
SDK's `xr_linear.h` cover most of it.

**The bridge from Electron is offscreen rendering.** A `BrowserWindow` with
`webPreferences: { offscreen: true }` emits `paint` events carrying a bitmap;
recent Electron versions can hand back a shared GPU texture instead, avoiding a
per-frame CPU round trip — verify against your Electron version.

**This is why the phase 1 UI work is not throwaway.** The same HTML and CSS
becomes the VR kneeboard. It stops being captured and starts being rendered.

**Three warnings.**

1. **Repaint on change, not on a clock.** Rendering the page and uploading a
   texture every frame costs Crystal Light frame time you would rather spend
   elsewhere. The kneeboard is static most of the time — drive it from dirty
   rects.
2. **Layer ordering will bite you specifically.** You already run
   Quad-Views-Foveated, and OpenXR layers are order-sensitive with documented
   constraints between them. Getting it wrong shows up as a crash or an
   invisible overlay, not a clear error.
3. **Check OpenKneeboard's LICENSE before borrowing code.** The README carries
   copyleft warranty boilerplate, which usually indicates GPL. Reading it for
   understanding is fine; copying has consequences for how you can license and
   ship. Confirm before you start.

**Keep the 2D path.** An OpenXR layer does nothing for non-VR players. The
capturable window stays as the fallback surface, which `data-surface="window"`
already provides for.

---

## 5. What phase 1 must not foreclose

Six decisions, all free now, all expensive to retrofit.

### 5.1 Blob store keyed by content hash
Serve `intel://blob/<sha256>`, not `intel://item/<uuid>`. Phase 2's content
addressing then reuses the same store and the same renderer URLs — it becomes a
wire change, not a storage rewrite.

### 5.2 The renderer owns no state
Phase 4 renders this same HTML offscreen into a quad layer, possibly alongside
the desktop window. State living only in the DOM cannot be shared between two
surfaces. Main holds all state and pushes it; the renderer is a pure function
of what it is given. No `let currentIndex` in `viewer.js` that main does not
also know. **Easiest thing on this list to get wrong, and it is being written
now.**

### 5.3 Treat "captured window" as a mode
`is-chrome-hidden` exists only because OpenKneeboard captures the whole window.
Once you own the compositor, chrome lives outside the quad. `data-surface` is
already in the markup and all six chrome rules are scoped to it — phase 4 adds
a branch instead of unpicking one.

### 5.4 Kneeboard geometry is config
A4 portrait is inherited from window capture. When you render the quad you
choose the aspect. Config now; the CSS is already rem-based off `--ui-scale`.

### 5.5 A telemetry seam that returns null
```js
class NullTelemetry {
  isAvailable() { return false; }
  getAircraft() { return null; }   // type, tail, position, heading
  getRadios()   { return null; }   // selected radio, frequency, modulation
  getMission()  { return null; }   // name, time, theatre
}
```
Everything downstream is written against this and never learns whether DCS is
integrated. Phase 3 swaps in `DcsExportTelemetry` behind the same interface.
This is what makes "enabled on demand" real rather than aspirational.

### 5.6 Keep protocol code in one module
`protocol.js` already is. No framing logic leaking into `relayServer.js` or
`relayClient.js`, so a napi-rs module can replace the file wholesale.

### One thing that already went right
The 44 px minimum touch targets were an aesthetic choice for the tablet look.
Pointing at a kneeboard in VR with a controller ray is far less precise than a
mouse, so from phase 4 they are functionally required. Noted so nobody
"optimises" them back to desktop density.
