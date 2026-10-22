$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'apk-installer.mjs') --config (Join-Path $PSScriptRoot 'connector.production.local.json')
exit $LASTEXITCODE
