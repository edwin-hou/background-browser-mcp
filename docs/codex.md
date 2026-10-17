# Connect Codex locally

Start the installed browser first. In your client's MCP settings, add a **Streamable HTTP** server named `playwright_background` with this URL:

```text
http://127.0.0.1:8933/mcp
```

You can instead merge this entry into your existing `%USERPROFILE%\.codex\config.toml`. Preserve its other settings and existing server entries:

```toml
[mcp_servers.playwright_background]
url = "http://127.0.0.1:8933/mcp"
startup_timeout_sec = 30
tool_timeout_sec = 120
disabled_tools = ["browser_run_code_unsafe", "browser_file_upload", "browser_drop"]
```

The disabled tools prevent server-process code execution and local file upload through this connection. Page-context evaluation remains available for normal browser work. Loopback MCP is intended for trusted local clients; it does not require the remote gateway's OAuth.

Restart or reload the client's MCP connection, then confirm that browser tools are actually available in the conversation you will use. A config entry alone is not proof of a working connection. The [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) describes configuration, server policy, and client-specific reload steps.

## Verify it

Ask the model to list browser tabs, navigate a task-owned tab to `https://example.com`, and read an inline `browser_snapshot`. After signing into your chosen website through setup, ask it to verify the requested authenticated page. Do not claim account access from a service health response.

Call `browser_snapshot` after navigation or clicks when their result contains a local artifact path. A remote client cannot read the PC's artifact files. Leave screenshot filenames unset to receive inline images.

Codex and optional ChatGPT access share one profile. Run one browser workflow at a time and preserve unrelated tabs.

## Make it the account-browsing default

Copy [account-browser-instructions.md](account-browser-instructions.md) into your own agent instructions, or use the [local plugin skill](../plugin/README.md). This changes tool-selection guidance; it does not enable a connection in another chat automatically.

ChatGPT web does not read your local Codex config. For that surface, use the [separate remote connection](chatgpt.md).
