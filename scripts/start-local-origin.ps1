$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$state = Join-Path $workspace '.local-gateway'
$config = Get-Content -LiteralPath (Join-Path $state 'config.json') -Raw | ConvertFrom-Json
$env:NODE_USE_ENV_PROXY = '1'
$browserProxy = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyEnable,ProxyServer -ErrorAction SilentlyContinue
if ($browserProxy.ProxyEnable -eq 1 -and $browserProxy.ProxyServer -match '^127\.0\.0\.1:\d+$') {
  $env:HTTPS_PROXY = 'http://' + $browserProxy.ProxyServer
  $env:HTTP_PROXY = $env:HTTPS_PROXY
  $env:NO_PROXY = 'localhost,127.0.0.1'
}
$nodePath = (Get-Command node).Source
$gatewayScript = Join-Path $PSScriptRoot 'local-gateway.mjs'
$running = $false
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/health" -Headers @{Authorization="Bearer $($config.token)"} -TimeoutSec 3
  $running = $health.ok -eq $true
} catch {}
if (-not $running) {
  $server = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $gatewayScript + '"')) -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $state 'origin.log') -RedirectStandardError (Join-Path $state 'origin-error.log')
  Set-Content -LiteralPath (Join-Path $state 'origin.pid') -Value $server.Id
}
$tunnelFile = Join-Path $state 'tunnel-token.txt'
if (Test-Path -LiteralPath $tunnelFile) {
  $connector = Join-Path $state 'bin/cloudflared-windows-amd64.exe'
  $already = $false
  $pidFile = Join-Path $state 'tunnel.pid'
  if (Test-Path -LiteralPath $pidFile) {
    $connectorPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $connectorPid" -ErrorAction SilentlyContinue
    $already = $p -and $p.ExecutablePath -eq $connector
  }
  if (-not $already) {
    $tunnel = Start-Process -FilePath $connector -ArgumentList @('tunnel','--no-autoupdate','--protocol','http2','run','--token-file',('"' + $tunnelFile + '"')) -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $state 'tunnel.log') -RedirectStandardError (Join-Path $state 'tunnel-error.log')
    Set-Content -LiteralPath $pidFile -Value $tunnel.Id
  }
}
Write-Output 'Local official origin started. Keep the computer connected while using Bilibili search.'
