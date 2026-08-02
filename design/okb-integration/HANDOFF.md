# OpenKneeboard integration — web dashboard tab

**Status** — researched, not started. Phase 2/3, **develop alongside
`design/brief-mode/`**.
**Why together** — the page-mapping decision below is cheap to make now and
expensive to unpick once presenter mode ships. See §4.

Today OpenKneeboard *window-captures* the EFB. OpenKneeboard also supports
**Web Dashboard** tabs: it renders a web page directly in WebView2, with a
JavaScript API. The EFB is already a web app, so this is a supported, native
path — better text, one-click setup, page-turn bindings, and pen input, with no
C++ and no config-file tampering.

**This is a toggle, not a migration.** Window capture keeps working and stays
the default. See §5.

Sources — re-read before starting, this API is young and moving:
- <https://openkneeboard.com/api/> · `/api/web-dashboards/` ·
  `/api/web-dashboards/page-based-content/` · `/api/web-dashboards/plugins/`
- <https://openkneeboard.com/faq/third-party-developers/>
- <https://openkneeboard.com/changelog/> — check version gates every time

---

## 1. What the API gives us

Requires **OpenKneeboard v1.9+**. Everything below is behind
`OpenKneeboard.EnableExperimentalFeatures([...])` with dated version numbers —
pin them, do not assume.

| capability | what it buys |
|---|---|
| Web Dashboard tab | WebView2 renders the EFB natively — no capture, no resample |
| `SetPages` / `GetPages` / `pageChanged` | our pages become OKB pages, turned by the pilot's existing HOTAS binding |
| `SetCursorEventsMode("MouseEmulation")` | pen/cursor input into our DOM, no OTD-IPC, no injection |
| Plugin JSON via registry | "Intel Broadcast" appears in OKB's own tab-type list |
| custom actions | HOTAS/StreamDeck-bindable actions delivered as a `plugin/tab/customAction` DOM event |
| `peerMessage`, `GetGraphicsTabletInfo()` | instance messaging; tablet presence detection |

**Detection inside the page:** `window.OpenKneeboard` is set and is a valid
object; the user agent contains `OpenKneeboard/a.b.c.d`. The old `<body>` CSS
classes were **removed in v1.9** — do not rely on them.

## 2. What it does NOT give us

- Quad size and position stay OpenKneeboard's. The legibility maths in
  `design/kneeboard/HANDOFF.md` §2 stays theirs to set. **This remains the only
  real argument for `design/xr-layer/`** — and it is a smaller argument than
  "replace OpenKneeboard".
- We render inside their process and inherit their frame timing.
- The maintainer describes a trust-first stance and says restrictions are
  likely if the APIs are misused. Design for that (see §4).

## 3. Plugin registration — the supported answer to setup friction

A plugin is a JSON file defining custom tab types, discoverable **via the
Windows registry** — the docs name this as the mechanism for third-party
programs with locally running software, which is exactly us.

```jsonc
{
  "ID": "net.flyinggab.intel-broadcast",     // must not collide, ever
  "Metadata": {
    "PluginName": "Intel Broadcast",
    "PluginReadableVersion": "0.8.0",
    "PluginSemanticVersion": "0.8.0",
    "OKBMinimumVersion": "1.9.0",
    "OKBMaximumTestedVersion": "…"           // set to what we actually tested
  },
  "TabTypes": [ /* one web-dashboard tab pointing at our local page */ ]
}
```

**Hard rule, from their docs:** the plugin JSON MUST NOT be written into
`C:\Program Files\OpenKneeboard`, `%LOCALAPPDATA%\OpenKneeboard`,
`Saved Games\OpenKneeboard`, or anywhere else that belongs to OpenKneeboard. It
lives in **our** install dir; the registry value points at it.

**Still forbidden** (unchanged from `design/xr-layer/` §5): writing or reading
OpenKneeboard's configuration files. Their FAQ is explicit that doing so is
likely to break users' config on update and that reading it is unsupported.
The plugin registry entry is the sanctioned path to the same outcome — use it,
and nothing else.

## 4. The brief-mode conflict — decide this first

**The problem.** Presenter-driven page turns are remote-driven by definition.
The page-based docs warn that if `RequestPageChanged()` is misused, future
versions may ignore it **unless called within 100 ms of a cursor event or
custom action**. A FOCUS message off the relay is nowhere near a local cursor
event. So the exact call sync needs is the one flagged for restriction — and if
that lands in a later OKB release, sync breaks silently on someone else's
update. Worst possible failure shape.

**The decision: split the page mapping.**

| surface | mapping |
|---|---|
| Card pages (PLAN / CARD / MAP) | real OKB pages via `SetPages` — small, static, user-driven. HOTAS page-turn works. |
| Intel stage / brief | **exactly one** OKB page. Images swap inside our DOM. |

The presenter changes what is *rendered within* a single page, so OpenKneeboard
never sees a page change and `RequestPageChanged` is never called. The
restriction cannot bite us.

This is better architecture regardless: the intel queue is dozens deep and
changes constantly, and the docs say not to grow the page set unboundedly or
create pages in reaction to page-change events.

**Related traps:**

- **Never use `DoodlesOnly` for brief mode.** It is OpenKneeboard's own
  draw-on-top; those strokes are *local* and would never reach the relay.
  It also disables mouse emulation entirely, so the page stops being
  interactive. Brief-mode ink must be **our** canvas under `MouseEmulation`.
- **Two renderers of one state.** The Electron window and the WebView2 instance
  both connect to the local app and both receive snapshots. That is fine — it
  is the same shape as any two clients — but anything assuming a single
  renderer needs auditing. `PANEL_PROBE` should report which surface it is.
- **Unknown, test in the spike:** does OKB suspend a web dashboard tab when it
  is not the active tab? If so, a following client misses FOCUS while the pilot
  is on their charts tab, then jumps on return. Recoverable via re-request on
  wake — but the wake/reconnect path must exist rather than be discovered in
  the air.
- `data-surface` gains a third value (`window`, `okb`, later `xr`). The
  chrome-hiding CSS is already scoped by it — this is what that attribute was
  for.

## 5. Toggle and guided setup

**Toggle.** SETUP · OPENKNEEBOARD, default **off**. Window capture keeps
working untouched; nothing about the existing path changes. Turning it on
registers the plugin and starts serving the dashboard page; turning it off
unregisters cleanly. A pilot must always be able to go back.

**Guided steps — mirror `tailscale.js` + the NETWORK panel exactly.**
Read `main/tailscale.js` and `renderer/settings/settings.js` before writing
anything; copy the shape, not just the look.

```
01  OPENKNEEBOARD FOUND     InstallationBinPath / InstallationUtilitiesPath in HKCU
02  VERSION SUPPORTED       >= 1.9.0, else say which version is needed
03  PLUGIN REGISTERED       our registry value present and pointing at our JSON
04  TAB ADDED               window.OpenKneeboard has connected to us   <- ground truth
```

Two conventions from the shipped panel that must carry over:

- **Steps are STATUS, not controls.** `settings.js` carries a design note on
  this: the steps used to hold hidden click handlers, which meant a pilot
  could click something that looked inert. There is **one** button on the
  panel, and its label and action follow whichever step actually needs doing.
- **Only step 04 is ground truth.** 01–03 exist to explain *why* 04 has not
  happened. Same rule as the tanker/divert probe order and the OTD-IPC pipe
  check in `design/xr-layer/` §4.

Registry reads are cheap and synchronous; no `execFileSync` probing needed,
unlike Tailscale.

## 6. Suggested order

1. **Spike (1–2 days).** Serve the EFB as a web dashboard by hand, call
   `SetPages` with PLAN/CARD/MAP, look at the Foxhunt card in WebView2 through
   the Crystal Light. Answers: text quality vs capture, tab suspension, cursor
   behaviour, actual v1.9 API shape.
2. **Brief mode** (`design/brief-mode/`) built with the §4 split assumed from
   the start — one OKB page for the stage.
3. **Plugin registration + guided setup panel.**
4. Re-judge `design/xr-layer/` on what is *left*: quad control only.

## 7. Honest gaps

- **No code has been run against any of this.** It is read from documentation
  dated to versions we have not tested. Every version gate, feature name and
  dated `EnableExperimentalFeatures` number must be re-checked.
- We do not know whether WebView2 renders B612 and the mid-tone palette the
  same as Electron's Chromium. Probably; verify in the spike, because the whole
  card design assumes exact type metrics.
- The `RequestPageChanged` restriction is a *documented possibility*, not
  current behaviour. §4 avoids it by construction, which costs nothing — but do
  not report it as a live bug.
- Version drift already caught one error in `design/xr-layer/`: settings have
  **already** moved to `%LOCALAPPDATA%\OpenKneeboard`, which that handoff
  described as a future plan. Assume more drift.
