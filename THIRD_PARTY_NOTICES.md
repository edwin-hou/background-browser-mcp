# Third-party components

This repository contains original integration code under the MIT license. The
installer downloads the pinned dependencies declared in `runtime/package.json`
and `runtime/package-lock.json`; their upstream licenses still apply.

| Component | License | Upstream |
| --- | --- | --- |
| Playwright MCP | Apache-2.0 | https://github.com/microsoft/playwright-mcp |
| Playwright | Apache-2.0 | https://github.com/microsoft/playwright |
| Model Context Protocol TypeScript SDK | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| Express | MIT | https://github.com/expressjs/express |

Google Chrome, Node.js, .NET Framework and optional ngrok are separately installed
prerequisites, not bundled browser sessions or redistributable binaries in this
repository. See their own licenses and terms. In particular, ngrok Free has usage
limits; this project does not guarantee unlimited or permanently free hosting.
