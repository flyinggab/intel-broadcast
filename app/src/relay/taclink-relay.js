#!/usr/bin/env node
'use strict';

// The headless Tac Link relay, for the machine that runs a DCS server.
//
// The same relay the app embeds when a pilot hosts (relayServer.js), with no
// window and no tray, plus a follower on the server's dcs.log that turns the
// mission's TACLINK lines into 9-lines and calls on every kneeboard. Pilots
// join it with an ordinary IB1- squad code. Admin guide: RELAY.md.
//
//   taclink-relay                       run, with ./taclink-relay.json
//   taclink-relay --config <file>       run, with that file
//   taclink-relay --init                write a config with a fresh token
//   taclink-relay --squad-code <host>   print the code pilots paste in
//   taclink-relay --check               read the config, say what it would do
//   taclink-relay --version
//
// Environment variables override the file: TACLINK_RELAY_PORT, _HOST, _TOKEN,
// _DCS_LOG, _LOG, and TACLINK_RELAY_CONFIG for the file itself.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRelayServer, DEFAULT_LIMITS } = require('../main/relayServer');
const { DcsLogFollower } = require('../main/dcsLog');
const { parseLogLine } = require('../main/intel');
const { encodeSquadCode, generateToken, maskToken, MIN_TOKEN_LENGTH } = require('../main/squadCode');

const VERSION = require('../../package.json').version;
const DEFAULT_PORT = 8787;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
// The token the app ships with for local testing. Never on a public port.
const KNOWN_TOKENS = new Set(['dev-secret']);

function defaultDcsLog() {
  // DCS's dedicated server writes to its own Saved Games profile.
  return path.join(os.homedir(), 'Saved Games', 'DCS.dcs_serverrelease', 'Logs', 'dcs.log');
}

function parseArgs(argv) {
  const args = { command: 'run', config: null, host: null, port: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--init') args.command = 'init';
    else if (a === '--force') args.force = true;
    else if (a === '--check') args.command = 'check';
    else if (a === '--version' || a === '-v') args.command = 'version';
    else if (a === '--help' || a === '-h') args.command = 'help';
    else if (a === '--squad-code') {
      args.command = 'code';
      args.host = argv[++i];
    } else if (a === '--port') args.port = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function configPath(args) {
  return path.resolve(args.config || process.env.TACLINK_RELAY_CONFIG || 'taclink-relay.json');
}

/** The file, then the environment over it. Throws with a reason a person can act on. */
function loadConfig(file) {
  let fromFile = {};
  if (fs.existsSync(file)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${err.message}`);
    }
  }
  const env = process.env;
  const cfg = {
    port: env.TACLINK_RELAY_PORT || fromFile.port || DEFAULT_PORT,
    host: env.TACLINK_RELAY_HOST || fromFile.host || null,
    token: env.TACLINK_RELAY_TOKEN || fromFile.token || '',
    dcsLog: env.TACLINK_RELAY_DCS_LOG !== undefined ? env.TACLINK_RELAY_DCS_LOG : fromFile.dcsLog,
    log: env.TACLINK_RELAY_LOG || fromFile.log || path.join(path.dirname(file), 'taclink-relay.log'),
    limits: fromFile.limits || {},
  };
  if (cfg.dcsLog === undefined || cfg.dcsLog === null) cfg.dcsLog = defaultDcsLog();

  cfg.port = Number(cfg.port);
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error('port must be 1-65535');
  if (cfg.port === 443) throw new Error('port 443 is read as wss:// by the apps; use another');
  if (!cfg.token) throw new Error(`no token: run with --init, or set "token" in ${file}`);
  if (String(cfg.token).length < MIN_TOKEN_LENGTH) throw new Error(`the token must be at least ${MIN_TOKEN_LENGTH} characters`);
  if (KNOWN_TOKENS.has(cfg.token)) throw new Error('the token is the app\'s test token; run --init for a real one');
  if (/[:\s]/.test(cfg.token)) throw new Error('the token cannot contain a colon or a space');
  for (const [k, v] of Object.entries(cfg.limits)) {
    if (!(k in DEFAULT_LIMITS)) throw new Error(`unknown limit: ${k}`);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`limit ${k} must be a positive number`);
  }
  return cfg;
}

/** One line per event, to the console and the relay's own file. Never the token. */
function makeLogger(file) {
  let stream = null;
  function open() {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.renameSync(file, `${file}.old`);
      }
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', () => {
        stream = null;
      });
    } catch {
      stream = null;
    }
  }
  open();
  let written = 0;
  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    if (!stream) return;
    stream.write(line + os.EOL);
    written += line.length + 2;
    if (written > MAX_LOG_BYTES) {
      written = 0;
      stream.end();
      open();
    }
  };
}

function cmdInit(args) {
  const file = configPath(args);
  if (fs.existsSync(file) && !args.force) {
    throw new Error(`${file} exists; pass --force to replace it (the squad code changes with the token)`);
  }
  const cfg = {
    port: DEFAULT_PORT,
    token: generateToken(18),
    dcsLog: defaultDcsLog(),
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + os.EOL);
  console.log(`wrote ${file} with a new token (${maskToken(cfg.token)})`);
  console.log('next: taclink-relay --squad-code <the address pilots reach this machine on>');
}

function cmdCode(args) {
  if (!args.host) throw new Error('--squad-code needs the address pilots reach this machine on');
  const cfg = loadConfig(configPath(args));
  const port = args.port ? Number(args.port) : cfg.port;
  // To the console only. The code is a password: it is not written to the log.
  console.log(encodeSquadCode(args.host, port, cfg.token));
}

function cmdCheck(args) {
  const file = configPath(args);
  const cfg = loadConfig(file);
  console.log(`config   ${fs.existsSync(file) ? file : '(none, environment only)'}`);
  console.log(`listen   ${cfg.host || 'all addresses'}, TCP ${cfg.port}`);
  console.log(`token    ${maskToken(cfg.token)}`);
  console.log(`dcs.log  ${cfg.dcsLog || '(not followed)'}${cfg.dcsLog && !fs.existsSync(cfg.dcsLog) ? ' — not there yet' : ''}`);
  console.log(`log      ${cfg.log}`);
}

function cmdRun(args) {
  const cfg = loadConfig(configPath(args));
  const log = makeLogger(cfg.log);
  log(`taclink-relay ${VERSION} starting: TCP ${cfg.port}${cfg.host ? ` on ${cfg.host}` : ''}`);

  const server = createRelayServer({
    port: cfg.port,
    host: cfg.host || undefined,
    token: cfg.token,
    limits: cfg.limits,
    serverName: `taclink-relay/${VERSION}`,
    onLog: (m) => log(m),
    onClientsChanged: (list) => log(`on the net: ${list.length}`),
  });
  server.httpServer.on('listening', () => log(`listening on TCP ${cfg.port}`));
  server.httpServer.on('error', (err) => {
    log(`cannot listen on TCP ${cfg.port}: ${err.message}`);
    process.exit(1);
  });

  let follower = null;
  if (cfg.dcsLog) {
    follower = new DcsLogFollower({ file: cfg.dcsLog });
    // A broken line is reported once per reason a minute, not once per line:
    // a mission with a bug in its formatter writes the same mistake a lot.
    const lastSaid = new Map();
    follower.on('line', (line) => {
      const r = parseLogLine(line);
      if (!r) return;
      if (r.load) {
        server.resetIntel();
        log('dcs.log: a mission is loading, intel from the last one cleared');
      } else if (r.message) {
        server.broadcastIntel(r.message);
      } else {
        const why = r.error || r.ignored;
        const now = Date.now();
        if (now - (lastSaid.get(why) || 0) > 60000) {
          lastSaid.set(why, now);
          log(`dcs.log: skipped a TACLINK line (${r.error ? 'error' : 'not handled'}: ${why})`);
        }
      }
    });
    follower.on('rotated', () => {
      server.resetIntel();
      log('dcs.log: DCS started a new log');
    });
    follower.on('status', (status, detail) => {
      const says = {
        following: `following ${cfg.dcsLog}`,
        missing: `${cfg.dcsLog} is not there (yet); waiting`,
        locked: `cannot read ${cfg.dcsLog} (${detail}); retrying`,
      };
      log(`dcs.log: ${says[status] || status}`);
    });
    follower.start();
  } else {
    log('dcs.log: not followed (dcsLog is empty)');
  }

  const stop = (why) => {
    log(`stopping: ${why}`);
    if (follower) follower.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => stop('interrupted'));
  process.on('SIGTERM', () => stop('terminated'));
  // Whatever starts the relay is told to restart it on failure (README), so
  // an error nobody planned for ends the process loudly rather than leaving
  // a relay half-alive.
  process.on('uncaughtException', (err) => {
    log(`fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.command === 'version') return void console.log(VERSION);
    if (args.command === 'help') {
      return void console.log(
        'taclink-relay [--config <file>] | --init [--force] | --squad-code <host> [--port <n>] | --check | --version',
      );
    }
    if (args.command === 'init') return void cmdInit(args);
    if (args.command === 'code') return void cmdCode(args);
    if (args.command === 'check') return void cmdCheck(args);
    cmdRun(args);
  } catch (err) {
    console.error(`taclink-relay: ${err.message}`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { loadConfig, parseArgs, defaultDcsLog };
