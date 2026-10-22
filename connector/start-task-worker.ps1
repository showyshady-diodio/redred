$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node task-worker.mjs --config connector.production.local.json
