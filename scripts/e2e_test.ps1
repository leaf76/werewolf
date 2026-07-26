# E2E protocol test — background receive via PowerShell runspaces
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Base = "https://werewolf-demo.leafxc0903.workers.dev"
$WsBase = "wss://werewolf-demo.leafxc0903.workers.dev"
$PlayerCount = 6
$LogPath = Join-Path $PSScriptRoot "..\e2e_result.txt"

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $msg
  Write-Host $line
  Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

function To-Json([hashtable]$obj) {
  $parts = @()
  foreach ($k in $obj.Keys) {
    $v = $obj[$k]
    if ($null -eq $v) { $parts += '"{0}":null' -f $k }
    elseif ($v -is [bool]) { $parts += ('"{0}":{1}' -f $k, ($(if ($v) { "true" } else { "false" }))) }
    elseif ($v -is [int] -or $v -is [long] -or $v -is [double]) { $parts += '"{0}":{1}' -f $k, $v }
    else {
      $escaped = ([string]$v).Replace("\", "\\").Replace('"', '\"')
      $parts += '"{0}":"{1}"' -f $k, $escaped
    }
  }
  return "{" + ($parts -join ",") + "}"
}

function Send-Text($ws, [string]$json) {
  if ($ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
    throw "send on non-open socket state=$($ws.State)"
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $seg = [ArraySegment[byte]]::new($bytes)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
}

$recvScript = {
  param($socket, $q)
  $buf = New-Object byte[] 131072
  try {
    while ($socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $seg = [ArraySegment[byte]]::new($buf)
      $result = $socket.ReceiveAsync($seg, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
      $ms = New-Object System.IO.MemoryStream
      $ms.Write($buf, 0, $result.Count)
      while (-not $result.EndOfMessage) {
        $result = $socket.ReceiveAsync($seg, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        $ms.Write($buf, 0, $result.Count)
      }
      $text = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
      try {
        $obj = $text | ConvertFrom-Json
        [void]$q.Enqueue($obj)
      } catch {
        [void]$q.Enqueue([pscustomobject]@{ type = "_bad_json"; text = $text })
      }
    }
  } catch {
    [void]$q.Enqueue([pscustomobject]@{ type = "_recv_error"; text = $_.Exception.Message })
  }
}

function Start-Receiver($p) {
  $queue = New-Object System.Collections.Concurrent.ConcurrentQueue[object]
  $p.queue = $queue
  $ps = [powershell]::Create()
  [void]$ps.AddScript($recvScript).AddArgument($p.ws).AddArgument($queue)
  $p.ps = $ps
  $p.handle = $ps.BeginInvoke()
}

function New-Player([string]$code, [string]$name) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $uri = [Uri]("$WsBase/api/rooms/$code/ws")
  $ws.ConnectAsync($uri, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
  $newId = [guid]::NewGuid().ToString()
  $p = [pscustomobject]@{
    ws        = $ws
    name      = $name
    playerId  = $newId
    secret    = ""
    role      = ""
    room      = $null
    witchWake = $null
    hunterId  = ""
    done      = $false
    winner    = ""
    msgs      = 0
    queue     = $null
    ps        = $null
    handle    = $null
  }
  Start-Receiver $p
  Start-Sleep -Milliseconds 80
  Send-Text $ws (To-Json @{ type = "join"; playerId = $newId; name = $name })
  Write-Log "  join $name"
  return $p
}

function Handle-Msg($p, $msg) {
  if ($null -eq $msg) { return }
  $p.msgs++
  switch ([string]$msg.type) {
    "session" {
      $p.secret = [string]$msg.secret
      $p.playerId = [string]$msg.playerId
    }
    "room_state" { $p.room = $msg.state }
    "role_assigned" {
      $p.role = [string]$msg.role
      Write-Log "  $($p.name) ROLE=$($p.role)"
    }
    "witch_wake" {
      $p.witchWake = $msg
      Write-Log "  $($p.name) witch_wake"
    }
    "phase_changed" {
      if ($msg.hunterId) { $p.hunterId = [string]$msg.hunterId }
      Write-Log "  phase -> $($msg.phase) r=$($msg.round)"
    }
    "game_over" {
      $p.done = $true
      $p.winner = [string]$msg.winner
      Write-Log "  GAME_OVER $($p.winner)"
    }
    "error" { Write-Log "  ERROR $($p.name) $($msg.code): $($msg.message)" }
    "seer_result" { Write-Log "  $($p.name) seer => $($msg.faction)" }
    "action_ack" { Write-Log "  $($p.name) ack $($msg.action)" }
    "chat" { Write-Log "  chat $($msg.from): $($msg.text)" }
    "_recv_error" { Write-Log "  $($p.name) recv_error $($msg.text)" }
    "_bad_json" { Write-Log "  $($p.name) bad_json" }
  }
}

function Pump($players) {
  foreach ($p in $players) {
    if ($null -eq $p.queue) { continue }
    $item = $null
    while ($p.queue.TryDequeue([ref]$item)) {
      Handle-Msg $p $item
      $item = $null
    }
  }
}

function Wait-Pump($players, [int]$ms) {
  $deadline = [datetime]::UtcNow.AddMilliseconds($ms)
  do {
    Pump $players
    Start-Sleep -Milliseconds 40
  } while ([datetime]::UtcNow -lt $deadline)
}

function Max-Seats($players) {
  $max = 0
  foreach ($p in $players) {
    if ($null -ne $p.room) {
      $c = @($p.room.players).Count
      if ($c -gt $max) { $max = $c }
    }
  }
  return $max
}

function Best-Room($players) {
  $best = $null; $max = -1
  foreach ($p in $players) {
    if ($null -ne $p.room) {
      $c = @($p.room.players).Count
      if ($c -gt $max) { $max = $c; $best = $p.room }
    }
  }
  return $best
}

function First-OtherAlive($room, $selfId) {
  foreach ($pl in @($room.players)) {
    if ($pl.alive -and [string]$pl.id -ne $selfId) { return [string]$pl.id }
  }
  return $null
}

function Act($players) {
  $room = Best-Room $players
  if ($null -eq $room) { return }
  $phase = [string]$room.phase

  if ($phase -eq "night") {
    if ([string]$room.nightStage -eq "witch") {
      foreach ($p in $players) {
        if ($p.role -eq "witch" -and $null -ne $p.witchWake) {
          Send-Text $p.ws (To-Json @{ type = "night_action"; action = "skip" })
          Write-Log "  act $($p.name) witch skip"
          $p.witchWake = $null
        }
      }
      return
    }
    foreach ($p in $players) {
      if (-not $p.role) { continue }
      $self = @($room.players | Where-Object { [string]$_.id -eq $p.playerId }) | Select-Object -First 1
      if ($null -eq $self -or -not $self.alive) { continue }
      $tid = First-OtherAlive $room $p.playerId
      if (-not $tid) { continue }
      if ($p.role -eq "werewolf") {
        Send-Text $p.ws (To-Json @{ type = "night_action"; action = "kill"; targetId = $tid })
        Write-Log "  act $($p.name) kill"
      } elseif ($p.role -eq "seer") {
        Send-Text $p.ws (To-Json @{ type = "night_action"; action = "inspect"; targetId = $tid })
        Write-Log "  act $($p.name) inspect"
      }
    }
    return
  }

  if ($phase -eq "day") {
    $voted = @($room.votedIds)
    $runoff = $room.runoffIds
    foreach ($p in $players) {
      $self = @($room.players | Where-Object { [string]$_.id -eq $p.playerId }) | Select-Object -First 1
      if ($null -eq $self -or -not $self.alive) { continue }
      if ($voted -contains $p.playerId) { continue }
      $tid = $null
      if ($null -ne $runoff -and @($runoff).Count -gt 0) {
        if (@($runoff) -contains $p.playerId) { continue }
        $tid = [string]@($runoff)[0]
      } else {
        $tid = First-OtherAlive $room $p.playerId
      }
      if ($tid) {
        Send-Text $p.ws (To-Json @{ type = "vote"; targetId = $tid })
        Write-Log "  act $($p.name) vote"
      }
    }
    return
  }

  if ($phase -eq "hunt") {
    $hid = ""
    foreach ($p in $players) { if ($p.hunterId) { $hid = $p.hunterId } }
    if (-not $hid) { return }
    $hunter = $players | Where-Object { $_.playerId -eq $hid } | Select-Object -First 1
    if ($null -eq $hunter) { return }
    Send-Text $hunter.ws '{"type":"hunt","targetId":null}'
    Write-Log "  act $($hunter.name) hunt pass"
  }
}

# ===== main =====
"" | Set-Content -Path $LogPath -Encoding UTF8
Write-Log "=== E2E START ==="

$resp = Invoke-RestMethod -Uri "$Base/api/rooms" -Method POST -ContentType "application/json" -Body "{}"
$code = [string]$resp.code
Write-Log "Room: $code"

$players = New-Object System.Collections.ArrayList
for ($i = 1; $i -le $PlayerCount; $i++) {
  $p = New-Player $code "Bot$i"
  [void]$players.Add($p)
  Wait-Pump $players 500
  Write-Log "  after Bot$i maxSeats=$(Max-Seats $players) bot1state=$($players[0].ws.State)"
}

Wait-Pump $players 1500
$n = Max-Seats $players
Write-Log "Seat max=$n"
foreach ($p in $players) {
  $pc = if ($p.room) { @($p.room.players).Count } else { 0 }
  Write-Log "  $($p.name) msgs=$($p.msgs) seats=$pc state=$($p.ws.State)"
}

if ($n -lt 6) { Write-Log "FAIL seats"; exit 1 }

Write-Log "START GAME"
Send-Text $players[0].ws (To-Json @{ type = "start_game"; revealOnDeath = $true })
Wait-Pump $players 2500

Send-Text $players[0].ws (To-Json @{ type = "chat"; text = "e2e-hello" })
Wait-Pump $players 600

$rolesAssigned = @($players | Where-Object { $_.role }).Count
Write-Log "Roles assigned: $rolesAssigned"
if ($rolesAssigned -lt 1) {
  Write-Log "FAIL no roles phase=$((Best-Room $players).phase)"
  exit 1
}

for ($tick = 1; $tick -le 150; $tick++) {
  Wait-Pump $players 350
  $room = Best-Room $players
  if ($null -eq $room) { continue }
  $phase = [string]$room.phase
  $done = $false
  foreach ($p in $players) { if ($p.done) { $done = $true } }
  if ($done -or $phase -eq "ended") {
    Write-Log "Finished tick=$tick phase=$phase"
    break
  }
  if ($tick % 5 -eq 1) {
    Write-Log "tick=$tick phase=$phase round=$($room.round) stage=$($room.nightStage)"
  }
  try { Act $players } catch { Write-Log "  act err: $($_.Exception.Message)" }
}

Wait-Pump $players 1200

$winner = ""
foreach ($p in $players) { if ($p.winner) { $winner = $p.winner } }
Write-Log ("Roles: " + (($players | ForEach-Object { "$($_.name)=$($_.role)" }) -join ", "))
Write-Log "Winner: $winner"

foreach ($p in $players) {
  try {
    if ($p.ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $p.ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "bye", [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
    }
    if ($p.ps) { $p.ps.Dispose() }
  } catch {}
}

if ($winner -or ((Best-Room $players) -and [string](Best-Room $players).phase -eq "ended")) {
  Write-Log "=== PASS room=$code winner=$winner ==="
  exit 0
}
Write-Log "=== FAIL room=$code ==="
exit 2
