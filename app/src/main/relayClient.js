'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { buildRevealFrames, BatchReassembler, REALTIME_PATH, parseBriefMessage } = require('./protocol');

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000]; // caps at 30s

/**
 * WebSocket client for the relay: authenticates, reassembles incoming
 * reveal-batch fan-outs (via protocol.js), can originate its own reveal
 * upstream (sendRevealBatch — any client may share, the relay fans it out to
 * everyone including the sender), and reconnects with exponential backoff on
 * disconnect. Emits:
 *   - 'connected'
 *   - 'disconnected'
 *   - 'reveal-batch' ({ batchId, sourceType, sharedBy, ts, items: [{filename, mimeType, buffer}] })
 *   - 'brief' (one validated realtime message — see protocol.js)
 *
 * TWO sockets, one port. The bulk socket carries photos; the realtime socket
 * (`/rt`) carries brief mode. They are separate so a 3 MB photo cannot delay
 * a 26-byte stroke behind it — see relayServer.js. The realtime socket is
 * best-effort by design: if it never opens (an older host that does not route
 * `/rt`), photos keep working and brief mode is simply absent, which is the
 * whole point of advertising `brief` in HELLO.
 */
class RelayClient extends EventEmitter {
  constructor({ url, token, role, callsign }) {
    super();
    this.url = url;
    this.token = token;
    this.role = role;
    this.callsign = callsign;
    this.reconnectAttempt = 0;
    this.closedByUser = false;
    this.ws = null;
    this.rt = null;
    this.reassembler = new BatchReassembler();
  }

  connect() {
    this.closedByUser = false;
    this._openSocket();
    this._openRealtime();
  }

  close() {
    this.closedByUser = true;
    if (this.ws) this.ws.close();
    if (this.rt) this.rt.close();
  }

  get briefConnected() {
    return !!this.rt && this.rt.readyState === WebSocket.OPEN;
  }

  /**
   * Sends one realtime message up to the relay, which stamps our
   * authenticated callsign onto it and fans it out. Returns false when the
   * realtime socket is not up — the caller renders its own ink locally
   * regardless (local echo is mandatory; a presenter must never wait for a
   * round trip through DERP to see their own stroke).
   */
  sendBrief(msg) {
    if (!this.briefConnected) return false;
    this.rt.send(JSON.stringify(msg));
    return true;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Sends a reveal batch UP to the relay, which fans it out to every
   * connected client — including this one (the echo is the single render
   * path: what comes back is what everyone sees). Returns the batchId, or
   * null when not connected.
   */
  sendRevealBatch(items, { sourceType = 'prebundled' } = {}) {
    if (!this.connected) return null;
    const { batchId, metaFrame, binaryFrames } = buildRevealFrames(items, {
      sourceType,
      sharedBy: this.callsign || '',
    });
    this.ws.send(metaFrame);
    for (const frame of binaryFrames) this.ws.send(frame, { binary: true });
    return batchId;
  }

  _openSocket() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      // Optional pre-auth HELLO. v1 has no version field anywhere, so this is
      // what makes any later protocol change safe: a server that doesn't know
      // the frame ignores it, and one that does can negotiate. Costs one
      // frame, unblocks phase 2.
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          minVersion: 1,
          client: 'taclink-electron',
          capabilities: ['brief'],
        }),
      );
      ws.send(JSON.stringify({ type: 'auth', token: this.token, role: this.role, callsign: this.callsign }));
      this.reconnectAttempt = 0;
      this.emit('connected');
    });

    ws.on('message', (data, isBinary) => {
      let batch;
      try {
        batch = this.reassembler.feed(data, isBinary);
      } catch (err) {
        // Cap violation on an incoming fan-out — drop it, stay connected.
        console.error(`[relayClient] dropped incoming batch: ${err.message}`);
        return;
      }
      if (batch) this.emit('reveal-batch', batch);
    });

    ws.on('close', () => {
      this.emit('disconnected');
      if (!this.closedByUser) this._scheduleReconnect();
    });

    ws.on('error', () => {
      // 'close' always follows 'error' for ws; avoid double-handling here.
    });
  }

  /**
   * The realtime half. Deliberately quiet: it has its own lifecycle, does not
   * emit 'connected'/'disconnected', and never drives the reconnect backoff.
   * The bulk socket owns "am I online?" — a pilot whose realtime socket is
   * down is still receiving intel, and telling them they are OFFLINE because
   * brief mode is unavailable would be a lie.
   */
  _openRealtime() {
    let rtUrl;
    try {
      const u = new URL(this.url);
      u.pathname = REALTIME_PATH;
      rtUrl = u.toString();
    } catch {
      return; // a malformed relay URL is the bulk socket's problem to report
    }

    const rt = new WebSocket(rtUrl);
    this.rt = rt;

    rt.on('open', () => {
      rt.send(JSON.stringify({ type: 'auth', token: this.token, role: this.role, callsign: this.callsign }));
    });

    rt.on('message', (data, isBinary) => {
      if (isBinary) return;
      // Validated on the way in as well as on the relay. The relay is the
      // gate, but a client should not trust the network to have one.
      const msg = parseBriefMessage(data);
      if (msg) this.emit('brief', msg);
    });

    rt.on('close', () => {
      if (this.rt === rt) this.rt = null;
      // Follows the bulk socket's backoff rather than running its own, so a
      // host that is simply down is not probed twice as fast.
      if (!this.closedByUser) {
        const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
        setTimeout(() => {
          if (!this.closedByUser && !this.briefConnected) this._openRealtime();
        }, delay);
      }
    });

    rt.on('error', () => {
      // 'close' always follows; an older host that does not route /rt shows
      // up here and must stay silent — photos still work.
    });
  }

  _scheduleReconnect() {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    // The FAULT page shows the attempt count and the countdown, so a pilot can
    // tell "reconnecting" from "hung".
    this.emit('reconnecting', { attempt: this.reconnectAttempt, nextInMs: delay });
    setTimeout(() => {
      if (!this.closedByUser) this._openSocket();
    }, delay);
  }
}

module.exports = { RelayClient };
