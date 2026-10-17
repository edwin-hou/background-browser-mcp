[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('SecureDirectory', 'Start', 'Stop', 'Status', 'Open', 'Uninstall')][string]$Action,
    [Parameter(Mandatory = $true)][Alias('InstallDir')][string]$InstallDirectory
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
if (-not [IO.Path]::IsPathRooted($InstallDirectory) -or $root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'Choose an absolute, dedicated installation directory.' }
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Installation directory does not exist.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User

if ($Action -eq 'SecureDirectory') {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagate = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $propagate, $allow)))
    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', $inherit, $propagate, $allow)))
    Set-Acl -LiteralPath $root -AclObject $acl
    return
}

$metadataFile = Join-Path $root 'installation.json'
$metadata = Get-Content -LiteralPath $metadataFile -Raw | ConvertFrom-Json
if ($metadata.version -ne 1 -or $metadata.id -notmatch '^[0-9a-f-]{36}$' -or $metadata.taskName -notmatch '^Background Browser [0-9a-f]{8}$' -or
    [IO.Path]::GetFullPath($metadata.root).TrimEnd('\') -ne $root -or -not [IO.Path]::IsPathRooted($metadata.nodeExecutable)) { throw 'Installation metadata is invalid.' }
$description = 'Background Browser managed install: ' + $metadata.id
$launcher = Join-Path $root 'BrowserAvailability.exe'
$nodeExecutable = $metadata.nodeExecutable
if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'The launcher or Node.js executable is missing.' }
$task = Get-ScheduledTask -TaskName $metadata.taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task) {
    $actions = @($task.Actions)
    try {
        if ($task.Principal.UserId -match '^S-1-') { $taskSid = (New-Object Security.Principal.SecurityIdentifier($task.Principal.UserId)).Value }
        else { $taskSid = (New-Object Security.Principal.NTAccount($task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value }
    } catch { throw 'The task owner could not be verified. It was not changed.' }
    if ($task.Description -ne $description -or $actions.Count -ne 1 -or $actions[0].Execute -ne $launcher -or
        $actions[0].WorkingDirectory -ne $root -or $actions[0].Arguments -or $taskSid -ne $sid.Value -or
        [string]$task.Principal.LogonType -ne 'Interactive' -or [string]$task.Principal.RunLevel -ne 'Limited') { throw 'A different task uses this name. It was not changed.' }
}

function Invoke-Policy([string]$Verb) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $nodeExecutable
    # Both strings are local validated file paths; no secret or user URL enters a command line.
    $start.Arguments = '"' + (Join-Path $root 'availability.cjs') + '" --' + $Verb
    $start.WorkingDirectory = $root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $processObject = New-Object Diagnostics.Process
    $processObject.StartInfo = $start
    try {
        [void]$processObject.Start()
        $outTask = $processObject.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        $errorTask = $processObject.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        if (-not $processObject.WaitForExit(30000)) { throw 'The availability command did not finish. Check its local status files.' }
        [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($outTask, $errorTask))
        if ($processObject.ExitCode -ne 0) { throw 'The availability command failed. Check the local installation.' }
    } finally { $processObject.Dispose() }
}
function Write-SetupShortcut {
    $tokenPath = Join-Path $root 'setup\access-token.txt'
    if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { return $false }
    $token = ([IO.File]::ReadAllText($tokenPath)).Trim()
    if ($token -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'The private setup token is invalid.' }
    # The URL is intentionally kept in a local private file, never printed.
    [IO.File]::WriteAllText((Join-Path $root 'Open browser setup.url'), "[InternetShortcut]`r`nURL=http://127.0.0.1:8936/?token=$token`r`n", (New-Object Text.UTF8Encoding($false)))
    return $true
}
function Write-ManagementShortcuts {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($verb in @('Start', 'Stop')) {
        $shortcut = $shell.CreateShortcut((Join-Path $root ($verb + ' Background Browser.lnk')))
        $shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
        $shortcut.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'scripts\manage.ps1') + '" -Action ' + $verb + ' -InstallDirectory "' + $root + '"'
        $shortcut.WorkingDirectory = $root
        $shortcut.WindowStyle = 7
        $shortcut.Description = $description
        $shortcut.Save()
    }
}
function Test-LocalReady {
    try {
        $serviceState = Get-Content -LiteralPath (Join-Path $root 'service-state.json') -Raw | ConvertFrom-Json
        $serviceLock = Get-Content -LiteralPath (Join-Path $root 'service.lock') -Raw | ConvertFrom-Json
        $portalLock = Get-Content -LiteralPath (Join-Path $root 'setup\portal.lock') -Raw | ConvertFrom-Json
        if ($serviceState.status -ne 'running' -or $serviceState.ready -ne $true -or $serviceState.headless -ne $true -or
            $serviceState.managerPid -ne $serviceLock.pid -or $serviceState.managerToken -ne $serviceLock.token) { return $false }
        if (-not (Get-Process -Id $serviceLock.pid -ErrorAction SilentlyContinue) -or -not (Get-Process -Id $portalLock.pid -ErrorAction SilentlyContinue)) { return $false }
        $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:8936/')
        $request.AllowAutoRedirect = $false
        $request.Timeout = 1500
        try { $response = $request.GetResponse() } catch [Net.WebException] { $response = $_.Exception.Response }
        if (-not $response) { return $false }
        try {
            $reader = New-Object IO.StreamReader($response.GetResponseStream())
            try { return [int]$response.StatusCode -eq 403 -and $reader.ReadToEnd() -eq 'Open your private setup shortcut.' } finally { $reader.Dispose() }
        } finally { $response.Dispose() }
    } catch { return $false }
}
function Wait-OwnedWorkersStopped {
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    do {
        $statePath = Join-Path $root 'availability-state.json'
        try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { $state = $null }
        $serviceLock = Join-Path $root 'service.lock'
        $portalLock = Join-Path $root 'setup\portal.lock'
        if (-not (Test-Path -LiteralPath $serviceLock) -and -not (Test-Path -LiteralPath $portalLock)) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Graceful stop did not finish. The task and private profile were preserved; check local status before uninstalling.'
}

switch ($Action) {
    'Status' {
        $result = [ordered]@{ installed = $true; installDirectory = $root; taskName = $metadata.taskName; taskState = $(if ($task) { [string]$task.State } else { 'Not registered' }) }
        if ($task) { $info = $task | Get-ScheduledTaskInfo; $result.lastTaskResult = $info.LastTaskResult }
        $policyFile = Join-Path $root 'availability-config.json'
        try { $result.enabled = [bool]((Get-Content -LiteralPath $policyFile -Raw | ConvertFrom-Json).enabled) } catch { $result.enabled = $false }
        [pscustomobject]$result | ConvertTo-Json
    }
    'Start' {
        if ($metadata.dependenciesInstalled -ne $true) { throw 'This installation skipped dependencies. Complete npm ci and reinstall into a fresh folder before starting.' }
        if (-not $task) {
            $actionObject = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $root
            $logon = New-ScheduledTaskTrigger -AtLogOn -User $sid.Value
            $periodic = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)
            $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
            $principal = New-ScheduledTaskPrincipal -UserId $sid.Value -LogonType Interactive -RunLevel Limited
            $task = Register-ScheduledTask -TaskName $metadata.taskName -TaskPath '\' -Action $actionObject -Trigger @($logon, $periodic) -Settings $settings -Principal $principal -Description $description
        }
        Invoke-Policy 'enable'
        Enable-ScheduledTask -TaskName $metadata.taskName -TaskPath '\' | Out-Null
        Start-ScheduledTask -TaskName $metadata.taskName -TaskPath '\'
        $shortcutReady = $false
        for ($attempt = 0; $attempt -lt 240; $attempt++) {
            if ((Test-LocalReady) -and (Write-SetupShortcut)) { $shortcutReady = $true; break }
            Start-Sleep -Milliseconds 250
        }
        Write-ManagementShortcuts
        if (-not $shortcutReady) { throw 'Windows accepted the startup request, but the headless browser and private dashboard did not confirm readiness within 60 seconds. Use -Action Status and check availability status files.' }
        Write-Output ('Ready. Open the private Open browser setup.url shortcut in: ' + $root)
    }
    'Open' {
        if (-not (Write-SetupShortcut)) { throw 'Start Background Browser first, then open the setup shortcut.' }
        # Explicit Open is the only management command that opens a visible app.
        Invoke-Item -LiteralPath (Join-Path $root 'Open browser setup.url')
    }
    'Stop' {
        Invoke-Policy 'disable'
        if ($task) { Disable-ScheduledTask -TaskName $metadata.taskName -TaskPath '\' | Out-Null }
        Wait-OwnedWorkersStopped
        Write-Output 'Background Browser stopped. Automatic startup is disabled until Start is selected.'
    }
    'Uninstall' {
        Invoke-Policy 'disable'
        if ($task) { Disable-ScheduledTask -TaskName $metadata.taskName -TaskPath '\' | Out-Null }
        Wait-OwnedWorkersStopped
        if ($task) { Unregister-ScheduledTask -TaskName $metadata.taskName -TaskPath '\' -Confirm:$false }
        foreach ($filename in @('Start Background Browser.lnk', 'Stop Background Browser.lnk', 'Open browser setup.url')) {
            $target = Join-Path $root $filename
            if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target }
        }
        Write-Output ('Startup registration was removed. Your private browser profile and installation files were retained at: ' + $root)
    }
}
