# Run the .cmd shim in PowerShell so its installation path can contain spaces.
[CmdletBinding()]
param(
    [string]$Task,
    [string]$Cwd = (Get-Location).Path,
    [ValidateSet('deepseek-flash', 'deepseek-v4-pro')][string]$Model = 'deepseek-flash',
    [string]$SessionId,
    [Alias('h')][switch]$Help
)
if ($Help -or -not $Task) {
    Write-Output 'dsh-run.ps1 -Task <text or path> [-Cwd DIR] [-Model deepseek-flash|deepseek-v4-pro] [-SessionId ID] [-Help]'
    if ($Help) { exit 0 } else { exit 1 }
}
$ErrorActionPreference = 'Stop'
$env:FLEET_WORKER = '1'
$repo = Split-Path -Parent $PSScriptRoot
$overlay = Join-Path $repo 'deepseek/account.patch.yml'
$temporary = $null
$exitCode = 1
try {
    $exe = & node (Join-Path $repo 'lib/toolkit.mjs') dsh
    if ($LASTEXITCODE -ne 0 -or -not $exe) { throw 'DeepSeek Harness not found; run node setup.mjs' }
    try { $taskIsFile = Test-Path -LiteralPath $Task -PathType Leaf } catch { $taskIsFile = $false }
    if ($taskIsFile) { $Task = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Task).Path) }
    if ($Model -ne 'deepseek-flash') {
        $temporary = Join-Path ([IO.Path]::GetTempPath()) ('toolkit-dsh-' + [guid]::NewGuid().ToString('N') + '.yml')
        $content = [IO.File]::ReadAllText($overlay) -replace '(?m)^(\s*model:\s*)deepseek-flash\s*$', ('${1}' + $Model)
        [IO.File]::WriteAllText($temporary, $content, (New-Object Text.UTF8Encoding($false)))
        $overlay = $temporary
    }
    $arguments = @('--profile', 'headless', '--patch', $overlay, '--json')
    if ($SessionId) { $arguments += @('--session-id', $SessionId) }
    $arguments += @('-')
    Push-Location -LiteralPath $Cwd
    try {
        $OutputEncoding = New-Object Text.UTF8Encoding($false)
        $Task | & $exe @arguments
        $exitCode = $LASTEXITCODE
    } finally { Pop-Location }
} catch { Write-Error $_ -ErrorAction Continue }
finally { if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary } }
exit $exitCode
