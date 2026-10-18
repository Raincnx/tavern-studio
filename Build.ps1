$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$runtime = Join-Path $PSScriptRoot '..\runtime\node-v24.19.0-win-x64'
$env:PATH = "$runtime;$env:PATH"
& (Join-Path $runtime 'node.exe') (Join-Path $runtime 'node_modules\npm\bin\npm-cli.js') run build
exit $LASTEXITCODE
