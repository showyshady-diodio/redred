param([switch]$Once, [switch]$DryRun, [switch]$Production, [string]$Config)
$ErrorActionPreference = 'Stop'
$connectorArgs = @((Join-Path $PSScriptRoot 'adb-connector.mjs'))
if ($Config) { $connectorArgs += @('--config', $Config) }
elseif ($Production) { $connectorArgs += @('--config', (Join-Path $PSScriptRoot 'connector.production.local.json')) }
if ($Once) { $connectorArgs += '--once' }
if ($DryRun) { $connectorArgs += '--dry-run' }
& node @connectorArgs
exit $LASTEXITCODE
