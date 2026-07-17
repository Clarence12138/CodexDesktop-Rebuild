param(
  [Parameter(Mandatory = $true)]
  [string]$UpstreamExecutable,

  [Parameter(Mandatory = $true)]
  [string]$PackagedExecutable,

  [int]$DurationSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$SmokeArguments = @("--disable-gpu", "--no-sandbox")

function Read-SmokeLog {
  param([string]$Path)

  if (Test-Path -LiteralPath $Path) {
    return Get-Content $Path -Raw
  }
  return ""
}

function Invoke-CodexSmoke {
  param(
    [string]$Executable,
    [string]$Label,
    [int]$DurationSeconds
  )

  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    throw "Missing ${Label} executable: ${Executable}"
  }

  $logPrefix = Join-Path $env:RUNNER_TEMP "codex-${Label}"
  $stdoutPath = "${logPrefix}-stdout.log"
  $stderrPath = "${logPrefix}-stderr.log"
  $userDataDir = "${logPrefix}-user-data"
  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $userDataDir -Recurse -Force -ErrorAction SilentlyContinue
  $arguments = $SmokeArguments + "--user-data-dir=${userDataDir}"

  $process = $null
  $alive = $false
  $exitCode = $null
  try {
    $process = Start-Process `
      -FilePath $Executable `
      -ArgumentList $arguments `
      -PassThru `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath
    Start-Sleep -Seconds $DurationSeconds
    $alive = -not $process.HasExited
    if (-not $alive) {
      $exitCode = $process.ExitCode
    }
  } finally {
    if ($null -ne $process -and -not $process.HasExited) {
      & taskkill.exe /PID $process.Id /T /F | Out-Null
      Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
    }
  }

  return [PSCustomObject]@{
    Label = $Label
    Alive = $alive
    ExitCode = $exitCode
    Stdout = Read-SmokeLog $stdoutPath
    Stderr = Read-SmokeLog $stderrPath
  }
}

function Format-SmokeResult {
  param([PSCustomObject]$Result)

  $state = if ($Result.Alive) { "alive" } else { "exit=$($Result.ExitCode)" }
  return @"
[$($Result.Label)] $state
stdout:
$($Result.Stdout)
stderr:
$($Result.Stderr)
"@
}

if ($DurationSeconds -lt 1) {
  throw "DurationSeconds must be positive"
}

$env:ELECTRON_DISABLE_GPU = "1"
$env:ELECTRON_ENABLE_LOGGING = "1"
$upstream = Invoke-CodexSmoke $UpstreamExecutable "upstream" $DurationSeconds
$packaged = Invoke-CodexSmoke $PackagedExecutable "packaged" $DurationSeconds
$upstreamSummary = Format-SmokeResult $upstream
$packagedSummary = Format-SmokeResult $packaged
Write-Host $upstreamSummary
Write-Host $packagedSummary

if (-not $packaged.Alive) {
  if (-not $upstream.Alive) {
    throw "Both upstream and packaged apps exited during smoke testing.`n${upstreamSummary}`n${packagedSummary}"
  }
  throw "Packaged app exited while the upstream baseline stayed alive.`n${packagedSummary}"
}
