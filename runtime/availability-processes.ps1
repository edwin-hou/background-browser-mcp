param(
  [ValidateSet('scan','terminate','self-test')][string]$Action = 'scan',
  [Parameter(Mandatory=$true)][string]$InstallationRoot,
  [Parameter(Mandatory=$true)][string]$NodeExecutable,
  [string]$ChromeExecutable = 'C:\Program Files\Google\Chrome\Application\chrome.exe',
  [int]$TargetPid = 0,
  [string]$BirthTicks = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AvailabilityNative {
  [DllImport("shell32.dll", SetLastError=true)] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr handle, uint code);
}
'@
function Canonical([string]$Value) { if (!$Value) { return '' }; return [IO.Path]::GetFullPath($Value).TrimEnd('\').ToLowerInvariant() }
$Install = Canonical $InstallationRoot
$NodeImage = Canonical $NodeExecutable
$ChromeImage = Canonical $ChromeExecutable
function Argv([string]$CommandLine) {
  $count = 0; $memory = [AvailabilityNative]::CommandLineToArgvW($CommandLine, [ref]$count)
  if ($memory -eq [IntPtr]::Zero) { return @() }
  try { $result = @(); for ($i=0; $i -lt $count; $i++) { $result += [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory, $i * [IntPtr]::Size)) }; return $result }
  finally { [void][AvailabilityNative]::LocalFree($memory) }
}
function FlagValue($Arguments, [string]$Name) {
  $found = @()
  for ($i=1; $i -lt $Arguments.Count; $i++) {
    if ($Arguments[$i] -eq $Name -and ($i+1) -lt $Arguments.Count) { $found += $Arguments[$i+1] }
    elseif ($Arguments[$i].StartsWith($Name+'=')) { $found += $Arguments[$i].Substring($Name.Length+1) }
  }
  if ($found.Count -eq 1) { return $found[0] }; return $null
}
function Kind($Row) {
  if (!$Row.ExecutablePath -or !$Row.CommandLine) { return $null }
  $image = Canonical $Row.ExecutablePath; $argv = @(Argv $Row.CommandLine)
  if ($image -eq $NodeImage -and $argv.Count -ge 2) {
    $script = Canonical $argv[1]
    if ($script -eq (Join-Path $Install 'service.cjs')) { return 'service' }
    if ($script -eq (Join-Path $Install 'availability.cjs')) { return 'supervisor' }
    if ($script -eq (Join-Path $Install 'setup\portal.cjs')) { return 'portal' }
    if ($script -eq (Join-Path $Install 'gateway\server.mjs')) { return 'gateway' }
    if ($script -eq (Join-Path $Install 'node_modules\@playwright\mcp\cli.js') -and
        (FlagValue $argv '--host') -eq '127.0.0.1' -and (FlagValue $argv '--port') -eq '8933' -and
        (FlagValue $argv '--cdp-endpoint') -eq 'http://127.0.0.1:8935') { return 'mcp' }
  }
  $headless = @($argv | Where-Object { $_ -eq '--headless' -or $_ -eq '--headless=new' }).Count -gt 0
  $childType = @($argv | Where-Object { $_ -eq '--type' -or $_.StartsWith('--type=') }).Count -gt 0
  if ($image -eq $ChromeImage -and $headless -and !$childType -and (Canonical (FlagValue $argv '--user-data-dir')) -eq (Join-Path $Install 'profiles\default') -and
      (FlagValue $argv '--remote-debugging-port') -eq '8935' -and (FlagValue $argv '--remote-debugging-address') -eq '127.0.0.1') { return 'chrome' }
  if ($image -eq (Join-Path $Install 'ngrok\ngrok.exe') -and $argv.Count -ge 3 -and $argv[1] -eq 'http' -and $argv[2] -eq 'http://127.0.0.1:8934') { return 'ngrok' }
  return $null
}
function BoundRecord([int]$Id, [string]$ExpectedBirth = '') {
  $bound = [Diagnostics.Process]::GetProcessById($Id)
  try {
    # Opening Handle before identity checks binds all later termination to this process object.
    $handle = $bound.Handle
    if ($bound.HasExited) { return $null }
    $birth = $bound.StartTime.ToUniversalTime().Ticks.ToString()
    if ($ExpectedBirth -and $birth -cne $ExpectedBirth) { return $null }
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $Id"
    if ($bound.HasExited -or !$row) { return $null }
    $kind = Kind $row
    if (!$kind) { return $null }
    if ($Action -eq 'terminate') {
      # Reconfirm identity after querying metadata; PID reuse cannot replace this acquired handle.
      if ($bound.HasExited -or $bound.StartTime.ToUniversalTime().Ticks.ToString() -cne $ExpectedBirth) { return $null }
      if (![AvailabilityNative]::TerminateProcess($handle, 1)) { throw 'Verified process termination failed.' }
      [void]$bound.WaitForExit(5000)
      return @{ pid=$Id; birthTicks=$birth; kind=$kind; terminated=$bound.HasExited }
    }
    return @{ pid=$Id; birthTicks=$birth; kind=$kind }
  } finally { $bound.Dispose() }
}
try {
  if ($Action -eq 'self-test') {
    # Synthetic command lines exercise the real Windows argument parser and the kill boundary.
    $chromeBase = '"'+$ChromeExecutable+'" --user-data-dir="'+(Join-Path $Install 'profiles\default')+'" --remote-debugging-port=8935 --remote-debugging-address=127.0.0.1'
    $cases = @(
      @{image=$ChromeExecutable; command=$chromeBase+' --headless'; expected='chrome'},
      @{image=$ChromeExecutable; command=$chromeBase+' --headless=new'; expected='chrome'},
      @{image=$ChromeExecutable; command=$chromeBase; expected=$null},
      @{image=$ChromeExecutable; command=$chromeBase+' --headless --type=renderer'; expected=$null},
      @{image=$ChromeExecutable; command=$chromeBase.Replace('default"','default-other"')+' --headless'; expected=$null},
      @{image=$ChromeExecutable; command=$chromeBase.Replace('8935','9999')+' --headless'; expected=$null},
      @{image=$NodeExecutable; command='"'+$NodeExecutable+'" "'+(Join-Path $Install 'service.cjs')+'"'; expected='service'},
      @{image=$NodeExecutable; command='"'+$NodeExecutable+'" "'+(Join-Path $Install 'availability.cjs')+'"'; expected='supervisor'},
      @{image=$NodeExecutable; command='"'+$NodeExecutable+'" "C:\unrelated.cjs" "'+(Join-Path $Install 'service.cjs')+'"'; expected=$null},
      @{image=(Join-Path $Install 'ngrok\ngrok.exe'); command='"'+(Join-Path $Install 'ngrok\ngrok.exe')+'" http http://127.0.0.1:9999'; expected=$null},
      @{image=(Join-Path $Install 'ngrok\ngrok.exe'); command='"'+(Join-Path $Install 'ngrok\ngrok.exe')+'" http http://127.0.0.1:8934'; expected='ngrok'}
    )
    foreach ($case in $cases) { if ((Kind ([pscustomobject]@{ExecutablePath=$case.image;CommandLine=$case.command})) -cne $case.expected) { throw 'Signature boundary test failed.' } }
    @{ok=$true; checks=$cases.Count; realProcessesInspected=$false; realProcessesTerminated=$false} | ConvertTo-Json -Compress
  } elseif ($Action -eq 'terminate') {
    if ($TargetPid -le 0 -or !$BirthTicks) { throw 'An exact process identity is required.' }
    $record = BoundRecord $TargetPid $BirthTicks
    if (!$record) { @{ ok=$false; reason='identity-mismatch-or-exited' } | ConvertTo-Json -Compress }
    else { @{ ok=($record.terminated -eq $true); process=$record } | ConvertTo-Json -Compress -Depth 3 }
  } else {
    $records = @()
    foreach ($row in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'chrome.exe' OR Name = 'ngrok.exe'")) {
      try { if (!(Kind $row)) { continue }; $record = BoundRecord ([int]$row.ProcessId); if ($record) { $records += $record } } catch { }
    }
    @{ ok=$true; processes=@($records) } | ConvertTo-Json -Compress -Depth 3
  }
} catch { @{ ok=$false; reason='process-inspection-failed' } | ConvertTo-Json -Compress; exit 1 }
