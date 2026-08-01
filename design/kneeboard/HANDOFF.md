# Kneeboard cards

**Status** — designed, not started. Phase 2 (`/ROADMAP.md` §2).
**Files here**

| | |
|---|---|
| `strike-package.layout.yaml` | the layout template — shape only |
| `foxhunt2-roman1.card.json` | one card that uses it |
| `verify-bindings.js` | `node verify-bindings.js` — checks every binding resolves |
| `density-preview.html` | static prototype, open in a browser |

Pilots keep their mission cards as printed PDFs and alt-tab or strap paper to a
thigh. This brings them into the EFB as data, so the card can know where in the
route you are, and — once protocol v2 lands — so a flight lead can push one to
the whole package.

---

## 0. Read this first: the surface is bigger than the preview says

Three different sizes exist in the repo right now, and only one is real.

| | | |
|---|---|---|
| `app/src/renderer/preview.html` | **430 × 604** | 32% too narrow |
| `app/scripts/fixtures/geometry-harness.js` | **850** wide | ~1440p case |
| Real window, 1080p work area | **625 × 884** | what a pilot gets |

`computeViewerBounds({1920,1040})` → `884` tall (0.85 of work area), `625` wide
(A4), `zoom 1.00`. On larger displays the window grows *and* zoom grows to
match, so the CSS surface stays ~625 × 884 everywhere. **More pixels currently
buy bigger text, not more content** — that is deliberate.

**Fix `preview.html` to 625 × 884 before laying anything out.** Any layout tuned
by eye against 430 px is tuned against a fiction. This is one line and it is the
cheapest correctness win available.

---

## 1. Decided

### Cards are data, and layout is separate from content

Two files. Neither contains style.

- **Layout template** (`*.layout.yaml`) — shape only. Which blocks, which
  column, what repeats. No mission data, no colours, no px, no fonts.
- **Card content** (`*.card.json`) — the mission. Names a `layout` and supplies
  the paths the template binds to.

One template renders every strike card whose JSON matches the same paths.
`strike-package.layout.yaml` here is that template; `foxhunt2-roman1.card.json`
is one card that uses it.

### The binding language is four rules

| syntax | meaning |
|---|---|
| `"{path}"` | render a value |
| `"{path\|dash}"` / `"{path\|blank}"` | fallback when missing |
| `repeat: a.b` | one row per array element |
| `when: a.b` · `mark: field` | omit a block · flag a row |

**Braces mean render. Bare paths mean test or source** — `bind`, `when`,
`repeat` and `mark` never take braces. Keep that; it was inconsistent in the
first draft and the inconsistency produced a real bug (see §4).

### Style belongs to the EFB, always

Templates say `emphasis: threat | strong | muted` and
`width: badge | xs | sm | md | flex`. Semantic, never appearance. The renderer
decides that `threat` is `--fault`, that `state: current` gets the `--go` bar
and the open row.

This is not tidiness. In phase 4 the same card renders into a VR quad where an
author's pixel choices would be meaningless, and the palette invariants
(`/HANDOFF.md` §3, two rationed hues, 4.2:1 mid-tone ceiling) cannot be
enforced against arbitrary author CSS. **A card that can carry style is a card
that can break the cockpit.**

The source kneeboard colour-codes seven phases — REJOIN, AAR, POP-UP, IP, TGT,
LAZ, BOUNCE. None survive, and they should not: a mid-tone surface cannot carry
seven hues at 4.2:1 anyway. Phase reads from position and label. Red survives
once, on threats, because that is a warning.

### Block vocabulary is a closed set

`fields` · `steps` · `table` · `stations` · `prose` · `image`

Adding a block type is a code change. That is the mechanism by which style
stays owned — an author composes from blocks, never invents one.

### One step is open at a time

The reason to port a card rather than screenshot it. Paper shows all 17 route
rows because paper cannot know where you are. The card can: the current step
carries ref, gate and notes; the rest collapse to name + gate; completed steps
get a tick. `state: done | current | none` in the content drives it.

### Three pages, and every one of them is data

| page | carries |
|---|---|
| **PLAN** | threats, callsign, bullseye, loadout, game plan |
| **CARD** | route, targets, COMM 1, MIDS, tanker · divert |
| **MAP** | the route map, full bleed |

**Nothing on any page is hard-coded in the renderer.** That includes the threat
lines, the loadout title (`STATION {flight.stationOrder}` — not every airframe
counts 9 to 1), and the bingo chip. If a renderer needs a string the card does
not supply, the template is wrong, not the card.

Threats live on PLAN rather than CARD: they are briefing material you read
before you step, not something you consult mid-route. The first draft had them
on CARD and the mockup drew them on PLAN — that disagreement is resolved in
favour of PLAN.

A fourth rail entry, **NOTE**, is drawn in the mockup and deliberately not
specified. A scratchpad is Tier C (`/ROADMAP.md` §2.1) — it needs input you
cannot reliably give in VR until phase 4. Decide whether it appears at all
before then; an empty destination is worse than no destination.

### Targets are not route steps

WP10–13 were four near-identical rows in the middle of the route. They are a
set you work, not a sequence you fly. Separate `table` block below the route.

---

## 2. Measured

Re-derive these when something changes; do not trust them blind.

**Legibility in the headset.** Headset resolution *cancels out*:

```
cap-height-arcmin  =  cssSize × 0.70 × quadDegrees × 60 ÷ surfaceHeightCss
```

≥20′ reads comfortably · 15–20′ is a squint · <15′ will not resolve.
So **enlarging the OpenKneeboard quad buys legibility for free; density spends
it.** At 625 × 884 with a 35° quad, 10.5 px text is 17.5′ — usable. The same
text at a 25° quad is 12.5′ — not. Quad size matters more than anything in CSS.

**The card fits at default density.**

| column | needs | available |
|---|---|---|
| steps + targets | 548 px | **840 px** |
| COMM 1 + MIDS + tanker/divert | 552 px | **840 px** |

Two columns at `split: 0.6` → 351 px and 234 px at 625 wide. No scrolling.

**A four-column route table does not fit**, which is why `steps` is a block type
rather than a `table`: 642 px at 13 px type against 625 px of glass. It fits at
12 px, which is below what the Crystal Light resolves at a typical quad.

**Binding was verified, not assumed.** `verify-bindings.js` resolves all **157**
placeholders against the example card — 11 route steps, 4 targets, 8 COMM 1
channels, 4 MIDS, 4 tanker/divert with exactly 1 `next` flagged, 9 stations,
plus the PLAN fields. Run it before trusting any edit to either file; fold it
into the import-time validator rather than rewriting it.

It has already earned its place twice. It caught `mark: "{next}"` being written
as a placeholder when it is a boolean test — rows without the field came back
unresolved — which is why braces now mean *render* and bare paths mean *test or
source*. And it caught the hard-coded loadout title when PLAN was moved onto
bindings.

---

## 3. To build

**Renderer.** One function per block type, driven by the snapshot like every
other page. `viewer.js` `DESTINATIONS` gains a `CARD` entry in the **`mission`**
group — which already exists in `GROUPS` and renders nothing today. Sub-pages
(CARD / PLAN / MAP) use a rail, the pattern SETUP already has.

**Import-time validation, and make it loud.** This is the feature's main
failure mode and it is fully checkable before a pilot ever sees the card:

- schema shape, and every path in `requires`
- every `{path}` resolves or has a fallback
- **string widths against the column they will land in**, using the B612
  metrics — fail with *"route.steps[6].ref needs 340px, column is 280px"*.
  A card that overflows in the cockpit is a card that should not have imported.

**Treat cards as untrusted.** Once these travel the relay a card is a file from
another pilot. `textContent` only, never `innerHTML`. No script, no remote URLs.
Images ride the existing content-addressed blob store by hash, so a card cannot
phone out. Validate before render; reject on failure.

**i18n.** Block *titles* come from the card and are the author's words — leave
them. Everything the app adds around them (`CURRENT`, empty states, import
errors) goes through `i18n.js` in both locales, per the root handoff.

**Where cards live.** A `cards/` folder beside `photos/`, plus a file picker in
SETUP. Same JSON either way.

---

## 4. Open — decide, then write it down

- **Density setting.** `density-preview.html` prototypes COMFORTABLE / NORMAL /
  DENSE / MAXIMUM as a `uiScale` nudge. **This card does not need it** — it fits
  at default with ~290 px spare. It is for denser cards later (checklists,
  brevity, an eight-ship lineup). Ship the layout first; add the knob only when
  content demands it. A knob a pilot can set wrong is a cost.
- **Static or pushed.** Drawn here as a card you load. The Tier A version is the
  flight lead publishing it and every kneeboard filling in — that needs typed
  artifacts on the wire (`/PROTOCOL-V2.md`). The data model above is already
  the right shape for it; do not design a second one.
- **Tanker and divert are merged** into one table here, because airborne they
  answer the same question. The source card had them separate. Splitting back is
  two `table` blocks — the author's call, not the app's.
- **Which template ships built in.** `strike-package` covers strike and CAS.
  Whether pilots can add their own templates, or only their own content against
  templates the app ships, is unresolved. **Shipping templates only is the safer
  first move** — an author-supplied template is a much larger validation surface,
  and content-only still covers most of the need.

---

## 5. Honest gaps

- **Nothing here has been seen rendered.** Layout was verified by measuring
  string widths against containers using real B612 metrics, and by the binding
  check in §2 — but no one has looked at it in the app. Trust your eyes over
  these numbers.
- **The mockups behind this were drawn at 430 × 604**, before the surface
  discrepancy in §0 was found. Column proportions here are recomputed for
  625 × 884, but any *visual* judgement from that earlier work was made in a
  box a third too narrow.
- **`density-preview.html` is a static prototype**, not app code. It fakes the
  surface with a CSS transform. It is for seeing the trade, not for copying.
- **The mockup and the template drifted once already.** Threats were drawn on
  PLAN and specified on CARD, and nothing caught it because the mockup is an
  image and the template is a file. When you build the renderer, the mockup
  stops being authoritative — the template plus this handoff are. If they
  disagree again, the template wins and the image is stale.
- **The example card is one mission.** A second real card from a different
  airframe would likely expose paths this template does not have. Convert one
  before committing to the schema.
