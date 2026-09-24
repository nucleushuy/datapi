param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [ValidateRange(1, 300000)][int]$TimeoutMilliseconds = 300000
)

# Only this repository-owned helper is compiled. Requests are data, never PowerShell or C# source.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    Add-Type -LiteralPath (Join-Path $PSScriptRoot 'windows-worker.cs') -ErrorAction Stop
    $code = [WorkbenchAnalyticalProcess]::Run($NodePath, (Join-Path $PSScriptRoot 'analytical-worker.ts'), $RequestPath, $TimeoutMilliseconds)
    exit $code
} catch {
    # Compiler/native errors may contain local paths. The parent maps this fixed exit code.
    exit 120
}
