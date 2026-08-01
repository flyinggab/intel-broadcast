'use strict';

const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Drives the Tailscale CLI on the HOST machine so SETUP can walk
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

/**
 * Where to look when `tailscale` isn't on PATH. A GUI app inherits the PATH
 * it was *launched* with, so installing Tailscale while the app is already
 * running (exactly what a first-time setup does) leaves the PATH lookup
 * failing until relaunch — these keep it working anyway.
 */
function wellKnownPaths() {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    return [
      path.join(programFiles, 'Tailscale', 'tailscale.exe'),
      path.join(programFilesX86, 'Tailscale', 'tailscale.exe'),
      localAppData ? path.join(localAppData, 'Tailscale', 'tailscale.exe') : null,
    ].filter(Boolean);
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/usr/local/bin/tailscale',
      '/opt/homebrew/bin/tailscale',
    ];
  }
  return ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale'];
}

/**
 * Absolute path of the tailscale CLI, or null if not installed. Also reports
 * where it looked, so the settings panel can say something more useful than
 * "not installed" when a real install exists somewhere unexpected.
 */
function findBinaryDetailed() {
  const override = process.env.INTEL_BROADCAST_TAILSCALE_BIN;
  if (override) {
    return { binary: fs.existsSync(override) ? override : null, source: 'env override', tried: [override] };
  }

  const tried = [];
  try {
    const probeCmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(probeCmd, ['tailscale'], { encoding: 'utf8', timeout: 5000 })
      .split(/\r?\n/)[0]
      .trim();
    tried.push(`${probeCmd} tailscale`);
    if (out && fs.existsSync(out)) return { binary: out, source: 'PATH', tried };
  } catch {
    tried.push(`${process.platform === 'win32' ? 'where' : 'which'} tailscale (not found)`);
  }

  for (const candidate of wellKnownPaths()) {
    tried.push(candidate);
    if (fs.existsSync(candidate)) return { binary: candidate, source: 'well-known path', tried };
  }
  return { binary: null, source: null, tried };
}

function findBinary() {
  return findBinaryDetailed().binary;
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
  const found = findBinaryDetailed();
  const bin = found.binary;
  if (!bin) {
    // Report what was searched — "not installed" is unhelpful (and wrong) when
    // a real install lives somewhere this didn't look.
    return { installed: false, downloadUrl: DOWNLOAD_URL, triedPaths: found.tried };
  }

  const status = await run(bin, ['status', '--json']);
  if (!status.ok) {
    return {
      installed: true,
      binaryPath: bin,
      error: `"${bin} status --json" failed: ${(status.stderr || status.error || '').trim() || 'no output'}`,
    };
  }
  let parsed;
  try {
    parsed = parseStatus(status.stdout);
  } catch (err) {
    return { installed: true, binaryPath: bin, error: `unparseable tailscale status: ${err.message}` };
  }

  const loggedIn = parsed.backendState === 'Running';
  const state = {
    installed: true,
    binaryPath: bin,
    backendState: parsed.backendState,
    loggedIn,
    dnsName: parsed.dnsName,
    wssUrl: loggedIn ? deriveWssUrl(parsed.dnsName) : null,
    funnelOn: false,
    funnelTarget: null,
  };
  if (!loggedIn) return state;

  const funnel = await run(bin, ['funnel', 'status', '--json']);
  if (funnel.ok) {
    Object.assign(state, parseFunnelStatus(funnel.stdout));
    // Raw output kept for the log: the on/off flapping seen on the first real
    // Windows run could only be diagnosed by seeing exactly what the CLI said.
    state.funnelRaw = (funnel.stdout || '').trim();
  } else {
    // A failed status read means "unknown", NOT "off" — reporting it as off
    // made the app think it had to re-start the funnel, flapping the UI.
    state.funnelStatusError = `"tailscale funnel status --json" failed: ${
      (funnel.stderr || funnel.error || '').trim() || 'no output'
    }`;
  }
  return state;
}

/** Local port a running funnel forwards to, from getState()'s funnelTarget
 *  (e.g. "http://127.0.0.1:8787" -> 8787), or null. Used to decide whether a
 *  leftover funnel found at startup is plausibly OURS before touching it. */
function funnelTargetPort(state) {
  const match = /:(\d+)\/?$/.exec((state && state.funnelTarget) || '');
  return match ? Number(match[1]) : null;
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
  console.log(`[tailscale] running: ${bin} funnel --bg ${port}`);
  const res = await run(bin, ['funnel', '--bg', String(port)], 20000);
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  console.log(`[tailscale] funnel --bg exited ${res.ok ? 'ok' : 'non-zero'}; output: ${combined || '(none)'}`);
  if (res.ok) return { ok: true };
  return {
    // Whole output, not just the last line: the real CLI's wording is
    // unverified, and a truncated message is useless in a bug report.
    ok: false,
    message: combined || res.error || 'funnel failed with no output',
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
  findBinaryDetailed,
  getState,
  funnelTargetPort,
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
