[CmdletBinding()]
param(
    [Alias('InstallDir')][string]$InstallDirectory = (Join-Path $env:USERPROFILE '.background-browser'),
    [string]$ChromePath,
    [switch]$NoStart,
    [switch]$SkipDependencies
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This installer supports Windows 10 and 11.' }
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) { throw 'Install Node.js 24 LTS (or another supported release, minimum 22) from https://nodejs.org/, reopen your terminal, and try again.' }
$setupScript = Join-Path $PSScriptRoot 'setup.cjs'
$setupArguments = @($setupScript, '--install-directory', $InstallDirectory)
if ($ChromePath) { $setupArguments += @('--chrome-path', $ChromePath) }
if ($NoStart) { $setupArguments += '--no-start' }
if ($SkipDependencies) { $setupArguments += '--skip-dependencies' }
function ConvertTo-NativeArgument([string]$Value) {
    # Windows command-line quoting, including quotes and trailing backslashes.
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $nodeCommand.Source
$start.Arguments = (($setupArguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$processObject = New-Object Diagnostics.Process
$processObject.StartInfo = $start
try {
    [void]$processObject.Start()
    $outputTask = $processObject.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
    $errorTask = $processObject.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
    $processObject.WaitForExit()
    [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($outputTask, $errorTask))
    if ($processObject.ExitCode -ne 0) { throw ('Installation did not complete (exit {0}).' -f $processObject.ExitCode) }
} finally { $processObject.Dispose() }
