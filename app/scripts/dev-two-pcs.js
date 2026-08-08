'use strict';

// Launches TWO app instances on one machine, set up as if they were two
// different pilots' PCs: one hosts the relay, the other joins it with a real
// squad code.
//
//   node scripts/dev-two-pcs.js            both wired up and connected
//   node scripts/dev-two-pcs.js --manual   second one left unpaired, so you can
//                                          practise pasting the code yourself
//   node scripts/dev-two-pcs.js --port 9100
//   node scripts/dev-two-pcs.js --card path/to/other.card.json
//   node scripts/dev-two-pcs.js --no-card
//
// Ctrl+C closes both.
//
// What makes them genuinely independent, rather than one app opened twice:
//
// - `INTEL_BROADCAST_LOCAL_CONFIG_PATH` gives each its own settings file.
//   Without it they share one, so hosting in one makes both think they host and
//   they collide on the relay port. It also switches off the single-instance
//   lock, which otherwise makes the second launch exit silently.
// - `--user-data-dir` gives each its own log, blob cache and Chromium profile.
//   Sharing those means two apps writing one log, which is miserable to read
//   and hides which instance did what.
//
// One thing NO amount of config can separate: global keybinds. Windows and
// macOS both hand a given combination to exactly one process, so only the
// instance that grabbed it first responds. That is a property of the OS, not a
// bug here, and it does not exist once the two are really on separate PCs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const squad = require('../src/main/squadCode');
const { killApp } = require('./dev-electron');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');

const args = process.argv.slice(2);
const manual = args.includes('--manual');
const portArg = args.indexOf('--port');
const RELAY_PORT = portArg !== -1 ? Number(args[portArg + 1]) : 8787;

// A mission card on the HOST only, so the two PCs differ the way two pilots
// do: the lead has the card, the wingman does not. That asymmetry is the
// whole point when testing card sharing — with a card on both you cannot
// tell a successful send from a card that was already there.
const cardArg = args.indexOf('--card');
const CARD_PATH =
  cardArg !== -1 && args[cardArg + 1] && !args[cardArg + 1].startsWith('--')
    ? path.resolve(args[cardArg + 1])
    : path.join(APP_DIR, '..', 'design', 'kneeboard', 'foxhunt2-roman1.card.json');
const noCard = args.includes('--no-card');

// Under the OS temp dir, not the repo: these are throwaway machines, and a
// stray userData folder inside app/ would end up in a build.
const ROOT = path.join(os.tmpdir(), 'taclink-two-pcs');
fs.rmSync(ROOT, { recursive: true, force: true });

const TOKEN = `two-pc-${squad.generateToken(6)}`;

/** The address another machine would use to reach this one. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const CODE = squad.encodeSquadCode(lanAddress(), RELAY_PORT, TOKEN);

function makePc({ name, callsign, config, card = null }) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ callsign, missionName: 'roman-sead-joker1', ...config }, null, 2),
  );
  return { name, callsign, dir, configPath, card };
}

const pcA = makePc({
  name: 'PC-A',
  callsign: 'GHOSTRIDER 1-1',
  // The lead has the card; the wingman does not. See CARD_PATH above.
  card: noCard ? null : CARD_PATH,
  // okb OFF: these are throwaway machines under the OS temp dir, and this
  // script deletes them on exit. An instance that registers an OpenKneeboard
  // plugin from a directory that is about to vanish leaves a dangling entry
  // behind for ever, and enough of those stop the real tab appearing at all.
  config: { relayHostEnabled: true, token: TOKEN, okb: { enabled: false }, gm: { relayPort: RELAY_PORT, funnelEnabled: false } },
});

const pcB = makePc({
  name: 'PC-B',
  callsign: 'JOKER 2-1',
  // --manual leaves this one unpaired on purpose: open SETUP → NETWORK →
  // I JOIN A SQUAD and paste the code printed below, which is the flow a real
  // pilot goes through.
  config: manual
    ? { relayHostEnabled: false, okb: { enabled: false } }
    : { relayHostEnabled: false, okb: { enabled: false }, relayUrl: squad.relayUrlFor(squad.decodeSquadCode(CODE)), token: TOKEN },
});

const children = [];

function launch(pc) {
  const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox', `--user-data-dir=${pc.dir}`], {
    cwd: APP_DIR,
    detached: true, // its own process group, so Ctrl+C can take the whole thing down
    env: {
      ...process.env,
      INTEL_BROADCAST_LOCAL_CONFIG_PATH: pc.configPath,
      // Only the host gets one. Deleted rather than set empty, because an
      // empty string would still count as "a card path was given".
      ...(pc.card ? { INTEL_BROADCAST_CARD_PATH: pc.card } : {}),
    },
  });
  const tag = `[${pc.name}]`;
  const relay = (stream, out) => {
    stream.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        // Chromium's GPU/sandbox chatter is noise on a dev box.
        if (!line.trim() || /ERROR:|GPU|sandbox|StagingBuffer|mailbox|Security Warning/.test(line)) continue;
        out.write(`${tag} ${line}\n`);
      }
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stdout);
  children.push(child);
  return child;
}

function shutdown() {
  console.log('\nclosing both…');
  for (const child of children) killApp(child);
  setTimeout(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(0);
  }, 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`
  Two instances, one machine — treated as two different PCs.

    ${pcA.name}  ${pcA.callsign}   hosts the relay on port ${RELAY_PORT}${pcA.card ? ' · has the CARD' : ''}
    ${pcB.name}  ${pcB.callsign}   ${manual ? 'NOT paired — pair it yourself' : 'joins it with the squad code'}

  Squad code
    ${CODE}
${
  manual
    ? `
  On ${pcB.name}: SETUP → NETWORK → I JOIN A SQUAD, paste that code, CONNECT.`
    : ''
}
  Try
    - Pick photos on either one under SHARE, then reveal: the other gets them,
      and the row says who shared it.
    - Watch ${pcA.name}'s NETWORK page list both pilots.
    - Close ${pcA.name} and ${pcB.name} goes to the offline state, then recovers
      when you bring the host back.

  Note  Global keybinds belong to ONE process per machine, so only whichever
        instance started first answers them. Use the on-screen controls here;
        this stops mattering on separate PCs.

  Logs  ${path.join(ROOT, '<PC>', 'taclink.log')}
  Ctrl+C closes both.
`);

launch(pcA);
// Let the host bind its port before the other one tries to reach it.
setTimeout(() => launch(pcB), 2500);
