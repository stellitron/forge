# Security model

Forge holds API tokens and can be driven by AI, so it is designed to keep secrets local and make risky actions visible. To report a problem, see [SECURITY.md](../SECURITY.md).

## Secrets

- **Two files per environment.** Shared values go in `name.json`, which you commit. Secrets go in `name.local.json`, which Forge adds to `.gitignore`.
- **Imports split credentials.** When importing environments, values that look like credentials (by name such as `token` or `password`, by shape such as JWTs or long random keys, or marked secret by the source tool) go to the local file.
- **Captured values are secrets.** Values captured from responses, such as login tokens, are written to the local file. So are variables set by scripts.
- **Scripts are sandboxed and watched.** Request scripts run with no network, file or module access. A script can still edit its request or set variables, so Forge asks before a script sends a request to a new host, attaches a secret to a host that doesn't normally receive it, or points a variable like `{{baseUrl}}` somewhere new. The CLI blocks these unless run with `--trust-scripts`.
- **Collections don't vouch for themselves.** See Workspace trust below.
- **History and cookies stay on this computer.** Both are kept in Forge's private app-data folder, never in the workspace. History stores secret values as their `{{placeholders}}` and hides credentials typed directly into headers.
- **Folder settings take part in trust.** A request is only trusted if the settings of the folders above it are too, so a changed `_folder.json` (for example a new `{{baseUrl}}` from a git pull) can't redirect trusted requests.
- **The mock server only answers local pages.** It listens on `127.0.0.1`, checks the Host header, and refuses browser requests from origins other than `localhost` and the ones you allow, because any website open in your browser runs on your computer too.
- **Scripts send requests through Forge.** `pm.sendRequest` is checked like an AI-built request: new hosts and secrets going somewhere new need your OK.

## Workspace trust

Some checks ask whether a host is one of yours: the script guard, and the guard on AI-built requests. A host counts as yours when a request or environment you **trust** uses it. Otherwise any collection could make its own server look trusted, just by including a request to it.

- **The first time you open a workspace** Forge didn't create, it asks whether you trust its authors. Choose **Not now** for repos you don't control.
- **Trust follows content, not files.** Forge remembers a fingerprint of each trusted request's URL, headers, auth, body and scripts in its own settings, outside the workspace. A collection can't trust itself through its files, by arriving through git, or by changing after you trusted it.
- **Changes from outside Forge aren't trusted** until you look at them, for example requests that are new or changed after a `git pull`. The sidebar shows how many there are, with **Trust all**.
- **Imported requests, and requests the AI saves, start out untrusted.**
- **To trust:** edit the request, or use **Trust** on the request's notice, on the import summary, on a folder (**Trust requests in this folder**) or in the sidebar. Renaming, moving and AI-written descriptions don't change trust.
- **Trust only decides what Forge asks about.** Untrusted requests still work. You're just asked first before a script or the AI sends something to a host that only untrusted requests use.
- **The CLI trusts the repo it runs**, as any test runner does. Don't run `forge` with secrets on code you don't trust, such as pull requests from forks.
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
