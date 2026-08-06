'use strict';

// The smallest thing okb-bridge.js will accept as OpenKneeboard. It checks for
// this object at parse time, so it has to exist before any page script runs —
// which is the whole reason this is a preload and not an injected snippet.
//
// Only the calls the bridge makes are stubbed, and they resolve rather than
// throw so the bridge follows its real path instead of its error path.
window.OpenKneeboard = {
  SetPreferredPixelSize: async () => {},
  GetVersion: async () => ({ HumanReadable: 'v1.12.10-stub' }),
  EnableExperimentalFeatures: async () => {},
  // Reports "somebody already claimed the pages", which is one of the two
  // real branches and avoids the fixture pretending SetPages succeeded.
  GetPages: async () => ({ havePages: false }),
  SetPages: async () => {},
  SetCursorEventsMode: async () => {},
};

// The user agent is the bridge's other detection route.
Object.defineProperty(navigator, 'userAgent', {
  value: `${navigator.userAgent} OpenKneeboard/1.12.10.0`,
  configurable: true,
});
