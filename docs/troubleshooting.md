# Troubleshooting

| Symptom | Check |
| --- | --- |
| Bare dashboard URL says to use the private shortcut | Expected. Open the generated `Open browser setup.url`; do not paste its token into chat. |
| Dashboard or local MCP is unreachable | Start this installation with its Start shortcut. Inspect management Status. Confirm the PC is signed in and ports 8933–8936 are not occupied by another installation. |
| A website redirects to sign-in | Renew the session through that website's setup card, save it explicitly, and verify the authenticated page again. A green service status is not a website login. |
| A login window is already open | Finish that same window and save it before opening another. Do not open another process against the same profile. |
| MCP appears configured but no browser tools are available | Reload the connection/client and verify tool exposure in the exact chat. Local config does not enable a hosted ChatGPT plugin. |
| Navigation returns a local file path | Ask for `browser_snapshot` without a filename to get inline page state. |
| ChatGPT cannot create the plugin in the desktop dialog | Use ChatGPT on the web with the same account; check account/workspace access and the current official setup guide. |
| ChatGPT OAuth fails | Use your own stable domain, OAuth with DCR, public-client auth `none`, and scope `browser:control`. Verify exact callback/issuer values. Leave CIMD/OIDC off for this gateway. |
| Tunnel is running but ChatGPT tools fail | Check gateway health, ngrok account/domain and quotas, then complete real OAuth and a tool call. A process PID does not prove remote access. |
| Windows startup says a file cannot be found although it exists in an app | Check the actual physical path from outside that app. Reinstall into a fresh normal user-profile folder rather than an MSIX-virtualized location. |
| Explicit Stop immediately restarts | Use the project's Stop action rather than killing a browser child. Stop writes durable disabled policy before shutdown. |

Do not “fix” remote access by tunneling ports 8933, 8935, or 8936, disabling gateway authentication, copying cookies, or changing redirect allowlists to wildcards. Preserve your existing profile while diagnosing an issue.

If installation fails, report its sanitized error text and which step failed. Do not post the installation directory, private shortcut, browser artifacts, or raw OAuth/ngrok files as a support bundle.
