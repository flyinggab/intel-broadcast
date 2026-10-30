#!/usr/bin/env node
'use strict';

// Assembles the headless relay for a server admin: dist/relay/taclink-relay/
//
//   node.exe                     Node itself, as published (signed by the OpenJS Foundation)
//   taclink-relay.cmd            starts it from its own folder
//   taclink-relay.example.json   the config, with placeholders
//   README.md                    RELAY.md: install, config, start, firewall, squad code
//   LICENSE, VERSIONS.txt
//   lib/                         the relay's own scripts and `ws`, nothing else
//
// No bundler and no packed executable: an unsigned .exe is exactly what
// Defender's ML heuristic quarantines (HANDOFF §7), and Node's own binary is
// not one. The release workflow zips the folder and writes its SHA-256.
//
//   node scripts/build-relay.js                  node.exe = the Node running this (Windows)
//   node scripts/build-relay.js --node <exe>     a given node.exe
//   node scripts/build-relay.js --no-node        scripts only (any OS, for testing)

const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const REPO = path.resolve(APP, '..');
const OUT = path.join(APP, 'dist', 'relay', 'taclink-relay');

// Everything the relay requires, and only that. dev-relay-build-test checks
// that this list and the requires in these files agree.
const MAIN_FILES = ['relayServer.js', 'auth.js', 'protocol.js', 'intel.js', 'dcsLog.js', 'squadCode.js'];

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else copy(a, b);
  }
}

function main() {
  const argv = process.argv.slice(2);
  let nodeExe = process.platform === 'win32' ? process.execPath : null;
  const i = argv.indexOf('--node');
  if (i !== -1) nodeExe = argv[i + 1];
  if (argv.includes('--no-node')) nodeExe = null;

  const pkg = require(path.join(APP, 'package.json'));
  fs.rmSync(OUT, { recursive: true, force: true });

  for (const f of MAIN_FILES) copy(path.join(APP, 'src', 'main', f), path.join(OUT, 'lib', 'src', 'main', f));
  copy(path.join(APP, 'src', 'relay', 'taclink-relay.js'), path.join(OUT, 'lib', 'src', 'relay', 'taclink-relay.js'));
  copyDir(path.join(APP, 'node_modules', 'ws'), path.join(OUT, 'lib', 'node_modules', 'ws'));
  fs.writeFileSync(
    path.join(OUT, 'lib', 'package.json'),
    JSON.stringify({ name: 'taclink-relay', version: pkg.version, private: true, license: pkg.license }, null, 2) + '\n',
  );

  copy(path.join(REPO, 'RELAY.md'), path.join(OUT, 'README.md'));
  copy(path.join(REPO, 'LICENSE'), path.join(OUT, 'LICENSE'));
  fs.writeFileSync(
    path.join(OUT, 'taclink-relay.cmd'),
    [
      '@echo off',
      'rem Tac Link relay. Runs from its own folder, so .\\taclink-relay.json is the config.',
      'rem With no arguments it keeps the relay up: restarted 5 s after any exit,',
      'rem except a config error (exit code 2), which needs a person to fix it.',
      'cd /d "%~dp0"',
      'if not "%~1"=="" (',
      '  "%~dp0node.exe" "%~dp0lib\\src\\relay\\taclink-relay.js" %*',
      '  exit /b',
      ')',
      ':run',
      '"%~dp0node.exe" "%~dp0lib\\src\\relay\\taclink-relay.js"',
      'if errorlevel 2 if not errorlevel 3 exit /b 2',
      'timeout /t 5 /nobreak >nul',
      'goto run',
      '',
    ].join('\r\n'),
  );
  fs.writeFileSync(
    path.join(OUT, 'taclink-relay.example.json'),
    JSON.stringify(
      {
        port: 8787,
        token: 'made by: taclink-relay --init',
        dcsLog: 'C:\\Users\\<server user>\\Saved Games\\DCS.dcs_serverrelease\\Logs\\dcs.log',
      },
      null,
      2,
    ) + '\r\n',
  );

  const wsVersion = require(path.join(APP, 'node_modules', 'ws', 'package.json')).version;
  let nodeVersion = '(not included)';
  if (nodeExe) {
    copy(nodeExe, path.join(OUT, 'node.exe'));
    nodeVersion = nodeExe === process.execPath ? process.version : '(given with --node)';
  }
  fs.writeFileSync(
    path.join(OUT, 'VERSIONS.txt'),
    `taclink-relay ${pkg.version}\r\nnode ${nodeVersion}\r\nws ${wsVersion}\r\n`,
  );
  console.log(`[build-relay] ${OUT} (relay ${pkg.version}, node ${nodeVersion}, ws ${wsVersion})`);
}

if (require.main === module) main();

module.exports = { MAIN_FILES, OUT };
