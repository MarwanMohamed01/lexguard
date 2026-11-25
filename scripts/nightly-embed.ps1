# Nightly corpus embedding for the M3 retrieval eval (D26), run by a Windows scheduled task
# shortly after 00:00 UTC, when the free 10,000 Workers AI Neurons reset.
#
#   1. starts the probe Worker (wrangler dev, uses your wrangler login; no API key involved),
#   2. waits until it answers on 127.0.0.1:8787,
#   3. runs `npm run embed:cuad`, which stops by itself at 9,000 Neurons for the UTC day and
#      resumes from the cache next time,
#   4. stops the probe Worker,
#   5. when every text is embedded, disables its own scheduled task.
#
# Output is shown in the window and appended to evals/data/retrieval/nightly-embed.log
# (git-ignored). Run by hand: powershell -NoProfile -File scripts\nightly-embed.ps1
$ErrorActionPreference = 'Stop'
$TaskName = 'Lexguard nightly embedding'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Log = Join-Path $Root 'evals\data\retrieval\nightly-embed.log'
New-Item -ItemType Directory -Force (Split-Path -Parent $Log) | Out-Null

function Write-Log([string]$Line) {
  Write-Host $Line
  Add-Content -Path $Log -Value $Line -Encoding utf8
}

Write-Log ''
Write-Log "=== $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')) UTC: nightly embedding starts"

$probe = $null
$finished = $false
try {
  $probe = Start-Process -FilePath 'cmd.exe' -PassThru -WindowStyle Minimized `
    -ArgumentList '/c', 'npx wrangler dev -c experiments/embed-probe/wrangler.jsonc --port 8787'

  # Ready when anything answers HTTP on the port (the probe says 404 to GET /).
  $deadline = (Get-Date).AddMinutes(3)
  $ready = $false
  while (-not $ready -and (Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -Uri 'http://127.0.0.1:8787/' -UseBasicParsing -TimeoutSec 5 | Out-Null
      $ready = $true
    } catch [System.Net.WebException] {
      if ($null -ne $_.Exception.Response) { $ready = $true } else { Start-Sleep -Seconds 3 }
    }
  }
  if (-not $ready) { throw 'probe Worker did not start within 3 minutes (is wrangler still logged in?)' }
  Write-Log 'probe Worker is up'

  # cmd merges npm's stderr into stdout, so PowerShell 5.1 does not wrap lines as errors.
  cmd.exe /c 'npm run embed:cuad -w @lexguard/evals 2>&1' | ForEach-Object {
    $line = "$_"
    Write-Log $line
    if ($line -like '*done: every text is embedded*') { $finished = $true }
  }
  Write-Log "embedding run exited with code $LASTEXITCODE"
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
} finally {
  if ($null -ne $probe -and -not $probe.HasExited) {
    # The probe runs as cmd -> npx -> node (workerd); stop the whole tree.
    taskkill.exe /PID $probe.Id /T /F | Out-Null
    Write-Log 'probe Worker stopped'
  }
}

if ($finished) {
  Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
  Write-Log "corpus fully embedded: scheduled task '$TaskName' disabled"
}
Write-Log "=== $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')) UTC: done"
