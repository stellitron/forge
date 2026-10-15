# Security policy

Forge handles API tokens and talks to many services, so we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Instead, use one of these private channels:

- GitHub: the **Report a vulnerability** button on the [Security tab](https://github.com/stellitron/forge/security/advisories/new).
- Email: **contact@stellitron.com** with "Forge security" in the subject.

Include the Forge version, your OS, what an attacker could do, and steps to reproduce. A proof of concept helps, but please do not access data that is not yours.

## What to expect

- We confirm receipt within 3 working days.
- We share an assessment and planned fix date within 10 working days.
- We credit you in the release notes, unless you prefer not to be named.
- We ask that you keep the issue private until a fixed version is released.

## Supported versions

Security fixes go into the latest release, which reaches users through the built-in updater. Please reproduce on the latest version before reporting.

## In scope

- Leaking environment secrets, API keys or tokens (to logs, files that are committed, AI providers or other hosts).
- Bypassing the approval prompts for AI-built requests or for the local MCP and A2A server.
- Accessing the local server without its token, or from another website.
- Installing an update that was not signed by Stellitron.
- Code execution through imported files, responses or workspace content.

## Out of scope

- Requests that you send yourself to a server you chose.
- Issues that need an already compromised computer or account.
- Missing hardening with no clear way to exploit it.

How Forge protects secrets is described in [docs/security.md](docs/security.md).
