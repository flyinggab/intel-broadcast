# Tac Link relay for a DCS server

A Tac Link relay that runs on the DCS server machine, with no window. Pilots join it with a squad code, the
same way they join a pilot who hosts. Nobody hosts from their own PC and nobody needs Tailscale.

It also reads the server's `dcs.log`. When the mission writes a 9-line or a call there, every connected
pilot gets it on their kneeboard (the format is in [PROTOCOL.md](PROTOCOL.md) §3).

## What you need

- A Windows machine running a DCS server, or any machine pilots can reach over the network.
- One TCP port open to the pilots. The default is 8787.
- The release zip `taclink-relay-<version>-win-x64.zip` from the
  [releases](https://github.com/flyinggab/intel-broadcast/releases), and its `.sha256` file.

The zip holds Node (`node.exe`, as published and signed by the Node.js project), the relay's scripts, this
page and the licence. Nothing to build, nothing to install system-wide. `VERSIONS.txt` says which Node.

## Install

1. Check the download:

   ```powershell
   (Get-FileHash .\taclink-relay-<version>-win-x64.zip -Algorithm SHA256).Hash
   ```

   It must match the hash in the `.sha256` file.

2. Unzip it. It holds one folder, `taclink-relay`. Put it where you like, for example `C:\taclink-relay`.

3. Make the config, with a new token:

   ```powershell
   cd C:\taclink-relay
   .\taclink-relay.cmd --init
   ```

   This writes `taclink-relay.json`. Run it as the Windows user that runs DCS, so the default path to
   `dcs.log` is right.

4. Check it:

   ```powershell
   .\taclink-relay.cmd --check
   ```

## Config

`taclink-relay.json`, next to `taclink-relay.cmd`:

| Field | Default | What it is |
|---|---|---|
| `port` | `8787` | TCP port pilots connect to. Not 443. |
| `host` | all addresses | Address to listen on, if only one. |
| `token` | none | The squad's secret, 12 characters or more. `--init` makes one. |
| `dcsLog` | `%USERPROFILE%\Saved Games\DCS.dcs_serverrelease\Logs\dcs.log` | The DCS log to follow. `""` turns it off. |
| `log` | `taclink-relay.log` next to the config | The relay's own log. Kept under 10 MB, the previous one as `.old`. |
| `limits` | see below | Optional. |

If the server runs with its own profile name (`DCS.exe --server -w <name>`), the log is in
`Saved Games\<name>\Logs\dcs.log`.

Environment variables override the file: `TACLINK_RELAY_PORT`, `TACLINK_RELAY_HOST`, `TACLINK_RELAY_TOKEN`,
`TACLINK_RELAY_DCS_LOG`, `TACLINK_RELAY_LOG`. `TACLINK_RELAY_CONFIG` points at another config file.

Limits, all optional: `maxClients` (64 sockets), `maxPending` (32 not signed in), `maxPerAddress` (16),
`preAuthBytes` (1 MB before signing in), `rtPerSecond` (100) and `rtBurst` (300) per socket,
`batchBurst` (5) and `batchPerMinute` (30) photo batches per pilot, `heartbeatMs` (30000). Each pilot uses
two sockets.

## Start it with the server

`taclink-relay.cmd` with no arguments runs the relay and restarts it 5 seconds after it stops. A config error
stops it for good, so fix the config and start it again.

To start it when the DCS user signs in, from PowerShell as that user:

```powershell
$a = New-ScheduledTaskAction -Execute 'C:\taclink-relay\taclink-relay.cmd' -WorkingDirectory 'C:\taclink-relay'
$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName 'Tac Link relay' -Action $a -Trigger $t -Settings $s
```

The relay can start before DCS. It waits for `dcs.log` and picks up each new one when DCS restarts.

## Open the port

On the server, as administrator:

```powershell
New-NetFirewallRule -DisplayName 'Tac Link relay' -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
```

Open the same TCP port wherever else the server's traffic is filtered: a cloud firewall, a router.

## The squad code

```powershell
.\taclink-relay.cmd --squad-code <address>
```

`<address>` is what pilots use to reach the server, the same as for DCS: a host name or an IPv4 address.
It prints a code like `IB1-…`. Pilots paste it in SETUP → NETWORK → I JOIN A SQUAD.

The code is a password: it holds the token. Send it to pilots privately. The relay never writes it to its
log. To change it, run `--init --force`, restart the relay and send the new code. Old codes stop working.

## What to know

- The connection is plain `ws://` with a token, like DCS and SRS. Anyone who can watch the network between a
  pilot and the server could read the photos, the 9-lines and the token.
- Pilots need Tac Link 0.10 or later to see 9-lines, calls and who is on the net. Older versions still
  join and get photos and briefs.
- What the relay did is in `taclink-relay.log`: who connected, refused attempts with their address, each
  9-line and call sent, lines from `dcs.log` it skipped and why.

## Update

Stop the relay, unzip the new version over the folder and keep `taclink-relay.json`. Start it again. The
squad code does not change.
