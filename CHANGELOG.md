# Changelog

All notable changes to Forge are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## 0.2.1 (2026-10-16)

### Changed

- Ask is rebuilt as an agent that does the work you ask for: it plans with a visible to-do list, runs independent lookups in parallel, hands self-contained work to up to three sub-agents at once, checks its changes by running them, and pauses with Continue instead of stopping. Answers stream as they're written. New tools let it edit requests (headers, body, auth, assertions, scripts), change folder settings, set variables, save examples, run the mock server, read history, compare responses, import collections and load GraphQL schemas, each after your approval.
- Requests and folder settings Ask edits stop counting as trusted until you edit or trust them, and the AI request guard now checks every request that isn't trusted.
- Editing requests, settings, variables and imports always asks, for Ask and for connected AI apps, even with "approve writes" turned off. That switch now covers only data-changing requests and saving new ones.
- Long Ask conversations clear old tool results (on Anthropic's side for Claude) so they stay within the model's context.

### Fixed

- Website radar on Windows: a radar browser left open from an earlier run is closed before a new launch, and when the browser can't connect the message says why. That covers a browser that closed straight away, a company policy that turns off remote debugging (`RemoteDebuggingAllowed` or `DeveloperToolsAvailability`), and a blocked local connection, instead of the same generic error every time. macOS reports the policy too.

## 0.2.0 (2026-10-16)

### Added

- Request history: every send, kept per workspace on this computer with secrets stored as placeholders. Open, send again or save as a request.
- Compare responses: what changed since an earlier response to the same request, by JSON path or line, for example staging against production.
- Folder and collection settings: auth, headers, variables and scripts that everything inside inherits. Postman and Bruno folder settings import as folder settings.
- Quick open (⌘K): jump to any request, folder, environment, recent send or action.
- Saved examples: keep responses with a request, used in docs, exports and AI context. Imported from Postman saved responses and OpenAPI examples.
- Mock server: serves a folder's examples on 127.0.0.1 for frontend work, answering local pages only.
- Cookie manager: one shared jar per environment, kept between sessions, which you can view and edit.
- `pm.sendRequest` and `bru.sendRequest` in scripts, checked like AI-built requests.
- GraphQL schema loading with completion and error checking as you type.
- Pre-request and post-response scripts. Postman (`pm`), Bruno (`bru`, `req`, `res`) and Insomnia scripts run unchanged and are kept on import and on Postman export. Scripts run sandboxed, with no network or file access, in under a millisecond, and the CLI runs them too. Forge asks before a script redirects a request, attaches a secret to a new host, or points a variable at a new host. The CLI blocks these unless run with `--trust-scripts`. Workspace trust: Forge asks once whether you trust a workspace, and remembers trusted content by fingerprint in its own settings, outside the workspace. Imports, AI-saved requests and anything changed outside Forge, for example by a git pull, don't vouch for their hosts until you trust them.
- Website radar: log into a web app in a separate browser, capture the APIs it calls, optionally let an AI agent explore it (changes blocked by default), then pick endpoints, by hand or with AI, and import them with the session's credentials.

### Changed

- Releases are scanned on VirusTotal, with the results in the release notes, on the website and in a README badge, alongside `SHA256SUMS` and GitHub build provenance.
- New requests inherit their folder's auth.
- The CLI runs scripts in a worker thread with no environment or network access, so a runaway script can't hang a CI job.

## 0.1.0 (2026-10-14)

First public release.

### Added

- HTTP and GraphQL requests with environments, variables, assertions, captured values and a folder runner.
- Params kept in sync with the URL, path variables, bulk edit, header autocomplete and suggestions, and safe encoding of special characters.
- Data tab with tables and exports to PDF, Word, PowerPoint, Excel, CSV and Markdown.
- MCP client over stdio, Streamable HTTP and SSE. A2A client. WebSocket client. Website checks.
- Import from Postman, Insomnia, Bruno, OpenAPI, Swagger, HAR and cURL. Code generation for 12 languages.
- Ask assistant and agentic testing with Anthropic, OpenAI, OpenRouter, Gemini, Azure OpenAI, Amazon Bedrock, Ollama and any OpenAI-compatible server.
- Local MCP and A2A server so other AI tools can run saved requests, with approvals and a secret guard.
- Light, dark (true black) and system themes with five accent palettes.
- First-run guide, redesigned settings and signed over-the-air updates.
- OAuth 2.0 with the authorization code (PKCE), client credentials and password grants. Tokens are stored as environment secrets and refreshed automatically.
- AWS Signature v4, HTTP Digest, Hawk and JWT auth.
- Client certificates for mutual TLS, with an optional private CA.
- Export collections and folders to Postman v2.1 (tests become Postman scripts) or OpenAPI 3.0, and environments to Postman.
- Importing Postman, Insomnia, Bruno and OpenAPI files now keeps OAuth 2.0, Digest, AWS, Hawk and JWT settings.
- Reveal collections, folders and requests in Finder, Explorer or the Linux file manager.
- Generate API docs for a collection as a web page or Markdown, from the requests, their last responses and their tests. Secrets are always hidden, and personal data in response examples is replaced with sample values unless you choose real values.
- A Docs tab on each request for a Markdown description, with optional AI drafts that are only saved after review.
- Descriptions are kept when exporting to and importing from Postman and OpenAPI.
- A command-line runner, `forge run`, for CI and terminals. It uses the app's request, auth and test code, takes secrets from `--var` or `FORGE_VAR_*`, runs data files, writes JUnit or JSON reports, masks secrets in all output and never changes the workspace. `forge.mjs` is attached to each release.
- Tests can use `{{variables}}` in their expected values and paths.
- Header, model and MCP method fields suggest values in a themed list with hints.
- Ask about any saved request by typing `@` or dragging it from the sidebar into Ask.
- A summary before and after importing: what was imported and anything to check, with a shortcut to write docs for it.
- Drop Postman, OpenAPI, Bruno, HAR or cURL files or folders anywhere on the window to import them.
