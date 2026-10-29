$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$state = Join-Path $workspace '.local-gateway'
foreach ($component in @('origin','tunnel')) {
  $pidFile = Join-Path $state "$component.pid"
  if (Test-Path -LiteralPath $pidFile) {
    $componentPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $componentPid" -ErrorAction SilentlyContinue
    $belongs = $p -and ($p.CommandLine.Contains((Join-Path $PSScriptRoot 'local-gateway.mjs')) -or $p.ExecutablePath -eq (Join-Path $state 'bin/cloudflared-windows-amd64.exe'))
    if ($belongs) { Stop-Process -Id $componentPid }
    Remove-Item -LiteralPath $pidFile
  }
}
Write-Output 'Local official origin stopped.'
