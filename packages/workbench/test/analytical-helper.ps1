param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [ValidateRange(1, 300000)][int]$TimeoutMilliseconds = 300000
)

# Exercise the actual helper with one fixed repository-owned fixture, never a supplied worker path.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    Add-Type -LiteralPath (Join-Path $PSScriptRoot '../src/windows-worker.cs') -ErrorAction Stop
    $code = [WorkbenchAnalyticalProcess]::Run($NodePath, (Join-Path $PSScriptRoot 'analytical-helper-fixture.mjs'), $RequestPath, $TimeoutMilliseconds)
    exit $code
} catch {
    exit 120
}
