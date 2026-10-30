'use strict';

// Intel from DCS: JTAC 9-lines and short calls written by the mission into
// dcs.log. See PROTOCOL.md §3 for the contract — this module is the one place
// that knows it.
//
// The mission scripting environment is sandboxed (no io, os, sockets), so a
// mission cannot reach the network. It CAN write a line to dcs.log, and the
// relay on the same machine follows that file (dcsLog.js). A line looks like:
//
//   2026-10-30 12:08:38.880 INFO    SCRIPTING (Main): TACLINK: {"v":1,...}
//
// Pure Node, no Electron.

const PREFIX = 'TACLINK: ';

// A whole dcs.log line, prefix and timestamp included. Far past a real 9-line
// (~1 KB); the cap only stops one runaway line from becoming a megabyte of
// JSON fanned out to every pilot.
const MAX_LINE_BYTES = 4096;

// How many messages of the current mission a pilot who joins late is given.
const HISTORY = 50;
const MAX_SEEN = 5000;

const LIMITS = {
  id: 80,
  mission: 80,
  time: 16,
  from: 40,
  to: 40,
  line: 120,
  remarks: 600,
  text: 200,
};

// `SCRIPTING` is what the mission's env.info() writes. Anything else carrying
// the prefix — an error message quoting a script line, say — is not ours.
const LINE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(INFO|WARNING)\s+SCRIPTING \([^)]*\): (.*)$/;

// DCS writes this when a mission starts loading. A mission reloaded without
// DCS restarting numbers its messages from the start again, so the memory of
// what was sent has to go with it.
const LOAD_RE = /^\S+ \S+\s+\S+\s+Dispatcher \([^)]*\): loadMission (?!Done)/;

/** Control characters out, tabs to spaces, trimmed, capped — or null. */
function text(v, max, { required = false } = {}) {
  if (v === undefined || v === null) return required ? null : '';
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/\t/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (s.length > max) return null;
  if (required && !s) return null;
  return s;
}

function finite(v, lo, hi) {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

/**
 * Validates one decoded TACLINK object. Returns the wire message, or
 * `{ ignored: reason }` for something well-formed we do not handle (another
 * kind, a later version), or `{ error: reason }` for a broken one.
 */
function toMessage(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'not an object' };
  if (obj.v !== 1) return { ignored: `version ${JSON.stringify(obj.v)}` };
  if (obj.kind !== 'nineline' && obj.kind !== 'call') return { ignored: `kind ${JSON.stringify(obj.kind)}` };

  const head = {
    id: text(obj.id, LIMITS.id, { required: true }),
    mission: text(obj.mission, LIMITS.mission, { required: true }),
    time: text(obj.time, LIMITS.time),
    from: text(obj.from, LIMITS.from),
    to: text(obj.to, LIMITS.to),
  };
  for (const [k, v] of Object.entries(head)) if (v === null) return { error: `bad ${k}` };

  if (obj.kind === 'call') {
    const said = text(obj.text, LIMITS.text, { required: true });
    if (said === null) return { error: 'bad text' };
    return { type: 'intel-call', ...head, text: said };
  }

  if (!Array.isArray(obj.lines) || obj.lines.length !== 9) return { error: 'lines must be nine strings' };
  const lines = obj.lines.map((l) => text(l, LIMITS.line));
  if (lines.some((l) => l === null)) return { error: 'bad line' };
  const remarks = text(obj.remarks, LIMITS.remarks);
  if (remarks === null) return { error: 'bad remarks' };

  const msg = { type: 'intel-nineline', ...head, lines, remarks };
  // Carried, not shown: line 6 and line 7 already say them in words.
  const tg = obj.target;
  if (tg && typeof tg === 'object' && finite(tg.lat, -90, 90) && finite(tg.lon, -180, 180)) {
    msg.target = { lat: tg.lat, lon: tg.lon };
    if (finite(tg.elev_ft, -2000, 60000)) msg.target.elev_ft = tg.elev_ft;
  }
  if (Number.isInteger(obj.laser) && obj.laser >= 1111 && obj.laser <= 1788) msg.laser = obj.laser;
  return msg;
}

/**
 * Reads one dcs.log line. Returns one of
 *   { load: true }                 a mission started loading
 *   { message }                    a valid TACLINK message
 *   { ignored } / { error }        a TACLINK line we will not send, and why
 *   null                           any other line
 */
function parseLogLine(line) {
  if (typeof line !== 'string') return null;
  if (LOAD_RE.test(line)) return { load: true };
  if (!line.includes(PREFIX)) return null;

  const m = LINE_RE.exec(line);
  if (!m || !m[4].startsWith(PREFIX)) return null;
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return { error: `line over ${MAX_LINE_BYTES} bytes` };

  let obj;
  try {
    obj = JSON.parse(m[4].slice(PREFIX.length));
  } catch {
    return { error: 'broken JSON' };
  }
  const out = toMessage(obj);
  if (out.error || out.ignored) return out;
  // When DCS wrote it, in UTC like every dcs.log timestamp.
  out.logTime = `${m[1]}T${m[2]}Z`;
  return { message: out };
}

/**
 * Checks an intel message as it arrives off the wire (protocol.js), against
 * the same rules the relay applied to the dcs.log line. Returns the message
 * with only the fields we know, or null.
 */
function checkWire(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const kind = msg.type === 'intel-call' ? 'call' : msg.type === 'intel-nineline' ? 'nineline' : null;
  if (!kind) return null;
  const out = toMessage({ ...msg, v: 1, kind });
  if (out.error || out.ignored) return null;
  if (typeof msg.logTime === 'string' && /^[\d\-T:.Z]{1,32}$/.test(msg.logTime)) out.logTime = msg.logTime;
  return out;
}

/**
 * What the relay remembers about the mission running now: which messages it
 * has sent (so a line seen twice goes out once) and the last few, for a pilot
 * who joins late. Cleared when a mission loads or DCS starts a new log.
 */
class MissionIntel {
  constructor({ history = HISTORY } = {}) {
    this.max = history;
    this.reset();
  }

  reset() {
    this.seen = new Set();
    this.recent = [];
  }

  /** True if the message is new and should go out. */
  accept(msg) {
    const key = `${msg.mission}\u0000${msg.id}`;
    if (this.seen.has(key)) return false;
    // A mission minting a fresh id every frame must not grow this for hours.
    if (this.seen.size >= MAX_SEEN) this.seen = new Set(this.recent.map((r) => `${r.mission}\u0000${r.id}`));
    this.seen.add(key);
    this.recent.push(msg);
    if (this.recent.length > this.max) this.recent.shift();
    return true;
  }

  /** Oldest first, the order they were sent in. */
  history() {
    return this.recent.slice();
  }
}

module.exports = { parseLogLine, toMessage, checkWire, MissionIntel, PREFIX, MAX_LINE_BYTES, LIMITS, HISTORY };
