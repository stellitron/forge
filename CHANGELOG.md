# Changelog

All notable changes to Forge are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

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
