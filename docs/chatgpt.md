# Optional ChatGPT connection

Complete the local browser setup first. This route exposes only the authenticated gateway through your own ngrok domain. It does not expose the raw local browser MCP or Chrome debugging port.

No OpenAI API key or paid model API is used. Your ChatGPT account still needs access to custom MCP plugins, and workspace security policy can restrict it. This project does not provide or guarantee that access. Check the current [official custom MCP setup guide](https://developers.openai.com/api/docs/guides/custom-mcp-server).

## Prepare your own free tunnel

1. Create your own account at [ngrok](https://ngrok.com/) and use its assigned free development domain. Do not reuse another installation's domain or authtoken.
2. Download the official Windows `ngrok.exe` and put it in `ngrok\ngrok.exe` under your installed Background Browser folder. The installer does not download or redistribute it.
3. Open your private setup shortcut. In its ChatGPT connection section, enter your ngrok authtoken and assigned HTTPS domain locally. The domain is an origin such as `https://your-assigned-name.ngrok-free.app`, without `/mcp`.
4. Save and let the dashboard start the gateway and tunnel. Keep the linked domain stable after connecting ChatGPT; changing it requires a deliberate reconnect.

As checked on 2026-10-17, ngrok's free plan includes one assigned development domain, with 1 GB monthly outgoing transfer and 20,000 monthly HTTP requests. Limits and terms can change, and a limit can stop remote access. Check [ngrok's current limits](https://ngrok.com/docs/pricing-limits/free-plan-limits); no paid upgrade is required by this project.

## Add your MCP in ChatGPT web

Use **ChatGPT in a web browser** to create the connection. If the desktop dialog does not show its create button, finish this step on the website with the same account.

1. Open ChatGPT's **Plugins**, choose **+ → Add custom MCP server**, and name your connection.
2. Use the public MCP URL shown in your local dashboard. Its shape is `https://your-assigned-name.ngrok-free.app/mcp`.
3. Select **OAuth**. Choose **Dynamic Client Registration (DCR)** if registration options are shown. Leave static client ID/secret empty and CIMD disabled. Review the risk acknowledgement, then create the plugin.
4. Install your resulting private plugin. Complete its OAuth consent using the owner passphrase displayed in your private dashboard, entered only on your own gateway's HTTPS authorization page.
5. Open a new chat, select your installed plugin with `@`, and verify a harmless browser operation. Then verify a website session you saved yourself.

The [official guide](https://developers.openai.com/api/docs/guides/custom-mcp-server) documents this web flow, installation, and per-chat plugin selection. Publishing this GitHub source does not install a connection in anyone's ChatGPT account.

## OAuth details when advanced fields are shown

Discovery should fill these automatically. Replace the example origin with your domain everywhere:

| Field | Value |
| --- | --- |
| Server/resource URL | `https://your-assigned-name.ngrok-free.app/mcp` |
| Issuer | `https://your-assigned-name.ngrok-free.app/` |
| Authorization endpoint | `https://your-assigned-name.ngrok-free.app/authorize` |
| Token endpoint | `https://your-assigned-name.ngrok-free.app/token` |
| Registration endpoint | `https://your-assigned-name.ngrok-free.app/register` |
| Token endpoint client authentication | `none` (public OAuth client) |
| Scope | `browser:control` |
| Registration | DCR; no predefined client secret |
| OpenID Connect/CIMD | Disabled |

The gateway implements authorization code with S256 PKCE, resource binding, refresh rotation, and issuer-bound redirects. Its default stable ChatGPT callback is `https://chatgpt.com/connector_platform_oauth_redirect`. If your connection presents a different exact `https://chatgpt.com/connector/oauth/...` callback, the dashboard accepts that optional exact callback too. Do not broaden redirect matching. These behaviors follow the project's gateway implementation and OpenAI's [authentication guidance](https://developers.openai.com/plugins/build/auth).

The owner passphrase grants browser-control consent for this installation. It is not a website password and does not sign you into websites. DCR needs no OAuth client secret. Do not switch to **No authentication** to bypass a failed connection; the gateway intentionally requires authentication for MCP access.

## Verify the whole connection

A running tunnel process does not prove ChatGPT can use it. Confirm the plugin appears in the intended chat, browser tools are available, and a real tool call succeeds. Call `browser_snapshot` after navigation to get inline state. The PC, browser manager, gateway, tunnel, and internet connection must remain available; website logins can still expire.
