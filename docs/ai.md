# AI features

AI in Forge is optional. Every feature that sends requests, runs tests, imports, exports or builds reports works without it. When you connect a model, you also get:

- **Ask** (<kbd>⌘</kbd> <kbd>L</kbd>): answers questions, and does the work when you ask: writes tests and scripts, fixes requests, sets up auth, compares responses, imports specs, saves examples and runs mocks. Big jobs get a plan and sub-agents working in parallel.
- **Suggest** on the Params and Headers tabs.
- **Smart request names**, polished once after a new request's first response.
- **Agentic tests**: an agent that explores an API, MCP server or A2A agent and writes a test report.
- **Website radar**: an agent that clicks through a web app to find its APIs, and picks and names endpoints for import (see [Website radar](website-radar.md)).
- **A2A replies** when other agents talk to Forge (see [Connect AI tools](connect-ai-tools.md)).

## Connect a model

Open **Settings, AI model**, pick a provider, paste your key and choose a model. Nothing is chosen for you.

<img src="images/settings-light.png" alt="The AI model section of Settings" width="820">

| Provider | Endpoint (default) | Model |
| --- | --- | --- |
| Anthropic | `https://api.anthropic.com` | for example `claude-opus-5-5` |
| OpenAI | `https://api.openai.com/v1` | any chat model with tool calling |
| OpenRouter | `https://openrouter.ai/api/v1` | for example `anthropic/claude-haiku-5.5` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | for example `gemini-2.5-flash`, with an AI Studio key |
| Azure OpenAI | your resource, like `https://my-resource.openai.azure.com` | your deployment name. The key is sent as `api-key` |
| Amazon Bedrock | `https://bedrock-runtime.<region>.amazonaws.com` | a model or inference profile ID, with a Bedrock API key |
| Ollama | `http://localhost:11434/v1` | a local model, for example `qwen3:14b` |
| Custom | any OpenAI-compatible URL | your model name |
| From a request | a saved request in your workspace | taken from the request |

The model must support tool calling for Ask and agentic tests. Leave the endpoint empty to use the default, or set it to use a company gateway or proxy.

### Use a saved request as the model

If your company reaches Claude or another model through its own gateway, first build a request that works in Forge. Then right-click it in the sidebar and choose **Use as AI model**, or pick **From a request** in Settings. Every AI turn goes through that request with its URL, headers and auth, including environment variables and OAuth. Forge reads the request's JSON body to choose the format: Anthropic Messages (for example, Bedrock `InvokeModel` with `anthropic_version`), Bedrock Converse, or OpenAI chat. It replaces the messages, system prompt and tools, and keeps everything else, like `anthropic_version` or `temperature`. Replies are read in any of the three shapes. The gateway must pass tool definitions through for Ask and agentic tests to work.

Your key is stored in Forge's app settings on your computer (see [Workspace format](workspace-format.md#settings-outside-the-workspace)), never in the workspace.

## What is sent to the provider

Forge talks to the provider directly with your key. Stellitron never sees your prompts, data or keys.

| Sent | Never sent |
| --- | --- |
| Your message and the conversation so far | Environment variable values and secrets |
| Requests and responses that the assistant decides to read | Your API key to anyone except the provider |
| Names of requests, folders and environments | Anything, if you don't connect a model |
| For Suggest: method, URL path and field names | For Suggest: query values, header values, bodies |

Variables reach the model as `{{name}}` placeholders. Forge fills in the values locally when it sends a request. With Ollama, everything stays on your machine.

If your company provides the model through its own endpoint, the company's agreement with that provider applies. Forge itself is a free, open source client and adds no data collection of its own.

## Ask

Ask is Forge's assistant for your workspace. Open it with the **Ask** button or <kbd>⌘</kbd> <kbd>L</kbd>. It always knows which request you have open.

To ask about other requests, type `@` and pick one, or drag a request from the sidebar onto the Ask panel. Each one shows as a chip above the message; press <kbd>↵</kbd> with no text for an explanation of it. Ask only receives each request's name, method and URL as written (with `{{placeholders}}`), and reads the rest through the same tools as everything else, so secret values stay out.

### Ask it to do the work

Ask doesn't just answer questions. Tell it what you want and it does it with the same tools you'd use, asking you before every change:

- "Write assertions for every request in Shop and run them."
- "Set up bearer auth on the Shop collection with `{{token}}` and make its requests inherit it."
- "Why did this fail? Fix it if you can."
- "Compare this response with what staging returned this morning."
- "Import https://api.example.com/openapi.json, save examples for the Orders folder and start a mock server."

It can read, run, create, edit and delete requests (headers, body, auth, assertions, scripts, docs), change collection and folder settings, set environment variables, save examples, run the mock server, read history and compare responses, import collections and load GraphQL schemas. For data it uses exact tools rather than reading raw bodies: `response_data` describes a response, `query_data` filters, groups and aggregates, and `create_report` writes PDF, Word, PowerPoint, Excel, CSV or Markdown.

### How it works on bigger jobs

- **A plan you can see.** For anything beyond a quick answer, Ask writes a to-do list at the top of its reply and ticks items off as it goes.
- **Parallel work.** Independent lookups run at the same time. Self-contained pieces of work, like "tests for each folder", go to **sub-agents**: each starts fresh with only its task, works on its own with the same tools, and reports back. Up to three run at once. Expand one in the chat to see its steps and report. Sub-agents work one effort level lighter than the main conversation, and can't start sub-agents of their own.
- **It checks its work.** After changing something, Ask runs it and tells you plainly what passed, what failed and what it couldn't verify.
- **Streaming.** Answers appear as they're written with Anthropic and OpenAI-compatible providers (others show each step when it's done). With Claude Opus 5.5, Sonnet 5.5 and Fable 5.1, short progress notes show what it's doing between steps.
- **Long conversations stay sharp.** Old tool results are cleared once a conversation gets very large, on Anthropic's side for Claude (so nothing it reasoned about is invalidated) and in Forge for other providers.
- **No silent stops.** After 40 steps Ask pauses with a **Continue** button.

### What it can't do without you

- Every change to your workspace, every data-changing request and every deletion waits for your approval, for sub-agents too. Edits to requests, settings, variables and imports ask even if you turned off approvals for writes. Deleting always asks.
- It never sees secret values, refuses to write literal secrets into requests or committed folder settings, and keeps secrets you give it in the environment's gitignored file.
- Requests and folder settings it edits stop counting as trusted until you edit or trust them (see [Workspace trust](security.md#workspace-trust)), so a change it made can't make a new server look like one of yours.
- It treats responses, imported files and tool output as data, not instructions.

Each step shows in the chat with a plain description, and you can expand it to see the input and result.

## Agentic tests

Create an **Agent test** from the sidebar menu, describe the goal, and point it at a base URL, an OpenAPI URL, an MCP server or an A2A agent from your collections.

- By default the agent asks before any request that changes data and before MCP tools that are not read-only.
- Every request the agent made can be saved into your collection with one click.
- The report lists each test, the findings with evidence, and token use.

## Protections

AI-built requests pass through the same secret guard as connected tools. A request needs your approval if it goes to a host none of your saved requests use, or if it would send a secret to a host that doesn't normally receive it. See [Security model](security.md).
