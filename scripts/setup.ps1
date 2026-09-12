param(
    [Parameter(Mandatory = $true)]
    [string]$DataDir
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
Push-Location -LiteralPath $root
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
    & $node (Join-Path $PSScriptRoot "configure.mjs") --data-dir $DataDir
    if ($LASTEXITCODE -ne 0) { throw "Configuration failed." }
} finally {
    Pop-Location
}
