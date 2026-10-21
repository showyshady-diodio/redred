param([switch]$Once, [switch]$DryRun, [switch]$Production)
$ErrorActionPreference = 'Stop'
$connectorArgs = @((Join-Path $PSScriptRoot 'adb-connector.mjs'))
if ($Production) { $connectorArgs += @('--config', (Join-Path $PSScriptRoot 'connector.production.local.json')) }
if ($Once) { $connectorArgs += '--once' }
if ($DryRun) { $connectorArgs += '--dry-run' }
& node @connectorArgs
exit $LASTEXITCODE
