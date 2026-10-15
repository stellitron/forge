# How Forge works

Forge is a [Tauri 2](https://tauri.app) desktop app. A React interface runs in the system web view, and a Rust core does the networking, file access and local server. Both run on your computer.

```
┌─────────────────────────── Forge ───────────────────────────┐
│ React UI (src/)                                             │
│   panels, editors, Data tab, Ask, onboarding, settings      │
│   zustand store: workspace items, environments, settings    │
│   agent loop and tools (src/agent/)                         │
│             │  Tauri commands (src/lib/ipc.ts)              │
│             ▼                                               │
│ Rust core (src-tauri/src/)                                  │
│   http.rs    reqwest with rustls, cookies, proxy, timing    │
│   mcp.rs     MCP client: stdio, Streamable HTTP, SSE        │
│   ws.rs      WebSocket client                               │
│   store.rs   workspace files, settings, exports             │
│   server.rs  local MCP and A2A server (axum, 127.0.0.1)     │
└─────────────────────────────────────────────────────────────┘
```

## Sending a request

1. You edit a request. The store saves it to its JSON file about 300 ms after you stop typing.
2. On **Send**, `buildRequest` in `src/lib/request.ts` resolves the request:
   - fills `:path` variables and encodes them,
   - resolves `{{variables}}` from the active environment, with secrets overriding shared values,
   - encodes query parameters so special characters keep their meaning (see [Editing requests](requests.md#special-characters)),
   - adds auth and the `Content-Type` that matches the body.
3. The resolved request goes to the Rust `http_send` command, which sends it with reqwest and returns status, headers, body, size and timing.
4. The UI runs assertions and captures in `src/lib/eval.ts`, stores captured values as secrets, and shows the result.
5. The console (`src/lib/devconsole.ts`) records every exchange with credentials masked.

## Workspaces

`store.rs` reads the whole workspace folder at open and writes single files on change. Paths are checked so writes can't leave the workspace. See [Workspace format](workspace-format.md).

## Response data

`src/lib/shape.ts` analyses JSON without AI: it finds lists of records, flattens nested objects into columns, links child lists to parents and computes column types and statistics. `src/lib/report.ts` turns that into PDF, Word, PowerPoint, Excel, CSV or Markdown. The heavy libraries load only when you export.

## AI

- `src/agent/llm.ts` has one session interface over Anthropic, OpenAI-compatible APIs (OpenAI, OpenRouter, Gemini, Azure, Ollama, custom) and the Bedrock Converse API.
- `src/agent/assistant.ts` is Ask. `src/agent/runner.ts` runs agentic tests.
- `src/agent/workspaceTools.ts` defines the tools both use, and that the local MCP server exposes.
- `src/agent/egress.ts` is the secret guard. Every AI-built request passes through it before it is sent.

## The local server

When enabled, `server.rs` serves MCP at `/mcp` and A2A at `/a2a` on `127.0.0.1`. It checks the bearer token and origin, then forwards each call to the UI, which runs the tool and asks for approval when needed (`src/lib/forgeServer.ts`, `src/lib/approvals.ts`).

## Updates

`src/lib/updates.ts` uses the Tauri updater plugin. It checks the GitHub release feed, and installs only bundles whose signature matches the public key in `tauri.conf.json`. See [Updates](updates.md).

## Appearance

`src/lib/theme.ts` sets `data-theme` and `data-palette` on the page. All colours are CSS variables in `src/styles.css`, so every component follows the theme. Dark mode uses true black.
