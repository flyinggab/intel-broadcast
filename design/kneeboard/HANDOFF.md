# Kneeboard cards

**Status** — **built and rendering.** Phase 2 (`/ROADMAP.md` §2).
The card renders at 893 × 1263 with the paper palette, the four-column route,
current-step emphasis and click-to-tick. `dev-card-geometry-test` measures the
real render: **0 clipped values** on both the example card and a deliberately
full one.

Two things remain, both recorded in §7:
- the **height budget is not enforced at import**; `card.js` carries the
  measured model but it comes out ~132px light, so it is documented and
  disabled rather than wrong;
- the **TANKER time column was dropped** to make the row fit (see §7).
**Supersedes** the earlier version of this file. Two decisions in it were wrong
and are corrected in §1: the legibility floor, and the PLAN / CARD page split.

**Files here**

| | |
|---|---|
| `kneeboard-paper.png` | the mockup this handoff describes |
| `strike-package.layout.yaml` | layout template — shape only, no data, no style |
| `foxhunt2-roman1.card.json` | one card that uses it |
| `verify-bindings.js` | `node verify-bindings.js` — every binding resolves |
| `density-preview.html` | older prototype at 625 × 884; kept for the density control only |

Pilots keep mission cards as printed PDFs and alt-tab, or strap paper to a
thigh. This brings them into the EFB as data — so the card knows where in the
route you are, and so a lead can eventually push one to the whole package.

---

## 1. Two corrections to the earlier design

### The legibility floor was set too high

The earlier version claimed ≥20′ cap height for comfort and <15′ unreadable.
That is a *reading-a-document* threshold. Measured against the artifact pilots
already fly:

```
A4 card, 10pt Helvetica, cap 2.47 mm, at ~600 mm  =  14.1 arcminutes
```

The paper card everyone finds perfectly usable sits at **14′**. The Crystal
Light resolves ~27.4 px/degree, so a 5-px cap — the practical floor for glanced
text — is **10.9′**.

**Corrected scale:** ~11′ floor · **14′ is paper parity** · 16′+ comfortable.

The old numbers cost real density. The first mockup ran at 93% of the paper
card's line count when 135% was available.

### The card is ONE page, not three

The earlier design split PLAN / CARD / MAP. That was a consequence of treating
the surface as 625 × 884, and it is the wrong shape for the job: **paging to
find your bullseye mid-flight is exactly the failure a kneeboard exists to
prevent.**

At **893 × 1263** (density 0.7, still A4 proportion) the whole card fits:

| block | height |
|---|---|
| header band — callsign, bullseye, S-A, A-A, loadout | 76 |
| ROUTE — header + 17 rows @ 29 | 522 |
| TARGETS — header + 4 rows @ 27 | 135 |
| comms — COMM 1 / COMM 2 + MIDS / TANKER · DIVERT, three columns | 236 |
| GAME PLAN | 104 |
| **total** | **1129** of 1219 body — 90 px spare |

Only MAP stays a second page, because it is an image.

**The four-column route table is back.** It needs 561 px and 893 leaves 316 px
of slack, so STEP / REF / ALT-SPD / NOTES read on *every* row. The earlier
`steps` block existed to collapse rows for space at 625 wide; that reason is
gone. **Current step is emphasis, not expansion** — raised, go bar, reading
NOW; flown steps tick and dim. Nothing collapses.

Seventeen steps, not eleven: the earlier list stopped at RTB. The recovery —
feet wet, marshal, push, Case I, trap, bolter-to-divert — is the part you need
when it is going wrong.

---

## 2. Paper palette — a documented exception

**The card does not use the shipped mid-tone tokens.** Deliberate; do not
"fix" it back.

The greys in `tokens.css` exist so a recon photo does not blow out against its
surround: a photo needs a neutral mid-tone frame, and the 4.2:1 contrast
ceiling that follows is an accepted cost. **A dense text card is the opposite
problem.** It wants maximum contrast at small sizes, which is precisely what
paper has and what a mid-tone ground structurally cannot provide.

```
paper   #E9E5DA    raised  #F2EFE6    recessed/bands  #D9D4C6
rules   #BFB9A8    ink     #1F1C16    secondary #6A6255   tertiary #5E584C
threat  #A33224    go      #3F6B22    band text #EDE9DE on #3A362D
```

Measured, all AA or better on paper:

| | ratio |
|---|---|
| ink on paper | **13.50 : 1** |
| band text on dark band | 9.92 : 1 |
| tertiary | 5.61 : 1 |
| threat | 5.49 : 1 |
| go | 5.00 : 1 |
| secondary | 4.78 : 1 |

Threat red and go green were **re-picked for a light ground** — the shipped
`--fault` and `--go` measured 2.95:1 and 4.04:1 here and were rejected. Do not
paste the shipped hexes in.

Two structural consequences: bevels invert (raised is *lighter*, recessed
darker, and a 1 px rule replaces the two-tone edge), and section headers become
dark bands with paper text, the way printed cards do it.

Ship this as a **surface-scoped token set**, not a fork of `tokens.css` — the
stage and photo chrome keep the mid-tones. Where cards render, paper applies.

---

## 3. Hold to tick a step

A 44 px lane on the right of the route table, one 22 px ring per row.

- **A tap does nothing.** The ring fills clockwise while the press is held and
  commits only at the end. Suggested 600 ms; tune with a pen in hand.
- Flown steps show a filled ring with a tick, and dim their row.
- Releasing early leaves the ring empty — no partial state.

**Why the long press:** with a pen on a tablet under turbulence a stray tap
must never mark a step flown, and **a wrongly ticked step is worse than an
unticked one, because it reads as progress.** Same class of reasoning as the
drag-region trap in the window controls: the failure is silent.

**Open, and worth deciding before building:**

- The ring uses go green. The palette rations that hue to "requirement
  satisfied", which a ticked step arguably is — but seventeen of them is a lot
  of green on one page. Consider ink-filled, with the hue reserved for the
  *current* step alone.
- **Ticking is local in this design.** Whether a lead ticking a step pushes to
  the flight is the same question as brief mode's FOCUS, and the same machinery
  answers it. Do not invent a second mechanism — if it ships, it ships as a
  brief message on `/rt`.
- Interaction needs a pointer. Pilots viewing through OpenKneeboard capture
  with no input cannot tick. Acceptable — the row still highlights as current —
  but the card must never *require* a tick to advance.

---

## 4. Unchanged from the earlier design

These were right and carry over intact.

**Template / content split.** `*.layout.yaml` is shape only — no mission data,
no colours, no px, no fonts. `*.card.json` names a layout and supplies the
paths. One template renders every card whose JSON matches.

**Four binding rules.**

| syntax | meaning |
|---|---|
| `"{path}"` | render a value |
| `"{path\|dash}"` / `"{path\|blank}"` | fallback when missing |
| `repeat: a.b` | one row per array element |
| `when: a.b` · `mark: field` | omit a block · flag a row |

**Braces mean render; bare paths mean test or source.** `bind`, `when`,
`repeat` and `mark` never take braces. That inconsistency produced a real bug
once — keep it.

**Style belongs to the EFB.** Templates say `emphasis: threat|strong|muted` and
`width: badge|xs|sm|md|flex`. Never appearance. A card that can carry style is
a card that can break the cockpit, and in phase 4 the same content renders into
a VR quad where an author's pixel choices are meaningless.

**Block types are a closed set** — `fields` · `steps` · `table` · `stations` ·
`prose` · `image`. Adding one is a code change; that is the mechanism by which
style stays owned.

**Everything on the page is bound.** Including threat lines, the loadout title
(`STATION {flight.stationOrder}` — not every airframe counts 9→1) and the bingo
chip. If a renderer needs a string the card does not supply, the template is
wrong, not the card.

---

## 5. To build

**Where it lives.** `DESTINATIONS` gains a CARD entry in the **`mission`**
group — which exists in `GROUPS` and renders nothing today. CARD and MAP are
two entries, not a rail.

**On the OpenKneeboard surface, card pages become real OKB pages.** This is the
opposite case to the intel stage (`design/okb-integration/HANDOFF.md` §4): CARD
and MAP are small, static and user-driven, so `SetPages` is right and the
pilot's existing HOTAS page-turn binding works on them. The intel stage stays
exactly one page. Do not conflate the two.

**Import-time validation, and make it loud.** The main failure mode, fully
checkable before a pilot ever sees the card:

- schema shape, and every path in `requires`
- every `{path}` resolves or has a fallback
- **string widths against the column they will land in**, using B612 metrics —
  fail with *"route.steps[6].note needs 340px, column is 280px"*

`verify-bindings.js` is the seed (157 placeholders, green). It has already
caught two real bugs. Fold it in rather than rewriting it; the piece it does
not yet do is the width check.

**Treat cards as untrusted.** Once these travel the relay a card is a file from
another pilot. `textContent` only, never `innerHTML`. No script, no remote URLs.
Images ride the content-addressed blob store by hash, so a card cannot phone
out. Validate before render; reject on failure.

**i18n.** Block titles come from the card and are the author's words — leave
them. Everything the app adds (NOW, DONE, empty states, import errors) goes
through `i18n.js` in both locales.

**Brief lock.** A follower's view is held during a brief. Whether CARD stays
reachable while held is undecided — but the root rule applies: a stale lock
must never trap a pilot, and the route to SETUP must always survive.

---

## 6. Open

- **Density as a setting.** `density-preview.html` prototypes COMFORTABLE /
  NORMAL / DENSE / MAXIMUM. This card is designed *at* 0.7 rather than offering
  the knob. Whether a pilot may move it is unresolved; a knob they can set
  wrong is a cost, and 0.64 drops the smallest text to 12.8′ at a 40° quad.
- **Static or pushed.** Drawn here as a card you load. The Tier A version is
  the lead publishing it and every kneeboard filling in — that needs typed
  artifacts on the wire (`/PROTOCOL-V2.md`). The data model is already the
  right shape; do not design a second one.
- **Which templates ship.** `strike-package` covers strike and CAS. Whether
  pilots may add their own *templates*, or only their own *content*, is
  unresolved. **Content-only is the safer first move** — an author-supplied
  template is a far larger validation surface.
- Emergency procedures, a divert fuel ladder and a threat-ring reference are
  the obvious next blocks. There is 90 px spare and a whole second page free.

## 7. Honest gaps

- **It has now been seen rendered, and it was clipping 16 values.** The claim
  below — that layout was "verified by measuring every string against its
  container" — was not true of the built card. `dev-card-geometry-test` renders
  it in Electron with the real B612 and reports every string wider than the box
  it landed in. On the first run: 16, on both cards, including the **BULLSEYE**
  (`N29 09'58.8 E53 07'38.6` needed 254px in 214) and the **S-A threat list**
  (losing MANPAD). Cells carry `text-overflow: ellipsis`, so each one rendered
  as a shorter, entirely plausible value — no error, nothing visibly broken,
  and a pilot reading a bullseye missing its eastings.

  Fixed: the header band sizes to content rather than equal quarters; the route
  gave 14px of name to its ref; the comms columns are allocated from measured
  need rather than thirds; and the **TANKER time column was dropped**, because
  five cells per row needed 447px in a 429px column and no allocation fitted
  all three blocks at once. That was the owner's call between merging
  altitude/heading, dropping the time, and giving TANKER a full-width row.

- **The height budget is not enforced.** `card.js` has `pageHeight()` with
  constants measured off the real render, but it totals ~132px less than the
  browser produces — consistently on both cards, so something structural is
  missing rather than a row height being off. It is deliberately NOT wired into
  the refusal: a model wrong in the safe direction passes cards that then render
  off the bottom of the sheet, which is the exact failure it exists to prevent.
  The harness already reports per-block measured heights; put them beside
  `pageHeight()`'s breakdown and the 132px will name itself.
  `scripts/fixtures/card-full.card.json` is deliberately over-long and the
  geometry test asserts it still overflows, so the check cannot rot.

- **Nothing here has been seen in a headset.** Contrast is computed WCAG
  ratios and the arcminute figures are arithmetic. Trust your eyes over them.
- **The mockup is an SVG, not app code.** It does not exercise flex, wrapping,
  or the real font stack.
- **The example card is one mission.** A second real card from a different
  airframe would likely expose paths this template lacks. Convert one before
  committing to the schema.
- **The 893 × 1263 surface does not exist yet.** `scaling.js` produces
  625 × 884 at 1080p. Reaching this density means either the density setting or
  the OpenKneeboard web-dashboard surface, where the tab size is ours to pick.
  Decide which before building the layout.
- **The template and card in this folder were updated to match** — one `card`
  page plus `map`, header band, four-column route with a `complete:` flag,
  targets carrying coordinates and weapon. `verify-bindings.js` is green at 155
  placeholders. If a future mockup and the template disagree, the template and
  this handoff win; the image is stale.
- **The example card supplies 11 route steps, not the 17 §1 calls for.** It
  still stops at RTB. `app/scripts/fixtures/card-full.card.json` is a TEST
  card that carries all 17, recovery included, with fictional numbers — it
  exists to prove the template survives a card that fills the sheet, and says
  so in its own title. The real `foxhunt2-roman1.card.json` still needs a
  pilot's numbers; `dev-card-test` prints the shortfall rather than asserting
  either count.
- **Measured against the real render, the full card leaves 152px spare**, not
  the 90 §1 predicts, and its content is 1071px rather than 1129. The
  difference is block heights: the estimate was made from the mockup, this is
  the app laying out B612 at these widths. There is more room than the design
  thought, which is the direction to be wrong in — the emergency-procedures
  and divert-ladder blocks §6 wants have somewhere to go.
- **Its map blob was `sha256:2f1c9e…`** — an ellipsis, which can never resolve
  to a blob. Replaced with a real digest so the example validates. Watch for
  the same in any card converted by hand.
- **The template uses three filters, not the two §4 documents:** `dash`,
  `blank` and `none`. `none` is different in kind — it is the literal enum
  value for "no state" (`{state|none}`, `{kind|none}`), so every row reaches
  the renderer with a state string rather than an absent one. Implemented as
  such in `main/card.js`.
- One real clip was found by measurement in the previous mockup — status text
  right-aligned over the CARD / MAP keys, a 30 px overlap. Measure the strip
  lanes; do not eyeball them.
