'use strict';

// Follows dcs.log the way `tail -F` would, on a machine where DCS owns it.
//
// What DCS does to the file, measured on DCS 2.9 (2026-10):
//   - every start writes a NEW dcs.log whose first line is
//     `=== Log opened UTC 2026-10-06 12:15:05`; the previous one is kept as
//     dcs.log.old (game) or dcs-YYYYMMDD-HHMMSS.log (the server profile);
//   - lines end in LF;
//   - the file can be read while DCS writes it.
//
// So: poll, open, read what is new, CLOSE. Holding the file open between
// polls could stop DCS renaming it at its next start. A new log is spotted by
// its first line changing or the file getting shorter. Started on a log that
// already exists, it reads from the END: lines from before the relay started
// are not news. A log that appears after the start is read from the top.
//
// Emits 'line' (one complete line, no line ending), 'rotated' (a new log: what
// the last one said no longer applies) and 'status' (following | missing |
// locked) when that changes. Pure Node.

const fs = require('fs');
const { EventEmitter } = require('events');

const POLL_MS = 500;
// Per poll. A DCS start writes a few hundred KB in seconds; the rest comes on
// the next poll rather than in one large read.
const MAX_READ_BYTES = 1024 * 1024;
// A "line" longer than this has no end in sight — a binary file, or a log
// gone wrong. It is dropped up to its next newline rather than buffered.
const MAX_LINE_BYTES = 64 * 1024;
const HEADER_BYTES = 256;

class DcsLogFollower extends EventEmitter {
  constructor({ file, pollMs = POLL_MS, maxReadBytes = MAX_READ_BYTES, maxLineBytes = MAX_LINE_BYTES } = {}) {
    super();
    if (!file) throw new Error('no dcs.log path');
    this.file = file;
    this.pollMs = pollMs;
    this.maxReadBytes = maxReadBytes;
    this.maxLineBytes = maxLineBytes;
    this.timer = null;
    this.offset = null; // null = not positioned in any log yet
    this.header = '';
    this.pending = Buffer.alloc(0);
    this.skipping = false; // inside a line we joined halfway, or one too long
    this.lost = false; // followed a log that then disappeared
    this.status = null;
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  setStatus(status, detail) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status, detail);
  }

  poll() {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Gone between DCS runs, or not there yet. Either way the next log to
        // appear is a new one, read from its first line.
        if (this.offset !== null) this.lost = true;
        this.setStatus('missing');
      } else {
        this.setStatus('locked', err.code);
      }
      return;
    }
    try {
      this.readFrom(fd);
      this.setStatus('following');
    } catch (err) {
      this.setStatus('locked', err.code || err.message);
    } finally {
      fs.closeSync(fd);
    }
  }

  readFrom(fd) {
    const size = fs.fstatSync(fd).size;
    const head = readHeader(fd, size);

    if (this.offset === null) {
      // First sight of a log. Already there at start: begin at the end, and if
      // that is mid-line, skip to the next one. Appeared later: all of it is new.
      this.header = head;
      if (this.everMissing) {
        this.offset = 0;
      } else {
        this.offset = size;
        this.skipping = size > 0 && lastByte(fd, size) !== 0x0a;
      }
    } else if (this.lost || size < this.offset || (this.header && head && head !== this.header)) {
      this.header = head;
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      this.skipping = false;
      this.lost = false;
      this.emit('rotated');
    } else if (!this.header && head) {
      // The header was still being written last time round.
      this.header = head;
    }

    if (size <= this.offset) return;
    const n = Math.min(size - this.offset, this.maxReadBytes);
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, this.offset);
    this.offset += got;
    this.take(buf.subarray(0, got));
  }

  take(chunk) {
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0x0a) continue;
      if (this.skipping) {
        this.skipping = false;
      } else {
        let end = i;
        if (end > start && data[end - 1] === 0x0d) end -= 1;
        this.emit('line', data.toString('utf8', start, end));
      }
      start = i + 1;
    }
    data = data.subarray(start);
    if (data.length > this.maxLineBytes) {
      this.skipping = true;
      data = Buffer.alloc(0);
    }
    this.pending = this.skipping ? Buffer.alloc(0) : Buffer.from(data);
  }

  get everMissing() {
    return this.status === 'missing';
  }
}

/** The log's first line, or '' while it is not written in full yet. */
function readHeader(fd, size) {
  if (!size) return '';
  const buf = Buffer.alloc(Math.min(size, HEADER_BYTES));
  const got = fs.readSync(fd, buf, 0, buf.length, 0);
  const nl = buf.subarray(0, got).indexOf(0x0a);
  return nl === -1 ? '' : buf.toString('utf8', 0, nl).replace(/\r$/, '');
}

function lastByte(fd, size) {
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, size - 1);
  return b[0];
}

module.exports = { DcsLogFollower, POLL_MS };
