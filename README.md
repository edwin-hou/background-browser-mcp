# Background Browser MCP

Give Codex and, optionally, ChatGPT access to a separate signed-in browser on your Windows PC. Routine browsing runs headless. You sign in directly on each website once, then reuse the saved session through MCP.

The project uses Playwright MCP, a local setup dashboard, a persistent Chrome profile, and recovery supervisors. It does not call a model API or require an OpenAI API key. ChatGPT access optionally uses an authenticated OAuth gateway and your own ngrok account.

## Quick start on Windows

1. On Windows, install **Node.js 22 or newer** and **Google Chrome**. **Node.js 24 LTS and Windows 11 are recommended.** Have your usual Codex client available.
2. Download this repository with **Code → Download ZIP**, extract it, and open PowerShell in the extracted folder.
3. Run:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```

4. Open the generated **Open browser setup.url** shortcut in your installation folder. The default installation is `%USERPROFILE%\.background-browser`.
5. Add a website, select **Sign in**, and complete its password, SSO, or MFA prompts directly in the separate login window. Return to the dashboard and select **Save & close sign-in window**. The control stays visible and enables when the window is ready.
6. Merge the generated **codex-config.example.toml** from your installation folder into your Codex MCP configuration, then reload the connection. It includes the correct paths for the local bridge, which keeps the Codex connection alive across browser-service restarts. The [Codex instructions](docs/codex.md) also describe the compatible direct HTTP connection.

Ask Codex: “Use my background browser to open the website I saved and verify that I am signed in.” A saved website card or a healthy service does not establish that its account session works.

[Full Windows setup](docs/windows-setup.md) · [Codex connection](docs/codex.md) · [Optional ChatGPT connection](docs/chatgpt.md)

## What stays on your PC

Your separate profile and session handoff live under the installation folder. This browser does not reuse your personal Chrome profile. Login windows appear only when you start the sign-in flow; ordinary tool calls use headless Chrome. Saved sessions can expire or be invalidated by the website.

The login window starts installed Chrome directly and connects through Chrome's supported debugging interface. Websites can still restrict automated access; this project does not guarantee sign-in to every Google product or other site. See [login troubleshooting](docs/troubleshooting.md).

The private dashboard updates connection status while it is open and highlights confirmed sign-in requirements observed during normal website tasks. Website cards show when sign-in was saved and access was last verified, with an overview separating missing saves, sessions needing a check, recent verified access, and confirmed sign-in requirements. Verification older than 24 hours and unverified saves at least 7 days old receive reminders; those reminders do not declare an account signed out. Saved sessions and unvisited accounts are shown separately from verified access. Account tasks pause for the owner to reconnect when the browser or required account is unavailable; they do not switch to another browser.

The private dashboard shortcut contains a local access token. The optional OAuth gateway has a separate owner passphrase. Keep both, your ngrok authtoken, browser data, and OAuth state off GitHub and out of chat messages. Each friend installs their own runtime and signs into their own accounts. Sharing this source does not share the author's browser, app, or accounts.

## Cost and availability

The local browser components have no project service fee. Optional remote access can fit within ngrok's current free plan, which has an assigned development domain and usage caps. This is not a promise that third-party services, subscriptions, or limits will remain free forever. See [ngrok's current free-plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits).

Your Codex/ChatGPT account, available features, workspace policy, and usage limits remain separate. In particular, this project cannot grant access to custom MCP plugins if your ChatGPT account does not have it. The [official custom MCP guide](https://developers.openai.com/api/docs/guides/custom-mcp-server) describes the web setup and applicable restrictions.

The PC must be awake, signed in, and connected to the internet for remote use. Recovery restarts failed components; it cannot browse while the PC is off, restore an expired website login, or guarantee recovery from every live-but-unresponsive process.

## Project layout

| Folder | Purpose |
| --- | --- |
| `runtime/` | Browser manager, manual login helper, dashboard, OAuth gateway, and recovery sources |
| `scripts/` | Fresh Windows installation and management |
| `plugin/` | Generic local plugin source and account-browsing skill; no registered app binding |
| `docs/` | Setup, architecture, privacy, and example configuration |

The installer does not overwrite your Codex configuration. You can use the direct MCP connection or the optional [local plugin template](plugin/README.md). The repository is source distribution; it is not an OpenAI plugin-store submission.

See [architecture and recovery](docs/architecture.md), [privacy and security](docs/security.md), and [troubleshooting](docs/troubleshooting.md). Start with the local Codex connection before adding remote access.
