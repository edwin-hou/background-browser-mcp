[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Start', 'Stop', 'Status', 'Open', 'Uninstall')][string]$Action,
    [Alias('InstallDir')][string]$InstallDirectory = (Join-Path $env:USERPROFILE '.background-browser')
)
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'windows-task.ps1'
& $helper -Action $Action -InstallDirectory $InstallDirectory
