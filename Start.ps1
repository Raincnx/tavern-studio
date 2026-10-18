$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$runtime = Join-Path $PSScriptRoot '..\runtime\node-v24.19.0-win-x64'
$env:PATH = "$runtime;$env:PATH"
try {
    $health = Invoke-RestMethod 'http://127.0.0.1:3000/health' -TimeoutSec 2
    if ($health.application -eq 'tavern-studio') { Write-Host 'Tavern Studio is already running: http://127.0.0.1:3000'; exit 0 }
} catch {}
if (-not (Test-Path 'apps\web\dist\index.html')) { throw '请先运行 npm run build，或使用 Start-Dev.ps1 开发模式。' }
& (Join-Path $runtime 'node.exe') apps/server/src/index.ts
exit $LASTEXITCODE
