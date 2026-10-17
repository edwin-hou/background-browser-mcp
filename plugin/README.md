# Optional local plugin source

This generic plugin connects to a browser already installed on **your own Windows PC** at `http://127.0.0.1:8933/mcp` and provides account-browsing instructions. It contains no registered app ID, personal account binding, remote domain, or credentials.

The simplest Codex setup is the [direct MCP configuration](../docs/codex.md). Use either that route or this plugin route; avoid attaching duplicate connections to the same browser unnecessarily.

## Files and installation

- `plugin.json`: portable Agent Plugins manifest.
- `mcp.json`: portable local HTTP MCP definition.
- `.codex-plugin/plugin.json` and `.mcp.json`: compatibility files for hosts that use the older Codex layout.
- `skills/background-browser/SKILL.md`: account-browsing guidance.

Install through your host's supported local plugin or local marketplace flow. This repository does not register a marketplace, upload a plugin to your account, or publish a directory listing. If your host expects a standalone plugin archive, package the **contents of this `plugin/` folder** with its hidden files included; do not archive the complete repository as a plugin.

Start the browser separately, reload the installed plugin, and verify tool discovery and a harmless browser call in the intended chat. Importing a template is not proof that its server is reachable. Apply the same local tool policy described in the direct MCP guide, including disabling unsafe server execution and local upload/drop tools where your host supports a deny list.

## ChatGPT web

This local endpoint is not reachable from hosted ChatGPT. Follow [ChatGPT setup](../docs/chatgpt.md) to create your own OAuth-backed connection. The [remote MCP example](../docs/examples/chatgpt-mcp.example.json) is an endpoint template only: replace its example domain with your verified endpoint and configure **OAuth with DCR** through ChatGPT's connection UI. It contains no credentials or predefined OAuth client. Never upload a local-only package and assume it grants remote browser access.

The source template is not a store submission and has not been installed in a friend's account as part of exporting it.
