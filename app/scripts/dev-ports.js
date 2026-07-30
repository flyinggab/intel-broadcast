'use strict';

// One port per test, in one place. Tests run back to back and a just-killed
// Electron instance can hold its listener for a moment, so two scripts
// sharing a number fails as a confusing EADDRINUSE in whichever runs second
// (this bit us with 8788, 8791, 8792 and 8797 all double-booked). Add new
// tests here rather than picking a number by hand.
module.exports = {
  protocolE2E: 8788, // dev-e2e-test.js
  auth: 8789, // dev-auth-test.js
  electronE2E: 8791, // dev-e2e-electron-test.js
  clientsList: 8794, // dev-e2e-clients-list-test.js
  host: 8795, // dev-e2e-host-test.js (relay)
  hostTrigger: 8796, // dev-e2e-host-test.js (reveal trigger)
  funnelFlow: 8797, // dev-e2e-funnel-flow-test.js
  share: 8799, // dev-e2e-share-test.js
  liveApplyOld: 8801, // dev-e2e-live-apply-test.js (relay before the save)
  liveApplyNew: 8802, // dev-e2e-live-apply-test.js (relay after the save)
  liveApplyTrigger: 8803, // dev-e2e-live-apply-test.js (reveal trigger)
  hotkeyConfigLoad: 8804, // dev-hotkey-config-load-test.js
  panel: 8805, // dev-e2e-panel-test.js
  screenshotCheck: 8806, // dev-screenshot-check.js
  settingsE2E: 8809, // dev-e2e-settings-test.js
  uiE2E: 8808, // dev-e2e-ui-test.js
  hardening: 8807, // dev-hardening-test.js
  settingsSave: 9123, // dev-e2e-settings-test.js (relay started by the live apply)
};
