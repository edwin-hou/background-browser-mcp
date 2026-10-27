# Connect Codex locally

Start the installed browser first. Merge the generated **codex-config.example.toml** from the installation folder into your existing `%USERPROFILE%\.codex\config.toml`. Preserve other settings and replace the existing browser server section rather than creating a second one. The generated paths are specific to your installation. Its shape is:

```toml
[mcp_servers.playwright_background]
command = "C:/Program Files/nodejs/node.exe"
args = ["C:/Users/YourName/.background-browser/gateway/local-bridge.mjs"]
startup_timeout_sec = 90
tool_timeout_sec = 120
disabled_tools = ["browser_run_code_unsafe", "browser_file_upload", "browser_drop"]
```

Use the generated file instead of copying these placeholder paths unchanged. The local bridge uses stdio and needs neither the optional remote gateway nor OAuth. It reconnects to the loopback browser service if that service restarts. It checks a cached session before dispatch and retries only explicit read-only operations. It never automatically repeats a possibly completed click, submission, evaluation, or other write; verify the outcome if an error says completion is unknown.

The disabled tools prevent server-process code execution and local file upload through this connection. Page-context evaluation remains available for normal browser work.

For clients that only support HTTP, the original `http://127.0.0.1:8933/mcp` endpoint remains available. A direct HTTP client may need to reinitialize its MCP session after a browser-service restart. Do not combine `url` with `command`/`args` in the same server section.

Restart or reload the client's MCP connection, then confirm that browser tools are actually available in the conversation you will use. A config entry alone is not proof of a working connection. The [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) describes configuration, server policy, and client-specific reload steps.

## Verify it

Ask the model to list browser tabs, navigate a task-owned tab to `https://example.com`, and read an inline `browser_snapshot`. After signing into your chosen website through setup, ask it to verify the requested authenticated page. Do not claim account access from a service health response.

Call `browser_snapshot` after navigation or clicks when their result contains a local artifact path. A remote client cannot read the PC's artifact files. Leave screenshot filenames unset to receive inline images.

Codex and optional ChatGPT access share one profile. Run one browser workflow at a time and preserve unrelated tabs.

## Make it the account-browsing default

Copy [account-browser-instructions.md](account-browser-instructions.md) into your own agent instructions, or use the [local plugin skill](../plugin/README.md). This changes tool-selection guidance; it does not enable a connection in another chat automatically.

ChatGPT web does not read your local Codex config. For that surface, use the [separate remote connection](chatgpt.md).
