'use strict';

// Runs inside OpenKneeboard's WebView2 when the EFB is loaded as a web
// dashboard tab. In the Electron window it detects nothing and does nothing.
//
// See design/okb-integration/HANDOFF.md. The decision that shapes this whole
// file is its §4:
//
//   THE INTEL STAGE IS EXACTLY ONE OPENKNEEBOARD PAGE.
//
// Images swap inside our DOM; OpenKneeboard never sees a page change for
// them. This is not a detail to revisit later. Presenter-driven page turns
// are remote-driven by definition, and OpenKneeboard's page-based docs warn
// that RequestPageChanged() may in future be ignored unless it is called
// within 100ms of a local cursor event or custom action. A FOCUS message
// arriving off the relay is nowhere near a cursor event — so the exact call
// brief-mode sync would need is the one flagged for restriction, and if that
// lands in a later OpenKneeboard release, sync would break silently on
// someone else's update. Mapping the stage to one page means the call is
// never made and the restriction cannot bite. It is also better regardless:
// the intel queue is dozens deep and changes constantly, and their docs say
// not to grow the page set unboundedly.
//
// Card pages (PLAN / CARD / MAP, when they exist) are the opposite case —
// small, static, user-driven — and those DO become real OKB pages so the
// pilot's existing HOTAS page-turn binding works on them.

(function () {
  const api = typeof window !== 'undefined' ? window.OpenKneeboard : null;

  // Detection, per their docs for v1.9+: the object exists, and the user
  // agent names the version. The old <body> CSS classes were REMOVED in v1.9
  // — do not go back to sniffing those.
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const versionMatch = /OpenKneeboard\/([0-9.]+)/.exec(ua);
  const present = Boolean(api && typeof api === 'object');

  if (!present) {
    // The Electron window. `data-surface` stays "window" and every
    // chrome-hiding rule keeps working exactly as before.
    if (typeof window !== 'undefined') window.__okb = { active: false, version: null };
    return;
  }

  const version = versionMatch ? versionMatch[1] : null;

  // The third surface. base.css scopes all chrome-hiding to
  // body[data-surface="window"], which is precisely why that attribute was
  // never redundant: inside OpenKneeboard the composition rules are theirs,
  // not ours, and the capture-clean idle timer makes no sense here.
  document.body.dataset.surface = 'okb';

  const state = { active: true, version, pages: [], cursorMode: null, errors: [] };
  window.__okb = state;

  /** Everything below is behind experimental gates with dated version
   *  numbers that MUST be re-checked against the changelog — they are not
   *  stable API. A failure here degrades to a page that still renders and
   *  still receives intel; it just loses paging and pen input. */
  async function enable(features) {
    try {
      if (typeof api.EnableExperimentalFeatures !== 'function') return false;
      await api.EnableExperimentalFeatures(features);
      return true;
    } catch (err) {
      state.errors.push(String(err && err.message ? err.message : err));
      return false;
    }
  }

  async function init() {
    // Pin the gates. Names and dates are from documentation, not from a run
    // against a real build — see the honest gaps in the design handoff.
    await enable([
      { Name: 'PageBasedContent', Version: 2021 },
      { Name: 'SetCursorEventsMode', Version: 2021 },
    ]);

    // ONE page for the stage. When card pages arrive they are appended here,
    // and only they get real page identities.
    try {
      if (typeof api.SetPages === 'function') {
        state.pages = [{ guid: crypto.randomUUID ? crypto.randomUUID() : 'stage', pixelSize: null }];
        await api.SetPages(state.pages);
      }
    } catch (err) {
      state.errors.push(`SetPages: ${err && err.message}`);
    }

    // MouseEmulation, never DoodlesOnly. DoodlesOnly is OpenKneeboard's own
    // draw-on-top: those strokes are LOCAL and would never reach the relay,
    // and it disables mouse emulation entirely so the page stops being
    // interactive at all. Brief-mode ink has to be our canvas.
    try {
      if (typeof api.SetCursorEventsMode === 'function') {
        await api.SetCursorEventsMode('MouseEmulation');
        state.cursorMode = 'MouseEmulation';
      }
    } catch (err) {
      state.errors.push(`SetCursorEventsMode: ${err && err.message}`);
    }

    // Custom actions arrive as DOM events and are bindable to HOTAS or a
    // StreamDeck — which is the whole reason brief mode has no control that
    // exists only as a button.
    window.addEventListener('plugin/tab/customAction', (event) => {
      const id = (event.detail && event.detail.id) || '';
      // No `.follow` action: a follower is held in the brief until the
      // presenter ends it, so there is nothing left to rejoin.
      if (id.endsWith('.present')) sendIntent('brief-present', !isPresenting());
      else if (id.endsWith('.clearInk')) sendIntent('brief-clear');
    });

    // Unknown, and it must be handled rather than discovered in the air: if
    // OpenKneeboard suspends a dashboard tab that is not showing, a following
    // client misses FOCUS while the pilot is on their charts tab and then
    // jumps on return. Re-asking on wake is cheap and makes the answer not
    // matter.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') sendIntent('brief-resync');
    });
  }

  function isPresenting() {
    const c = document.getElementById('stage-ink');
    return Boolean(c && c.classList.contains('is-live'));
  }

  function sendIntent(intent, payload) {
    if (window.viewerAPI) window.viewerAPI.send(intent, payload);
  }

  init();
})();
