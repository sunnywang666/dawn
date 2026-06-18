param(
  [switch]$RestartBridge,
  [switch]$RestartAppServer,
  [switch]$RestartAll
)

$ErrorActionPreference = "Stop"

$Root = "D:\GitHub\exclusive-dawn"
$StateDir = "D:\GitHub\.exclusive-dawn"
$LogDir = Join-Path $StateDir "logs"
$ListenUrl = "ws://127.0.0.1:8765"
$ReadyzUrl = "http://127.0.0.1:8765/readyz"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$launcherLog = Join-Path $LogDir "windows-launcher.log"
$appLog = Join-Path $LogDir "windows-codex-app-server.log"
$bridgeLog = Join-Path $LogDir "windows-dawn-bridge.log"
$appPidFile = Join-Path $StateDir "windows-codex-app-server.pid"
$bridgePidFile = Join-Path $StateDir "windows-dawn-bridge.pid"

function Write-LauncherLog($message) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $launcherLog -Value "[$timestamp] $message" -Encoding UTF8
}

function Read-PidFile($path) {
  if (-not (Test-Path -LiteralPath $path)) {
    return $null
  }
  try {
    $raw = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
    $parsed = 0
    if ([int]::TryParse(($raw | Out-String).Trim(), [ref]$parsed) -and $parsed -gt 0) {
      return $parsed
    }
    Write-LauncherLog "invalid pid file at $path"
  } catch {
    Write-LauncherLog "failed to read pid file ${path}: $($_.Exception.Message)"
  }
  return $null
}

function Write-PidFile($path, $processId) {
  Set-Content -LiteralPath $path -Value ([string]$processId) -Encoding ASCII
}

function Remove-PidFile($path) {
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}

function Get-ManagedProcess($path) {
  $processId = Read-PidFile $path
  if (-not $processId) {
    return $null
  }
  try {
    return Get-Process -Id $processId -ErrorAction Stop
  } catch {
    Write-LauncherLog "stale pid file detected at $path for pid=$processId"
    Remove-PidFile $path
    return $null
  }
}

function Test-ManagedRunning($path) {
  return $null -ne (Get-ManagedProcess $path)
}

function Get-LegacyBridgeProcess {
  try {
    $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
    foreach ($process in $processes) {
      $commandLine = [string]$process.CommandLine
      if ($commandLine -like "*bin*exclusive-dawn.js*start*--checkin*") {
        return $process
      }
    }
  } catch {
    Write-LauncherLog "legacy bridge process check failed: $($_.Exception.Message)"
  }
  return $null
}

function Stop-ManagedProcess($name, $path) {
  $process = Get-ManagedProcess $path
  if (-not $process) {
    Write-LauncherLog "$name pid file missing or process already stopped"
    Remove-PidFile $path
    return $false
  }
  try {
    Write-LauncherLog "stopping $name pid=$($process.Id)"
    $taskKillOutput = & taskkill.exe /PID $process.Id /T /F 2>&1
    if ($LASTEXITCODE -ne 0) {
      $taskKillMessage = ($taskKillOutput | Out-String).Trim()
      $taskKillSuffix = if ($taskKillMessage) { ": $taskKillMessage" } else { "" }
      throw "taskkill exited with code $LASTEXITCODE$taskKillSuffix"
    }
    Write-LauncherLog "$name stopped"
  } catch {
    Write-LauncherLog "failed to stop $name pid=$($process.Id): $($_.Exception.Message)"
    return $false
  }
  Remove-PidFile $path
  return $true
}

function Start-ManagedProcess($name, $pidFile, $command) {
  $process = Start-Process -FilePath "powershell.exe" -WorkingDirectory $Root -WindowStyle Hidden -PassThru -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command", $command
  )
  Write-PidFile $pidFile $process.Id
  Write-LauncherLog "$name started pid=$($process.Id)"
  return $process
}

function Test-AppServerReady {
  try {
    $response = Invoke-WebRequest -Uri $ReadyzUrl -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
  } catch {
    return $false
  }
}

Write-LauncherLog "launcher started"

if ($RestartAll) {
  $RestartBridge = $true
  $RestartAppServer = $true
}

if ($RestartBridge) {
  $stoppedManagedBridge = Stop-ManagedProcess "dawn bridge" $bridgePidFile
  if (-not $stoppedManagedBridge) {
    $legacyBridge = Get-LegacyBridgeProcess
    if ($legacyBridge) {
      try {
        Write-LauncherLog "stopping legacy dawn bridge pid=$($legacyBridge.ProcessId)"
        Stop-Process -Id $legacyBridge.ProcessId -Force -ErrorAction Stop
        Write-LauncherLog "legacy dawn bridge stopped"
      } catch {
        Write-LauncherLog "failed to stop legacy dawn bridge pid=$($legacyBridge.ProcessId): $($_.Exception.Message)"
      }
    }
  }
}

if ($RestartAppServer) {
  [void](Stop-ManagedProcess "codex app-server" $appPidFile)
}

if (Test-AppServerReady -and -not $RestartAppServer) {
  Write-LauncherLog "codex app-server already ready at $ReadyzUrl"
} else {
  Write-LauncherLog "starting codex app-server at $ListenUrl"
  [void](Start-ManagedProcess "codex app-server" $appPidFile "Set-Location -LiteralPath '$Root'; codex.cmd app-server --listen $ListenUrl *>> '$appLog'")

  $ready = $false
  for ($i = 0; $i -lt 20; $i += 1) {
    Start-Sleep -Seconds 1
    if (Test-AppServerReady) {
      $ready = $true
      break
    }
  }
  if ($ready) {
    Write-LauncherLog "codex app-server is ready"
  } else {
    Write-LauncherLog "codex app-server did not become ready; check $appLog"
  }
}

if (Test-ManagedRunning $bridgePidFile -and -not $RestartBridge) {
  Write-LauncherLog "dawn bridge already running"
} elseif ((Get-LegacyBridgeProcess) -and -not $RestartBridge) {
  Write-LauncherLog "legacy dawn bridge already running without pid file"
} else {
  Write-LauncherLog "starting dawn bridge with checkin"
  [void](Start-ManagedProcess "dawn bridge" $bridgePidFile "Set-Location -LiteralPath '$Root'; node .\bin\exclusive-dawn.js start --checkin *>> '$bridgeLog'")
}

Write-LauncherLog "launcher finished"
