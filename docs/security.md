# Privacy and security

Your browser session can access whatever you signed into that profile. Give the connection to your own trusted agent clients and use it within the task you requested. Website content can contain misleading instructions; treat it as data rather than authorization to take unrelated actions.

## Local private data

The installation contains more than executable source:

- The profile under `profiles/default`, including authenticated website state.
- Session-only cookie handoff files inside the protected profile.
- The dashboard access token and its private `.url` shortcut.
- Optional ngrok credentials/configuration, gateway owner passphrase, and OAuth client/token state.
- Browser artifacts and local status/log files, which may reveal browsing context.

Keep the installed runtime private. Share the clean repository source, not a ZIP of an installation. Do not commit profiles, session snapshots, local setup links, tokens, passphrases, OAuth state, artifacts, or copied logs. Generated private state is not necessary to install on a friend's PC.

The Windows installer applies owner-only protected inheritance before creating private state. Do not loosen those ACLs or move the installation to a shared/public folder. A process already running as your Windows user remains within your local trust boundary.

## Remote boundary

Expose only the OAuth gateway on port 8934. Never tunnel the unauthenticated local MCP port, setup dashboard, or Chrome debugging port. The tunnel provider carries remote requests; review its privacy terms and your use case.

The gateway is single-owner: a successful consent grants access to the same entire dedicated browser profile, not one website card. It uses public-client DCR, authorization-code S256 PKCE, exact redirect allowlisting, one-use expiring codes, hashed token records, resource/scope checks, and refresh rotation/revocation. The owner passphrase is entered on its consent page, never in a chat prompt.

Remote tools omit server-process code execution, local upload/drop tools, and caller-selected artifact filenames. Page-context evaluation and normal browser actions remain available. This limits direct local-file/process access through the remote browser tool surface; it does not turn arbitrary website content into trusted instructions.

## Revocation and troubleshooting

Disconnect the private plugin in ChatGPT to stop using that connection. Stop Background Browser to halt the local stack and suppress recovery. If credentials or browser data were exposed, stopping the server alone does not revoke a website session: use the affected provider's account/session controls and replace the affected local secret before reconnecting.

Avoid sharing complete logs or status folders for support. Prefer a short description, component name, timestamp, and sanitized error code. Redact account content and private setup links from screenshots.
