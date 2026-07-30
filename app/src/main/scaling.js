'use strict';

// Pure sizing/zoom math for resolution-appropriate windows — no Electron
// imports, so it stays unit-testable with plain `node` (dev-scaling-test.js).
//
// All dimensions are Electron DIP units (device-independent pixels): on
// displays where the OS scale factor already compensates (e.g. Windows 4K at
// 150%), the DIP work area is correspondingly smaller and the extra scaling
// computed here stays modest — the two multiply, they don't fight. The case
// this exists for is a large work area in DIP terms (4K at 100% scaling,
// or WSLg which reports scale factor 1), where fixed-pixel windows and text
// render tiny.

// The work-area height the UI was originally designed against (a 1080p
// display minus a taskbar). At exactly this size everything renders 1:1,
// pixel-identical to the app before scaling support existed.
const BASELINE_WORK_HEIGHT = 1040;

// Viewer design size — A4 portrait (~1:1.4142), the zoom baseline for the
// viewer's overlay text (idle message, index indicator, disconnect banner).
const VIEWER_BASE_HEIGHT = 1202;
const A4_RATIO = Math.SQRT2;

// The viewer occupies this fraction of the work-area height on any display —
// same proportion everywhere, and (unlike the old fixed 1202px window) it
// actually fits on work areas shorter than the design height.
const VIEWER_HEIGHT_FRACTION = 0.85;

const SETTINGS_BASE_WIDTH = 480;
// Tall enough for the GM-mode fields (incl. the Connected clients section),
// since the mode toggle is live in-session — switching shouldn't clip content.
const SETTINGS_BASE_HEIGHT = 760;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * UI scale for a display with the given DIP work-area height. A configured
 * `uiScale` override (config.local.json) wins over auto-detection — the
 * escape hatch if a particular monitor/OS-scaling combo misjudges.
 */
function computeUiScale(workAreaHeight, override) {
  if (typeof override === 'number' && override > 0) return clamp(override, 0.5, 4);
  return clamp(workAreaHeight / BASELINE_WORK_HEIGHT, 1, 3);
}

/**
 * Viewer window size + content zoom for a display: A4-portrait proportions
 * at VIEWER_HEIGHT_FRACTION of the work-area height (capped by width on
 * unusually narrow displays), overlay text zoomed relative to the design size
 * so the window looks proportionally identical on every display.
 */
function computeViewerBounds(workAreaSize, uiScaleOverride) {
  const height = Math.round(
    Math.min(workAreaSize.height * VIEWER_HEIGHT_FRACTION, workAreaSize.width * 0.95 * A4_RATIO),
  );
  const width = Math.round(height / A4_RATIO);
  const zoom =
    typeof uiScaleOverride === 'number' && uiScaleOverride > 0
      ? clamp(uiScaleOverride, 0.5, 4)
      : clamp(height / VIEWER_BASE_HEIGHT, 0.75, 3);
  return { width, height, zoom };
}

/** Settings window size + content zoom: the design size times the UI scale. */
function computeSettingsBounds(workAreaSize, uiScaleOverride) {
  const scale = computeUiScale(workAreaSize.height, uiScaleOverride);
  return {
    width: Math.round(SETTINGS_BASE_WIDTH * scale),
    height: Math.round(SETTINGS_BASE_HEIGHT * scale),
    zoom: scale,
  };
}

module.exports = {
  computeUiScale,
  computeViewerBounds,
  computeSettingsBounds,
  BASELINE_WORK_HEIGHT,
  VIEWER_BASE_HEIGHT,
  SETTINGS_BASE_WIDTH,
  SETTINGS_BASE_HEIGHT,
};
