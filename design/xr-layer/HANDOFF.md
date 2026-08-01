# XR layer — replacing OpenKneeboard for display and pen input

**Status** — researched, not started. Phase 4 (`/ROADMAP.md` §4).
**Nothing here blocks phase 2.** Brief mode and kneeboard cards ship against
OpenKneeboard as-is. This exists so the research is not repeated.

Today the EFB is a window that OpenKneeboard captures and composites into VR.
This describes owning that step: an OpenXR API layer that draws the EFB into
the headset directly, plus pen input without OpenKneeboard in the path.

---

## 1. How OpenKneeboard does it

From their own internals docs and the maintainer's blog — read these before
writing anything:

- <https://openkneeboard.com/internals/> and `/internals/injectables/`
- <https://openkneeboard.com/faq/third-party-developers/>
- <https://fredemmott.com/blog/2022/05/31/in-game-overlays.html>

**Architecture.** The app process does essentially all the work; it owns shared
memory and shared textures and fills them. The DLLs loaded into the game do the
bare minimum — set up layers, copy textures. Their stated rule: prefer code in
the app over code in injectables, because a crash in your app is survivable and
a crash in the game is not. **Adopt this rule wholesale.**

**The OpenXR piece is an implicit API layer, not a hook.** Registered via
`HKLM\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit`. The loader inserts it into
the call chain at `xrCreateInstance`; you intercept `xrEndFrame` and append
quad layers. No injection, no Detours, no pattern matching.

**Frame behaviour.** Most frames just re-submit the same quad with the same
space (derived from `LOCAL`) and pose as the previous frame. Recentring calls
`xrLocateSpace()` comparing `VIEW` to `LOCAL` and stores the offset, reused
until the next recentre. Texture copies happen only when content changed.

**SHM.** Since their sprite-the-SHM refactor, a single 4096×2048 texture rather
than two 2048×2048.

**Known API-layer interaction traps** (theirs, and they will be ours):
- another layer assuming only one space per reference space type
- another layer not handling all active spaces/poses consistently
- another layer reading swapchain images and assuming they update every frame —
  they are not required to, and OpenKneeboard does not by default
- **layer order matters**: OpenKneeboard must load before OpenXR motion
  compensation; recent Ultraleap drivers bypass later layers and must be last.
  Gabriele runs Quad-Views-Foveated — expect ordering work.
  Tool: OpenXR-API-Layers-GUI.

**Their own assessment**, from the third-party FAQ: if you do not need to
handle input, creating your own OpenXR overlay from scratch is *relatively
straightforward*. Input is the hard part **for them** — see §3.

## 2. Licence position — decided

- **OpenKneeboard is GPLv2**, and was further restricted in a recent release:
  derived projects must change name and unique identifiers.
- **Their docs are the textbook. Copy no code.** Build from the Khronos OpenXR
  SDK (Apache 2.0) and Ybalrid's `OpenXR-API-Layer-Template` (CMake scaffold
  for C++ layers). Their docs describe *what* to do; write our own *how*.
- **OTD-IPC is a separate repo under MIT**, but its README warns the compiled
  plugin may carry OpenTabletDriver's own licence terms. Irrelevant to us:
  **speaking a documented pipe protocol is interop, not derivation.** We write
  our own Node client from the message definitions.
- **Ship nobody else's binaries.** If a dependency is needed, fetch it at
  runtime from the official release so the user obtains it from the original
  distributor.
- Read both LICENSE files directly before shipping. Nobody involved is a lawyer.

## 3. What to build, and what to skip

**Build**

1. **OpenXR layer DLL** — C++, **D3D11 only** (DCS is D3D11). Loader
   negotiation, capture the device at session creation, own swapchain, quad
   submission at `xrEndFrame`, recentre offset.
2. **SHM bridge** — one shared keyed-mutex texture, plus a small napi-rs/N-API
   module so Electron can upload dirty rects from the offscreen render.
3. **OTD-IPC client in Node** — pen input, no injection. See §4.
4. **Installer / registry** for implicit layer registration, and clean removal.

**Skip**

- Oculus and SteamVR paths — Pimax OpenXR only
- D3D12 and Vulkan renderers
- Non-VR injectables — **the existing window already is the 2D path.** This is
  where the `data-surface` attribute pays off.
- WinTab entirely (OpenKneeboard's own built-in WinTab is deprecated and being
  removed)
- Their whole tab/PDF/browser/profile machinery — the EFB *is* the app

**Milestones**

| | outcome | estimate |
|---|---|---|
| M0 | template layer draws a static quad in DCS on the Crystal Light | 1–2 wks |
| M1 | live EFB in headset: offscreen render → SHM → quad, dirty rects | 2–3 wks |
| M2 | recentre binding, size/position in SETUP, installer, layer registration | 1–2 wks |
| M3 | OTD-IPC pen input → EFB; ink joins brief mode | 1–2 wks |

**6–10 weeks part-time. M0 is the feasibility gate** — if the quad will not
appear in DCS through the Pimax runtime with QVFR active, everything after is
moot. Do M0 before planning M1.

**Develop without launching DCS.** `hello_xr` from the OpenXR SDK supports
D3D11 and is the standard target. Build a test-feeder equivalent that puts a
pattern into SHM, and a viewer that reads it back — the same shape of tooling
OpenKneeboard's internals docs recommend, written from scratch.

**Cost to acknowledge:** this adds MSVC and C++ to a Node-only repo, and a
native build job to CI. That is permanent. Weigh it at M0, not at M2.

## 4. Pen input — OTD-IPC

OpenKneeboard's built-in WinTab needed an "invasive" mode injecting into the
game so the driver kept reporting while DCS had focus. That is deprecated. The
recommended path is **OpenTabletDriver + the OTD-IPC filter plugin**, which is
a named pipe:

```
\\.\pipe\com.fredemmott.openkneeboard.OTDIPC/v0.1
```

Structs with a type+size header; **one client at a time, exclusive by design**.
Node reads named pipes natively (`net.connect`), so Electron main can be the
client and map packets to `webContents.sendInputEvent` on the offscreen window
— **pen input with zero DLL injection.** This is the single biggest reason this
project is smaller for us than it was for them.

Setup UX, when we get there: a TABLET page in SETUP mirroring the Tailscale
step pattern — 01 OTD installed · 02 daemon running · 03 plugin present ·
**04 pipe live** (the only check that is ground truth; 01–03 exist to explain
*why* 04 failed). Guided install, not automated: OTD needs a specific .NET
Desktop Runtime and often requires removing vendor drivers. Detect and link;
do not become someone's driver updater.

**Trap to design for now:** the pipe is exclusive, so during migration a pilot
running both OpenKneeboard and intel-broadcast will have one of them holding
it. Distinguish `ERROR_PIPE_BUSY` from not-found and say so plainly —
otherwise SETUP reports everything installed while the pen does nothing.

## 5. Routes considered and rejected

Recorded so they are not re-proposed.

- **Drive OpenKneeboard's configuration from Electron** so the user installs it
  and never opens it. **Rejected.** There is a documented Plugin/C API and
  remote controls (`SET_TAB`, `NEXT_PAGE`, …; path in
  `HKCU\Software\Fred Emmott\OpenKneeboard\InstallationUtilitiesPath`) but it
  is all *runtime control*, not setup. Creating a window-capture tab means
  writing `Saved Games\OpenKneeboard\profiles\<name>\Tabs.json` — an internal,
  unversioned schema they are actively planning to relocate to `%APPDATA%`,
  in a directory their plugin docs explicitly tell third parties to stay out
  of, from a project whose docs state it *is not a developer toolkit*. Worst
  case is corrupting a pilot's existing kneeboard setup. **Instead:** a stable
  window title (`Intel Broadcast — EFB`, never version-suffixed), sane default
  window size/aspect, a guided three-click page, and detection from our side so
  SETUP can show a real check rather than instructions with no feedback.
- **Ride OpenKneeboard for display while taking the tablet ourselves** —
  OTD-IPC into Electron, OKB doing window capture only. **Not rejected, but not
  the plan.** It is a legitimate cheap experiment (days of Node work, no C++)
  and would validate the pen-on-glass interaction early. Costs: extra latency
  through capture+composition, and we must draw our own cursor. Worth doing
  only if M0 slips or pen feel needs proving before committing to C++.

## 6. Open

- Does the quad survive Quad-Views-Foveated, and at what layer order? Unknown
  until M0. This is the highest-risk unknown in the whole plan.
- Pimax runtime quirks (Pimax Play OpenXR) are unresearched.
- DCS multithreading interaction with layer-owned swapchains: unresearched.
- Whether SETUP grows quad size/position/recentre controls, or those stay
  headset-side. Probably ours, since the point is removing OpenKneeboard.

## 7. Honest gaps

- **All of this is from documentation, not from writing a layer.** No code has
  been run. Estimates are informed guesses; M0 exists to make them real.
- Version-sensitive: OpenKneeboard's SHM format, licence, and WinTab status all
  changed recently. Re-read their changelog before starting.
- The legibility maths in `design/kneeboard/HANDOFF.md` §2 applies here too and
  becomes *ours* to set: at phase 4 we choose the quad size, so we choose the
  arcminutes. That is the real prize — not parity with OpenKneeboard, but a
  kneeboard sized correctly by construction.
