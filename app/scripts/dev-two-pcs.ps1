<#
.SYNOPSIS
  Runs TWO Tac Link instances on this Windows PC as if they were two pilots'
  machines — natively, so the real Tailscale is in play.

.DESCRIPTION
  The Node version of this script (dev-two-pcs.js) is fine for the app's own
  behaviour, but it cannot exercise Tailscale from WSL: the relay ends up on the
  wrong side of the network boundary and the Linux tailscale lookup finds
  nothing. Run natively and the host talks to the real tailscaled.

  With -Funnel the host raises an actual funnel and the second instance joins
  over the PUBLIC wss:// address — traffic leaves the machine, crosses
  Tailscale's edge and comes back. That is the closest thing to a two-computer
  test without a second computer.

  What makes the two independent rather than one app opened twice:
    * INTEL_BROADCAST_LOCAL_CONFIG_PATH — its own settings file. Sharing one
      makes both think they host, and they collide on the relay port. It also
      disables the single-instance lock, without which the second launch exits
      silently with no output at all.
    * --user-data-dir — its own log, blob cache and Chromium profile.

  Global keybinds cannot be separated: Windows gives a combination to exactly
  one process, so only the instance that started first answers. Use the
  on-screen controls here.

.PARAMETER Funnel
  Host raises a real Tailscale funnel; the joiner pairs over the public URL.

.PARAMETER Manual
  Leave the second instance unpaired so you can paste the code yourself
  through SETUP -> NETWORK -> I JOIN A SQUAD.

.PARAMETER Port
  Relay port on the host. Default 8787.

.EXAMPLE
  .\dev-two-pcs.ps1
.EXAMPLE
  .\dev-two-pcs.ps1 -Funnel
.EXAMPLE
  .\dev-two-pcs.ps1 -Funnel -Seconds 120
#>

[CmdletBinding()]
param(
  [switch]$Funnel,
  [switch]$Manual,
  [int]$Port = 8787,
  # Run unattended for N seconds then close both, instead of waiting on Enter.
  # Also the safe way to run this where stdin is not a terminal: Read-Host
  # returns instantly on EOF, which would tear the instances down before they
  # had finished connecting.
  [int]$Seconds = 0
)

$ErrorActionPreference = 'Stop'

$AppDir = Split-Path -Parent $PSScriptRoot
# The real binary, not node_modules\.bin\electron.cmd: that shim spawns Electron
# as its own child, so stopping the shim leaves a window running.
$Electron = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $Electron)) {
  Write-Error "Electron not found at $Electron`nRun 'npm install' in $AppDir first."
}

# Ask the app's OWN modules, so this script can never disagree with the app
# about how a squad code is built or where Tailscale lives.
function Invoke-AppNode([string]$Script) {
  Push-Location $AppDir
  try { return (& node -e $Script 2>$null) } finally { Pop-Location }
}

$Root = Join-Path $env:TEMP 'taclink-two-pcs'
if (Test-Path $Root) { Remove-Item $Root -Recurse -Force }
$pcADir = New-Item -ItemType Directory -Path (Join-Path $Root 'PC-A') -Force
$pcBDir = New-Item -ItemType Directory -Path (Join-Path $Root 'PC-B') -Force

$Token = Invoke-AppNode "console.log(require('./src/main/squadCode').generateToken(6))"
$Token = "two-pc-$Token"

# ---------------------------------------------------------------- PC-A -----
$pcAConfig = Join-Path $pcADir 'config.json'
@{
  relayHostEnabled = $true
  token            = $Token
  callsign         = 'GHOSTRIDER 1-1'
  missionName      = 'roman-sead-joker1'
  gm               = @{ relayPort = $Port; funnelEnabled = [bool]$Funnel }
} | ConvertTo-Json -Depth 5 | Set-Content -Path $pcAConfig -Encoding UTF8

function Start-Pc([string]$Name, [string]$ConfigPath, [string]$UserDataDir) {
  $env:INTEL_BROADCAST_LOCAL_CONFIG_PATH = $ConfigPath
  try {
    return Start-Process -FilePath $Electron `
      -ArgumentList '.', "--user-data-dir=$UserDataDir" `
      -WorkingDirectory $AppDir -PassThru
  } finally {
    Remove-Item Env:\INTEL_BROADCAST_LOCAL_CONFIG_PATH -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host '  Two instances, one Windows PC — treated as two machines.' -ForegroundColor Cyan
Write-Host ''
$procA = Start-Pc 'PC-A' $pcAConfig $pcADir
Write-Host "    PC-A  GHOSTRIDER 1-1   hosting on port $Port  (pid $($procA.Id))"

# ------------------------------------------------- where PC-B should point --
if ($Funnel) {
  Write-Host ''
  Write-Host '  Waiting for the funnel to come up...' -NoNewline
  $dns = $null
  foreach ($i in 1..40) {
    Start-Sleep -Seconds 2
    $state = Invoke-AppNode "require('./src/main/tailscale').getState().then(s=>console.log(JSON.stringify(s)))" | ConvertFrom-Json
    if ($state -and $state.funnelOn -and $state.dnsName) { $dns = $state.dnsName; break }
    Write-Host '.' -NoNewline
  }
  Write-Host ''
  if (-not $dns) {
    Write-Warning @'
The funnel did not come up. Open SETUP -> NETWORK on PC-A and follow the
Internet-sharing step (Tailscale may need signing in, or Funnel may need a
one-time approval in your tailnet admin). Falling back to a LAN address.
'@
  }
}

if ($Funnel -and $dns) {
  # Exactly what the app itself hands out once a funnel is up: the public name
  # on 443, TLS terminated by Tailscale.
  $Code = Invoke-AppNode "console.log(require('./src/main/squadCode').encodeSquadCode('$dns', 443, '$Token'))"
  $Reach = "public  wss://$dns"
} else {
  $Code = Invoke-AppNode @"
const os = require('os');
let host = 'localhost';
for (const l of Object.values(os.networkInterfaces())) for (const i of l || []) if (i.family === 'IPv4' && !i.internal) { host = i.address; break; }
console.log(require('./src/main/squadCode').encodeSquadCode(host, $Port, '$Token'));
"@
  $Reach = 'LAN'
}

# ---------------------------------------------------------------- PC-B -----
$pcBConfig = Join-Path $pcBDir 'config.json'
$bSettings = @{
  relayHostEnabled = $false
  callsign         = 'JOKER 2-1'
  missionName      = 'roman-sead-joker1'
}
if (-not $Manual) {
  $decoded = Invoke-AppNode "const s=require('./src/main/squadCode');const d=s.decodeSquadCode('$Code');console.log(JSON.stringify({url:s.relayUrlFor(d),token:d.token}))" | ConvertFrom-Json
  $bSettings.relayUrl = $decoded.url
  $bSettings.token = $decoded.token
}
$bSettings | ConvertTo-Json -Depth 5 | Set-Content -Path $pcBConfig -Encoding UTF8

Start-Sleep -Seconds 2   # let the host bind its port first
$procB = Start-Pc 'PC-B' $pcBConfig $pcBDir
$pairing = if ($Manual) { 'NOT paired — paste the code yourself' } else { "joined over $Reach" }
Write-Host "    PC-B  JOKER 2-1        $pairing  (pid $($procB.Id))"

Write-Host ''
Write-Host '  Squad code' -ForegroundColor Cyan
Write-Host "    $Code"
if ($Manual) {
  Write-Host ''
  Write-Host '  On PC-B: SETUP -> NETWORK -> I JOIN A SQUAD, paste that, CONNECT.'
}
Write-Host ''
Write-Host '  Try' -ForegroundColor Cyan
Write-Host '    - SHARE on either one, pick photos, reveal: the other gets them.'
Write-Host "    - PC-A's NETWORK page should list both pilots."
Write-Host '    - Close PC-A: PC-B goes offline, and recovers when you restart it.'
if ($Funnel) {
  Write-Host '    - This pairing went out over the internet and back, so the same'
  Write-Host '      code works on a real second PC, or a phone on mobile data.'
}
Write-Host ''
Write-Host '  Note  Global keybinds belong to ONE process per machine, so only the'
Write-Host '        first instance answers them. Use the on-screen controls here.'
Write-Host ''
Write-Host "  Logs  $Root\PC-A\taclink.log"
Write-Host "        $Root\PC-B\taclink.log"
Write-Host ''
if ($Seconds -gt 0) {
  Write-Host "  Running for $Seconds seconds, then closing both." -ForegroundColor Yellow
  Start-Sleep -Seconds $Seconds
} else {
  Write-Host '  Press Enter to close both.' -ForegroundColor Yellow
  [void](Read-Host)
}

foreach ($p in @($procA, $procB)) {
  if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Milliseconds 500
Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '  Both closed.' -ForegroundColor Cyan
