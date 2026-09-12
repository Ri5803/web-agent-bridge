param(
    [ValidateSet("start", "status", "stop")]
    [string]$Command = "status"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$settings = Get-Content -LiteralPath (Join-Path $root ".mcp.json") -Raw | ConvertFrom-Json
$env:WEB_AGENT_DATA_DIR = $settings.mcpServers.web_agent_bridge.env.WEB_AGENT_DATA_DIR
$node = $settings.mcpServers.web_agent_bridge.command
& $node (Join-Path $root "src\cli.mjs") $Command
if ($LASTEXITCODE -ne 0) { throw "Bridge command failed: $Command" }
