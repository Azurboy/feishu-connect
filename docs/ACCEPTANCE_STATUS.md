# Feishu Connect 2A acceptance status

Updated 2026-09-30. The [specification](SPEC_v0.1.md) is the contract. Code that compiles is not counted as a working client integration.

| Area | Verified | Still required |
| --- | --- | --- |
| Reuse review | `open-feishu-mcp-server` source reviewed; broad write scopes, token-in-grant design and per-client revocation do not meet the 2A boundary without substantial changes | Record any later upstream change before reconsidering reuse |
| Read-only core | Fixed OpenAPI endpoints, signed user/client cursors, Docx text rendering, omission markers, revision checks; seven synthetic tests | Live Docx, Wiki, permission and pagination cases |
| OAuth framework | Cloudflare OAuth provider 1.2.1 and MCP SDK 1.30.0 compile; Wrangler dry-run succeeds | Feishu app, callback, two-user isolation, refresh, independent revoke, management page, live protocol conformance |
| Client compatibility | Official docs identify ChatGPT remote MCP, Manus custom MCP and Muse Connector Platform as possible paths | Real ChatGPT and Manus calls; Cue entry; Muse review/approval |
| Hosting | Cloudflare login available locally; private GitHub repo created | Cloudflare KV/config/secrets/deployment and three-network latency measurement |
| Operation | No document body or token logging in application code | 3–5 invited users, 8-day run, fault injection and log audit |

**Do not mark 2A complete or publish an open registration URL until the pending access-control and real-client acceptance checks pass.**
