# Windows setup

## Prerequisites

- Windows with a normal signed-in user account and PowerShell. **Windows 11 is recommended**; other Windows versions have not been verified for this export.
- Node.js 22 or newer on `PATH`; **Node.js 24 LTS is recommended**. Get a supported release from [nodejs.org](https://nodejs.org/).
- Google Chrome from [google.com/chrome](https://www.google.com/chrome/).
- Internet access for the dependency installation, and the built-in .NET Framework C# compiler used to build the hidden launcher.
- A Codex client that supports MCP. Remote ChatGPT setup is optional and has separate account requirements.

Run the installer as the user who will own the browser. Do not install another person's cookies or reuse their connection files.

## Install

From the extracted repository folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The default target is `%USERPROFILE%\.background-browser`. To choose a fresh folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDirectory "$env:USERPROFILE\MyBackgroundBrowser"
```

The installer is for a fresh target and does not replace an existing profile. It installs dependencies, builds the Windows GUI launcher, prepares private storage, and configures startup/recovery for this installation. It records the selected Node executable in `node-path.txt` and Chrome executable in `runtime-settings.json`; the runtime does not depend on another person's Program Files paths. It does not alter your Codex config or connect your ChatGPT account automatically.

Use a real filesystem folder in your user profile. Avoid Windows app-package virtualized paths when configuring an operating-system startup entry: a path that exists only inside one packaged app may not be visible to Task Scheduler or Explorer.

For a source/development check, `-NoStart` prepares the installation without starting it or creating its startup task/shortcuts. `-SkipDependencies` is an offline fixture/development option, not a complete usable installation.

## Sign in to websites

1. Open **Open browser setup.url** inside your installation folder. Opening bare `http://127.0.0.1:8936` should not show the dashboard; use the private shortcut.
2. Add the website's HTTPS URL and a display name. A university website card may be included as a removable preset; it carries no login.
3. Select **Sign in**. This deliberately opens a visible Chrome window using the dedicated profile and pauses background browser access.
4. Enter passwords, SSO, security keys, and MFA directly on the website. Do not put them in chat or in setup fields intended for the website URL.
5. Return to the dashboard and select **Save & close sign-in window**. Closing the login window with X also leaves the most recent checkpoint; the explicit save action confirms the handoff while the browser is alive.
6. Verify the authenticated page through the connected MCP client. The dashboard's saved-session receipt confirms storage, not successful authentication at a website.

All website cards use the same separate profile. They are shortcuts, not isolated account containers. Removing a card keeps its browser data. Use the website's sign-out action when you intend to log out.

## Start, stop, and manage

Use the generated **Start Background Browser** and **Stop Background Browser** shortcuts for normal control. Stop records a durable disabled policy before requesting shutdown, so recovery will not immediately reopen it.

The repository also provides management commands:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage.ps1 -Action Status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage.ps1 -Action Start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage.ps1 -Action Stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage.ps1 -Action Open
```

For a custom installation, add `-InstallDirectory` with the same path you installed into. Keep the installation at that path after startup is registered.

Uninstall removes this installation's managed startup entry and shortcuts while retaining private browser data:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage.ps1 -Action Uninstall
```

Read its result before deleting any retained folder yourself. Do not delete a profile while its browser or login window is running. Remove the MCP connection from your client separately.
