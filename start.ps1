param([switch]$Check)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$pilotNode = Get-Command node -ErrorAction SilentlyContinue
if ($pilotNode) { $pilotNodePath = $pilotNode.Source }
else {
    $pilotNodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (!(Test-Path -LiteralPath $pilotNodePath)) { throw 'Install Node.js 24 LTS, then restart. See README.md.' }
}
if (!(Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
if (!(Test-Path -LiteralPath 'node_modules/@larksuiteoapi/node-sdk/package.json')) {
    throw 'Dependencies are missing. Run pnpm install as described in README.md.'
}
if ($Check) { & $pilotNodePath --env-file-if-exists=.env scripts/doctor.mjs }
else { & $pilotNodePath --env-file-if-exists=.env src/main.mjs }
if ($LASTEXITCODE -ne 0) { throw 'The process failed. See the error above.' }
