# Intel Broadcast

Electron companion app for DCS World: any pilot broadcasts recon/intel photos to every connected
pilot's screen via a hotkey, captured by OpenKneeboard on each pilot's PC. One instance hosts the
relay (the center node) and exposes it to the internet via Tailscale Funnel.

**Before doing anything else, read `HANDOFF.md` in the repo root.** It is written to let a fresh
session resume without re-deriving anything: current state, the architecture in one page, the
invariants you must not undo, the class contract, how to verify, the environment traps, and the
next task.

Doc map:
- `HANDOFF.md`  — **start here.** Current state, invariants, traps, next task
- `CHANGELOG.md`— what shipped per release
- `ROADMAP.md`  — four phases; §5 is what phase 1 must not foreclose
- `PROTOCOL.md` — current wire format, authoritative
- `PROTOCOL-V2.md` + `protocol-vectors.json` — v2 design, needed for phase 2
- `BRIEF.md`    — phase 1 spec, historical. Its §4 class contract is **superseded** by
  `HANDOFF.md` §4; its token and spacing rationale still holds
- `app/PLAN.md` — historical: good on the original architecture and the v0.2.0 packaging
  post-mortem, wrong about current state (it reports v0.2.1)

## Quick facts

- Repo: this directory, pushed to `https://github.com/flyinggab/intel-broadcast` (public).
- App code lives in `app/`. Tests are plain `node app/scripts/dev-*-test.js`, no framework —
  see `HANDOFF.md` §5 for the loop and the two scripts that need arguments.
- `npm start` in `app/` runs the app. Everyone shares and receives; the "Who hosts the squad?"
  choice in SETUP → NETWORK (`relayHostEnabled`) picks the center node.
- To test two instances on one machine: give each terminal its own
  `INTEL_BROADCAST_LOCAL_CONFIG_PATH` env var — see `README.md`.
- Releases are built by `.github/workflows/release.yml` on GitHub Actions, triggered by pushing
  a `v*` tag. Bump `app/package.json` first.
- UI lives in `app/src/renderer/` — `viewer.html` (ONE window: BRIEF, RECEIVED, SHARE and
  SETUP are all pages of it), `css/`, `i18n.js`, vendored B612 fonts. Serve that folder over
  HTTP and open `preview.html` to drive the **real** render functions with fake snapshots, no
  Electron needed.
- **All viewer state lives in `app/src/main/viewState.js`.** The renderer holds none — read
  `HANDOFF.md` §3 before changing that.
- **Every user-facing string goes in `app/src/renderer/i18n.js`, in both `en` and `it`.**
  `dev-i18n-test` fails on a key present in one and missing in the other. Console and log lines
  stay English on purpose.
- Icon: edit `app/branding/*.svg`, then `node scripts/dev-make-icons.js` (macOS only) and commit
  what lands in `app/build/` and `app/src/renderer/img/`. Never edit the PNGs.

## Working environment

**Development moved to macOS (Apple Silicon) on 2026-07-30.** Everything before that was written
from a WSL/Linux sandbox, so re-read environment claims in `app/PLAN.md` with that in mind: the
caveats recorded there (Electron `capturePage()` screenshot verification being unreliable, System
Tray icons not showing, GUI windows landing on the real Windows desktop via WSLg) were **WSL
artifacts, not app bugs**. Don't carry them forward as known limitations, and don't treat a
workaround as load-bearing just because it exists — check whether it was only there for WSL.

**The trap that wastes the most time:** if the packaged `Intel Broadcast.app` is running, it holds
the single-instance lock and every dev instance exits **code 0 with no output** — it reads exactly
like a broken build. Symptom: an Electron test failing with an empty `--- full output ---`. Check
`ps aux | grep -i "Intel Broadcast"`; to diagnose without quitting it, pass
`--user-data-dir=/tmp/ib-scratch`. More traps in `HANDOFF.md` §6.

**Target platform is still Windows.** DCS and OpenKneeboard are Windows-only, so the part that
actually matters — a captured window on a pilot's knee — cannot be verified here at all. macOS is
for code, UI and protocol work; the kneeboard capture path needs a real Windows test before any
release. Releases are built on GitHub Actions regardless, so cross-compilation is a non-issue.

Prerequisites: Node and npm on `PATH` (`brew install node@22` — the current `node` formula has no
bottle for macOS 14). `python3` for the preview server. GUI windows launched here are visible to
the user — don't spawn test instances without saying so.
