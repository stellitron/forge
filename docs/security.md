# Security model

Forge holds API tokens and can be driven by AI, so it is designed to keep secrets local and make risky actions visible. To report a problem, see [SECURITY.md](../SECURITY.md).

## Secrets

- **Two files per environment.** Shared values go in `name.json`, which you commit. Secrets go in `name.local.json`, which Forge adds to `.gitignore`.
- **Imports split credentials.** When importing environments, values that look like credentials (by name such as `token` or `password`, by shape such as JWTs or long random keys, or marked secret by the source tool) go to the local file.
- **Captured values are secrets.** Values captured from responses, such as login tokens, are written to the local file.
- **Typed tokens are flagged.** A literal token in the Auth tab shows a warning and a one-click move into secrets.
- **The console masks credentials** until you choose to reveal them.
- **AI keys stay in app settings,** outside every workspace, in a file only your user can read.

## AI and connected tools

- Models and connected tools see `{{placeholders}}`, never variable values. Forge fills values in only when it sends the request.
- **Secret guard.** A request built by an AI (Ask, an agent test or a connected tool) needs your approval when:
  - it goes to a host that none of your saved requests or environments use, or
  - it carries a secret to a host where your saved requests don't send that secret.

  The prompt shows placeholders, never values. It can't be turned off or skipped with "always allow", and unanswered prompts expire as a denial.
- **Writes need approval.** Changing requests or calling APIs that modify data asks first, unless you turn that off.
- **Rendered answers are inert.** Markdown in AI answers never loads images or raw HTML, so a manipulated answer can't leak data through an image URL. Links open only for `http` and `https`.

## The local server

- Listens on `127.0.0.1` only.
- Every call needs a random bearer token, which you can regenerate.
- Requests with a browser `Origin` from other sites are rejected.

## Network

- Requests go directly from your computer to the server you chose.
- TLS uses rustls with your system's trusted certificates. Certificate checks can be turned off per request for local test servers.
- Forge follows your system proxy settings.
- Forge has no telemetry or analytics. The only call it makes on its own is the update check, described in [Updates](updates.md), which you can turn off.

## Updates

Updates are signed by Stellitron. The app has the public key built in and refuses any update whose signature doesn't match, even if the download server were compromised.
