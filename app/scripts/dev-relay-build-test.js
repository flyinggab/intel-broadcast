#!/usr/bin/env node
'use strict';

// The folder a server admin unzips: built by build-relay.js, then checked from
// the outside. Every require inside it must resolve inside it, the relay must
// run from it, and on Windows taclink-relay.cmd must keep the relay up while
// stopping for good on a config error.
//
// Usage: node scripts/dev-relay-build-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { builtinModules } = require('module');
const { spawn, spawnSync } = require('child_process');

const { OUT } = require('./build-relay');

const BUILD = path.join(__dirname, 'build-relay.js');
const VERSION = require('../package.json').version;
const PORT = 8913;
const WIN = process.platform === 'win32';

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

async function main() {
  console.log('[test] the relay folder builds');
  const built = spawnSync(process.execPath, [BUILD, ...(WIN ? [] : ['--no-node'])], { encoding: 'utf8' });
  assert.strictEqual(built.status, 0, built.stderr);
  for (const f of ['README.md', 'LICENSE', 'VERSIONS.txt', 'taclink-relay.cmd', 'taclink-relay.example.json']) {
    assert.ok(fs.existsSync(path.join(OUT, f)), `${f} is in the folder`);
  }
  if (WIN) assert.ok(fs.existsSync(path.join(OUT, 'node.exe')), 'node.exe is in the folder');

  console.log('[test] every require in the relay\'s own scripts resolves inside the folder');
  const own = filesUnder(path.join(OUT, 'lib', 'src'));
  for (const file of own) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(/require\('([^']+)'\)/g)) {
      if (builtinModules.includes(spec) || spec === 'ws') continue;
      const target = path.resolve(path.dirname(file), spec);
      const found = [target, `${target}.js`, `${target}.json`].some((p) => fs.existsSync(p));
      assert.ok(found, `${path.relative(OUT, file)} requires ${spec}, which is not in the folder`);
    }
  }

  console.log('[test] the relay runs from the folder, away from the source tree');
  const entry = path.join(OUT, 'lib', 'src', 'relay', 'taclink-relay.js');
  const v = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.strictEqual(v.status, 0, v.stderr);
  assert.strictEqual(v.stdout.trim(), VERSION);

  if (!WIN) {
    console.log('[dev-relay-build-test] PASS (taclink-relay.cmd not run: not Windows)');
    return;
  }

  const cmd = path.join(OUT, 'taclink-relay.cmd');
  const cfg = path.join(OUT, 'taclink-relay.json');

  console.log('[test] taclink-relay.cmd: a config error stops it, it does not spin');
  fs.rmSync(cfg, { force: true });
  const broken = spawnSync('cmd.exe', ['/d', '/c', cmd], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(broken.status, 2, `exit code 2 for "no token" (${broken.stdout}${broken.stderr})`);

  console.log('[test] taclink-relay.cmd: the relay is started again after it stops');
  // Something already holds the port, so the relay exits with 1 on start: the
  // loop has to start it a second time, five seconds later.
  const blocker = require('net').createServer().listen(PORT, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  fs.writeFileSync(cfg, JSON.stringify({ port: PORT, host: '127.0.0.1', token: 'build-test-token-123', dcsLog: '' }));
  const loop = spawn('cmd.exe', ['/d', '/c', cmd], { cwd: os.tmpdir() });
  let out = '';
  loop.stdout.on('data', (d) => (out += d));
  loop.stderr.on('data', (d) => (out += d));
  try {
    const until = Date.now() + 15000;
    while ((out.match(/starting/g) || []).length < 2 && Date.now() < until) await settle(100);
    assert.ok((out.match(/starting/g) || []).length >= 2, `started twice:\n${out}`);
    assert.ok(out.includes('cannot listen'));
  } finally {
    spawnSync('taskkill', ['/PID', String(loop.pid), '/T', '/F']);
    blocker.close();
    fs.rmSync(cfg, { force: true });
    fs.rmSync(path.join(OUT, 'taclink-relay.log'), { force: true });
  }
  console.log('[dev-relay-build-test] PASS');
}

main().catch((err) => {
  console.error(`[dev-relay-build-test] FAIL: ${err.message}`);
  process.exit(1);
});
