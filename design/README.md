# `design/` — features being designed ahead of implementation

Each subfolder is one planned feature: the design decisions, the measurements
behind them, and whatever artifacts a implementing session needs. **These are
handoffs, not specifications of shipped behaviour** — for what the app does
today, read `/HANDOFF.md` and `/CHANGELOG.md` at the repo root.

## Convention

```
design/<feature>/
  HANDOFF.md      what to build, why, and what is already decided
  *.yaml *.json   schemas, examples, fixtures
  *.html          static previews, openable in a browser
  verify-*.js     runnable checks — plain node, like app/scripts/dev-*-test.js
```

Every `HANDOFF.md` here should carry, near the top:

- **Status** — designed / in progress / shipped, and the phase from `/ROADMAP.md`
- **Decided** — settled choices, with the reasoning, so they are not re-litigated
- **Open** — what the implementing session must decide, and what it must not
- **Measured** — numbers that were computed rather than guessed, with the method,
  so they can be re-derived when something changes

When a feature ships, leave the folder. The reasoning is worth more later than
the file tidiness is now — move the *status* to shipped and note the release.

## Folders

| feature | status | phase |
|---|---|---|
| `kneeboard/` | designed, not started | 2 |
| `brief-mode/` | designed, not started | 2 (Tier A) |
| `xr-layer/` | researched, not started | 4 |
