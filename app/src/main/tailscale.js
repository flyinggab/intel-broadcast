'use strict';

const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');

// Drives the Tailscale CLI on the HOST machine so the settings window can walk
// the user from "not installed" all the way to a public wss:// Funnel URL.
// Deliberately no Electron imports (browser-opening is a callback) so the
// parsing/composition logic is unit-testable with plain node
// (dev-tailscale-parse-test.js) and drivable against a stub binary
// (INTEL_BROADCAST_TAILSCALE_BIN) in e2e tests.
//
// CLI facts this encodes (verified July 2026):
// - `tailscale status --json`: .BackendState ("Running"|"NeedsLogin"|"Stopped"),
//   .Self.DNSName (trailing dot). Logged in === Running.
// - `tailscale funnel --bg <port>`: HTTP-proxies https://<dnsname>:443 ->
//   127.0.0.1:<port>, WebSocket upgrades included -> pilots use wss://<dnsname>.
//   On first use the CLI fails with a message containing the admin-console URL
//   to enable the `funnel` node attribute / HTTPS certs — surfaced as enableUrl.
// - `tailscale funnel status --json`: serve config; funnel is on when any
//   AllowFunnel entry is true.
// - `tailscale funnel --https=443 off` turns it off.

const DOWNLOAD_URL = 'https://tailscale.com/download';

const WELL_KNOWN_PATHS = {
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
  darwin: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ],
  linux: ['/usr/bin/tailscale', '/usr/sbin/tailscale'],
};

/** Absolute path of the tailscale CLI, or null if not installed. */
function findBinary() {
  const override = process.env.INTEL_BROADCAST_TAILSCALE_BIN;
  if (override) return fs.existsSync(override) ? override : null;

  try {
    const probeCmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(probeCmd, ['tailscale'], { encoding: 'utf8', timeout: 3000 })
      .split(/\r?\n/)[0]
      .trim();
    if (out) return out;
  } catch {
    // not on PATH — fall through to well-known locations
  }
  for (const candidate of WELL_KNOWN_PATHS[process.platform] || []) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function run(bin, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err ? err.message : null });
    });
  });
}

/** First https:// URL in a blob of CLI output, minus trailing punctuation. */
function extractUrl(text) {
  const match = (text || '').match(/https:\/\/\S+/);
  return match ? match[0].replace(/[.,)\]'"]+$/, '') : null;
}

/** { backendState, dnsName } from `tailscale status --json` output. */
function parseStatus(jsonText) {
  const status = JSON.parse(jsonText);
  return {
    backendState: status.BackendState || 'Unknown',
    dnsName: (status.Self && status.Self.DNSName ? status.Self.DNSName : '').replace(/\.$/, '') || null,
  };
}

/** { funnelOn, funnelTarget } from `tailscale funnel status --json` output. */
function parseFunnelStatus(jsonText) {
  let cfg;
  try {
    cfg = JSON.parse(jsonText);
  } catch {
    return { funnelOn: false, funnelTarget: null }; // e.g. "No serve config" plain text
  }
  const funnelOn = Object.values(cfg.AllowFunnel || {}).some(Boolean);
  let funnelTarget = null;
  for (const site of Object.values(cfg.Web || {})) {
    for (const handler of Object.values(site.Handlers || {})) {
      if (handler.Proxy) funnelTarget = handler.Proxy;
    }
  }
  return { funnelOn, funnelTarget };
}

function deriveWssUrl(dnsName) {
  return dnsName ? `wss://${dnsName}` : null;
}

/**
 * One composed snapshot for the settings panel:
 * { installed, downloadUrl?, backendState?, loggedIn?, dnsName?, wssUrl?,
 *   funnelOn?, funnelTarget?, error? }
 */
async function getState() {
  const bin = findBinary();
  if (!bin) return { installed: false, downloadUrl: DOWNLOAD_URL };

  const status = await run(bin, ['status', '--json']);
  if (!status.ok) {
    return { installed: true, error: `tailscale status failed: ${(status.stderr || status.error || '').trim()}` };
  }
  let parsed;
  try {
    parsed = parseStatus(status.stdout);
  } catch (err) {
    return { installed: true, error: `unparseable tailscale status: ${err.message}` };
  }

  const loggedIn = parsed.backendState === 'Running';
  const state = {
    installed: true,
    backendState: parsed.backendState,
    loggedIn,
    dnsName: parsed.dnsName,
    wssUrl: loggedIn ? deriveWssUrl(parsed.dnsName) : null,
    funnelOn: false,
    funnelTarget: null,
  };
  if (!loggedIn) return state;

  const funnel = await run(bin, ['funnel', 'status', '--json']);
  if (funnel.ok) Object.assign(state, parseFunnelStatus(funnel.stdout));
  return state;
}

/**
 * Starts (or re-points) the background funnel: public :443 -> 127.0.0.1:port.
 * Returns { ok } or { ok: false, message, enableUrl } — enableUrl is the
 * admin-console link the CLI prints when the tailnet hasn't enabled Funnel /
 * HTTPS certs yet.
 */
async function startFunnel(port) {
  const bin = findBinary();
  if (!bin) return { ok: false, message: 'tailscale is not installed' };
  const res = await run(bin, ['funnel', '--bg', String(port)], 20000);
  if (res.ok) return { ok: true };
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  return {
    ok: false,
    message: combined.split('\n').filter(Boolean).pop() || res.error || 'funnel failed',
    enableUrl: extractUrl(combined),
  };
}

async function stopFunnel() {
  const bin = findBinary();
  if (!bin) return { ok: false, message: 'tailscale is not installed' };
  return run(bin, ['funnel', '--https=443', 'off']);
}

/** Blocking best-effort stop for the app-quit path (will-quit can't await). */
function stopFunnelSync() {
  const bin = findBinary();
  if (!bin) return;
  try {
    execFileSync(bin, ['funnel', '--https=443', 'off'], { timeout: 5000, windowsHide: true });
  } catch {
    // best effort — worst case the funnel points at a closed local port
  }
}

/**
 * Runs `tailscale login`, reporting the browser auth URL via onAuthUrl as
 * soon as the CLI prints it. Resolves when the CLI exits (login completed or
 * abandoned); callers should re-poll getState() rather than trust the exit.
 */
function login({ onAuthUrl = () => {}, timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const bin = findBinary();
    if (!bin) {
      resolve({ ok: false, message: 'tailscale is not installed' });
      return;
    }
    const child = spawn(bin, ['login'], { windowsHide: true });
    let urlReported = false;
    const watch = (chunk) => {
      if (urlReported) return;
      const url = extractUrl(String(chunk));
      if (url) {
        urlReported = true;
        onAuthUrl(url);
      }
    };
    child.stdout.on('data', watch);
    child.stderr.on('data', watch);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, message: 'failed to launch tailscale login' });
    });
  });
}

module.exports = {
  findBinary,
  getState,
  startFunnel,
  stopFunnel,
  stopFunnelSync,
  login,
  // exported for unit tests
  parseStatus,
  parseFunnelStatus,
  extractUrl,
  deriveWssUrl,
  DOWNLOAD_URL,
};
