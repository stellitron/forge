# Connect AI tools

Forge can run a small local server so other AI tools can list, read and run the requests in your workspace. It speaks MCP (Model Context Protocol) and A2A (Agent2Agent).

## Turn it on

Open **Settings, Connect AI tools** and enable the server. Forge then listens on `127.0.0.1:7878` (you can change the port) and shows a token. Every call must include that token, and requests from websites are refused.

The settings page has copy-ready setup for Claude Code, Claude Desktop, VS Code with GitHub Copilot, Cursor, Windsurf, Gemini CLI and A2A clients.

Forge must be running for the tools to reach it.

## MCP

Endpoint: `http://127.0.0.1:7878/mcp` (Streamable HTTP), with `Authorization: Bearer <token>`.

For example, in Claude Code:

```bash
claude mcp add --transport http forge http://127.0.0.1:7878/mcp --header "Authorization: Bearer <token>"
```

Tools offered:

| Tool | What it does |
| --- | --- |
| `list_requests`, `get_request` | Browse saved requests |
| `run_request`, `run_folder` | Run saved requests and their tests |
| `http_request` | Send a one-off request |
| `last_response`, `recent_traffic` | Read recent results |
| `list_environments` | Environment names, never values |
| `save_request` | Save a new request |
| `response_data`, `query_data`, `create_report` | Work with response data |
| `create_folder`, `organize` | Tidy up collections |

## A2A

- Agent card: `http://127.0.0.1:7878/.well-known/agent-card.json`
- JSON-RPC `message/send`: `http://127.0.0.1:7878/a2a`

Messages are answered by Ask with your configured model.

## Approvals

- Requests that change data, and saving new requests, show an approval in Forge. You can turn this off, or trust a client for the current session.
- Editing requests, changing collection or folder settings, setting variables, saving examples, importing and starting the mock server always ask, even with that turned off. Trust a client for the session to approve a batch of changes at once.
- Deleting always asks, and trusting a client doesn't skip it.
- The **secret guard** always applies and can't be skipped by trusting a client. It asks before an AI-built request goes to an unfamiliar host or sends a secret somewhere new. Unanswered prompts expire as a denial after nine minutes.
- Variable values are filled in inside Forge and never returned to the client.

## Cloud agents

Cloud tools such as Copilot Studio can't reach `127.0.0.1`. Expose Forge through a tunnel you control (cloudflared, ngrok or VS Code port forwarding), keep the token secret, and turn the tunnel off when you are done.
