# Intel Broadcast

Electron companion app for DCS World: any pilot broadcasts recon/intel photos to every connected
pilot's screen via a hotkey, captured by OpenKneeboard on each pilot's PC. One instance hosts the
relay (the center node) and exposes it to the internet via Tailscale Funnel.

**Before doing anything else, read `HANDOFF.md` in the repo root.** It has the
current state, the four-phase roadmap, the invariants you must not undo, and
your task. `app/PLAN.md` is **historical** — accurate on the original
architecture and the v0.2.0 packaging post-mortem, wrong about current state
(it predates the phase 1 UI rebuild). Trust `git log` and `HANDOFF.md`.

Doc map:
- `HANDOFF.md`  — start here, current state + next task
- `ROADMAP.md`  — four phases; §5 is the list of things phase 1 must not foreclose
- `PROTOCOL.md` — current wire format, authoritative
- `PROTOCOL-V2.md` + `protocol-vectors.json` — v2 design, needed for phase 2
- `BRIEF.md`    — phase 1 spec, historical; §4 still has the CSS class contract
- `app/PLAN.md` — historical

## Quick facts

- Repo: this directory, pushed to `https://github.com/flyinggab/intel-broadcast` (public).
- App code lives in `app/`. Run tests with plain `node app/scripts/dev-*.js` (no test framework) —
  see `HANDOFF.md` §4 for the verification loop. (`app/PLAN.md` describes what most of them cover,
  but predates phase 1 deleting the side-panel tests.)
- `npm start` in `app/` runs the app. There is no GM vs. viewer mode any more — everyone shares
  and receives; a "Host the relay" Settings checkbox (`relayHostEnabled`) picks the center node.
- To test two instances on one machine: give each terminal its own
  `INTEL_BROADCAST_LOCAL_CONFIG_PATH` env var — see `README.md`.
- Releases are built by `.github/workflows/release.yml` on GitHub Actions (can't cross-compile
  Windows/Mac from this Linux dev environment) — triggered by pushing a `v*` tag.
- UI lives in `app/src/renderer/` — `viewer.html`, `settings.html`, `css/`,
  vendored B612 fonts. Open `preview.html` over a local HTTP server to see every
  state without launching Electron.
- All viewer state lives in `app/src/main/viewState.js`. The renderer holds
  none — see HANDOFF.md §2 before changing that.

## Working environment

**Development moved to macOS (Apple Silicon) on 2026-07-30.** Everything before that was written
from a WSL/Linux sandbox, so re-read environment claims in `app/PLAN.md` with that in mind: the
caveats recorded there (Electron `capturePage()` screenshot verification being unreliable, System
Tray icons not showing, GUI windows landing on the real Windows desktop via WSLg) were **WSL
artifacts, not app bugs**. Don't carry them forward as known limitations, and don't treat a
workaround as load-bearing just because it exists — check whether it was only there for WSL.

macOS has its own gates, none of them verified on this machine yet: `globalShortcut` and any
screen capture need TCC permissions (Accessibility / Screen Recording) granted to the terminal or
the app bundle, and the first run will prompt for them.

**Target platform is still Windows.** DCS and OpenKneeboard are Windows-only, so the part that
actually matters — a captured window on a pilot's knee — cannot be verified here at all. macOS is
for code, UI and protocol work; the kneeboard capture path needs a real Windows test before any
release. Releases are built on GitHub Actions regardless, so cross-compilation is a non-issue.

Prerequisite: Node and npm on `PATH` (the dev scripts and `npm start` need them; `ws` is required
by `dev-auth-test` and `dev-hardening-test`). GUI windows launched here are visible to the user —
don't spawn test instances without saying so.
