$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$runningMarker = Join-Path $root 'data/post-idle-final-verification.running'
$doneMarker = Join-Path $root 'data/post-idle-final-verification.done.json'
$logPath = Join-Path $root 'logs/post-idle-final-verification.log'

New-Item -ItemType Directory -Force (Split-Path $logPath) | Out-Null
New-Item -ItemType Directory -Force (Split-Path $runningMarker) | Out-Null

if (Test-Path $doneMarker) {
  Write-Output "post-idle-final-verification already completed: $doneMarker"
  exit 0
}
if (Test-Path $runningMarker) {
  $age = (Get-Date) - (Get-Item $runningMarker).LastWriteTime
  if ($age.TotalHours -lt 24) {
    Write-Output 'post-idle-final-verification already running'
    exit 0
  }
  Remove-Item -LiteralPath $runningMarker -Force
}
New-Item -ItemType File -Path $runningMarker -Force | Out-Null

function Read-DotEnv {
  $values = @{}
  foreach ($line in (Get-Content (Join-Path $root '.env'))) {
    if ($line -match '^\s*([^#=]+)=(.*)$') {
      $values[$matches[1].Trim()] = $matches[2].Trim().Trim('"')
    }
  }
  return $values
}

function New-AdminSession {
  $cfg = Read-DotEnv
  $body = @{ user = $cfg['ADMIN_USER']; password = $cfg['ADMIN_PASS'] } | ConvertTo-Json
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  Invoke-WebRequest -UseBasicParsing -WebSession $session -Method Post -ContentType 'application/json' -Body $body 'http://127.0.0.1:3010/api/v1/admin/login' | Out-Null
  return $session
}

function Get-VerificationStatus($session) {
  return Invoke-RestMethod -UseBasicParsing -WebSession $session 'http://127.0.0.1:3010/api/v1/verification'
}

function Wait-VerificationIdle($session, [string]$label) {
  while ($true) {
    $status = Get-VerificationStatus $session
    if (-not $status.running -and $status.phase -eq 'idle') {
      Write-Output "$label verification idle"
      return
    }
    $done = $status.progress.done
    $total = $status.progress.total
    Write-Output "$label verification active phase=$($status.phase) done=$done total=$total errors=$($status.progress.errors); next check in 5 min"
    Start-Sleep -Seconds 300
  }
}

function Wait-FinalizerAndCleanupIdle {
  while ($true) {
    $active = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and (
        $_.CommandLine -match 'finalize-catalog-pipeline\.ts' -or
        $_.CommandLine -match 'final_verification_finished=1'
      )
    })
    if ($active.Count -eq 0) { return }
    Write-Output "finalizer/watcher still active ($($active.Count)); next check in 5 min"
    Start-Sleep -Seconds 300
  }
}

function Invoke-Tool([string[]]$arguments, [string]$label) {
  Write-Output "starting $label"
  & npx.cmd @arguments
  if ($LASTEXITCODE -ne 0) { throw "$label exited with code $LASTEXITCODE" }
}

try {
  $session = New-AdminSession
  Wait-VerificationIdle $session 'full'
  Wait-FinalizerAndCleanupIdle

  # The historical cursor is already at EOF; this site-specific cursor makes
  # the six TubePelis rows re-evaluable without touching other providers.
  Invoke-Tool @(
    'tsx', 'tools/backfill-legacy-source-links.ts', '--site', 'tubepelis.com', '--apply',
    '--batch-size', '50', '--concurrency', '4',
    '--cursor-file', 'data/legacy-source-bridge-tubepelis-2026-09-05.cursor.json',
    '--report', 'docs/reports/legacy-source-bridge-tubepelis-2026-09-05.json'
  ) 'TubePelis legacy bridge'

  # Stop only the exact production API command, never an unrelated Node app.
  $apiProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist[\\/]server\.cjs'
  })
  foreach ($proc in $apiProcesses) {
    Write-Output "stopping MeriStream API pid=$($proc.ProcessId)"
    Stop-Process -Id $proc.ProcessId -Force
  }
  Start-Sleep -Seconds 3

  $stdout = Join-Path $root 'logs/api-production.out.log'
  $stderr = Join-Path $root 'logs/api-production.err.log'
  Start-Process -WindowStyle Hidden -WorkingDirectory $root -FilePath 'npm.cmd' -ArgumentList @('run', 'start') -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null

  $healthy = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://127.0.0.1:3010/health'
      if ($health.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $healthy) { throw 'new API did not become healthy within 120 seconds' }
  Write-Output 'new API healthy'

  try {
    Invoke-Tool @('playwright', 'test', 'e2e/local-playback-smoke.spec.ts', '--project=chromium', '--workers=1', '--reporter=line') 'playback E2E smoke'
  } catch {
    Write-Output "playback E2E smoke reported a failure: $($_.Exception.Message)"
  }

  $env:SOURCE_HEALTH_SAMPLES = '2'
  try {
    Invoke-Tool @('tsx', 'tools/source-health-audit.ts') 'source health audit'
  } catch {
    Write-Output "source health audit reported a failure: $($_.Exception.Message)"
  }

  # Restore the durable setting after the expedited catalog pass.
  $restoreBody = @{ sync_known_episodes = $true } | ConvertTo-Json
  Invoke-WebRequest -UseBasicParsing -WebSession $session -Method Post -ContentType 'application/json' -Body $restoreBody 'http://127.0.0.1:3010/api/v1/verification/config' | Out-Null

  $metadataBody = @{ mode = 'metadata' } | ConvertTo-Json
  $metadataResponse = Invoke-WebRequest -UseBasicParsing -WebSession $session -Method Post -ContentType 'application/json' -Body $metadataBody 'http://127.0.0.1:3010/api/v1/verification/run'
  Write-Output 'metadata verification requested'
  Wait-VerificationIdle $session 'metadata'

  Invoke-Tool @('tsx', 'tools/metadata-language-audit.ts') 'post-metadata language audit'
  Invoke-Tool @('vitest', 'run', '--reporter=dot') 'final test suite'

  @{ completed_at = (Get-Date).ToUniversalTime().ToString('o'); status = 'completed' } |
    ConvertTo-Json | Set-Content -Encoding UTF8 $doneMarker
}
catch {
  Write-Output "post-idle-final-verification failed: $($_.Exception.Message)"
  throw
}
finally {
  if (Test-Path $runningMarker) { Remove-Item -LiteralPath $runningMarker -Force }
}
