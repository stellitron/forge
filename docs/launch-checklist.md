# Launch checklist

One-time setup to publish Forge as an open source project with a website and signed over-the-air updates. Work top to bottom. Items marked **(you)** need an account owner and can't be automated.

## 1. Confirm names and contacts

- [x] GitHub organization: `github.com/stellitron`, repository `forge`. All links, the update feed and the website point there. To use a different repository name later, replace it everywhere:

  ```bash
  grep -rl "stellitron/forge" --exclude-dir=node_modules --exclude-dir=target . | xargs sed -i '' 's#stellitron/forge#stellitron/NEW-NAME#g'
  ```

- [ ] **(you)** Confirm `contact@stellitron.com` for security reports and the Code of Conduct (`SECURITY.md`, `CODE_OF_CONDUCT.md`, `package.json`).
- [ ] Confirm the license (Apache 2.0, copyright Stellitron) and the trademark note in `NOTICE`.

## 2. Create the repository

- [ ] **(you)** Create the public repository on GitHub, without a README or license (the project already has them).
- [ ] Push the code:

  ```bash
  git add -A
  git commit -m "Initial public release"
  git branch -M main
  git remote add origin https://github.com/stellitron/forge.git
  git push -u origin main
  ```

- [ ] In **Settings, General**: set the description ("Local-first API, MCP, A2A and agentic testing client"), website `https://forge.stellitron.com`, and topics such as `api-client`, `rest`, `graphql`, `mcp`, `a2a`, `tauri`, `developer-tools`.
- [ ] In **Settings, Code security**: turn on private vulnerability reporting, Dependabot alerts, secret scanning and push protection.
- [ ] In **Settings, Branches**: protect `main`, require a pull request and the **CI** check.
- [ ] In **Settings, Actions, General**: allow GitHub Actions, and set workflow permissions to "Read and write" (the release workflow creates releases).
- [ ] Create the labels `good first issue` and `help wanted`.

## 3. Update signing key

A key pair was generated on the development machine:

- Private key: `~/.tauri/forge-updater.key` (never commit it)
- Public key: `~/.tauri/forge-updater.key.pub`, already in `src-tauri/tauri.conf.json`

- [ ] **(you)** Create a fresh key with a strong password before the first public release. The current one has an empty password, so anyone who copies the file could sign updates:

  ```bash
  npx tauri signer generate -w ~/.tauri/forge-updater.key --force
  ```

  Then copy the new `.pub` content into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
- [ ] **(you)** Back up the private key file and its password in two places, for example your company password manager and an encrypted offline drive. Store the password separately from the file. If the key is lost, installed copies can never update again.
- [ ] **(you)** In **Settings, Environments**, create an environment named `release`. Add yourself (and one other maintainer) as required reviewers, and limit it to tags matching `v*`. The release workflow can only read its secrets after an approval.
- [ ] **(you)** Add these as **environment secrets** of `release`, not repository secrets:

  | Secret | Value |
  | --- | --- |
  | `TAURI_SIGNING_PRIVATE_KEY` | the full contents of `~/.tauri/forge-updater.key` |
  | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password (leave empty only if it has none) |

## 4. macOS signing and notarization

Without this, macOS warns that Forge is from an unidentified developer.

- [ ] **(you)** Join the Apple Developer Program as Stellitron.
- [ ] **(you)** Create a **Developer ID Application** certificate, export it as a `.p12` with a password.
- [ ] **(you)** Create an app-specific password for the Apple ID used for notarization.
- [ ] Add these as environment secrets of `release`:

  | Secret | Value |
  | --- | --- |
  | `APPLE_CERTIFICATE` | `base64 -i certificate.p12 \| pbcopy` |
  | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
  | `APPLE_SIGNING_IDENTITY` | for example `Developer ID Application: Stellitron (TEAMID)` |
  | `APPLE_ID` | the Apple ID email |
  | `APPLE_PASSWORD` | the app-specific password |
  | `APPLE_TEAM_ID` | your 10-character team ID |

The release workflow uses them automatically when present.

## 5. Windows signing (recommended)

Unsigned installers trigger a SmartScreen warning until they build reputation.

- [ ] **(you)** Get a code signing option: Azure Trusted Signing (lowest cost), or an OV or EV certificate from a certificate authority.
- [ ] Add the signing step described in the Tauri guide: <https://tauri.app/distribute/sign/windows/>.

## 6. Website at forge.stellitron.com

The site in `site/` deploys to GitHub Pages through `.github/workflows/site.yml`.

- [ ] In **Settings, Pages**, set the source to **GitHub Actions**.
- [ ] **(you)** In the DNS for `stellitron.com`, add a `CNAME` record: `forge` pointing to `stellitron.github.io` (use the GitHub account or org that owns the repository).
- [ ] **(you)** In the GitHub organization settings, verify the `stellitron.com` domain for Pages. This prevents anyone else from claiming the subdomain.
- [ ] After the first deploy, set the custom domain to `forge.stellitron.com` in **Settings, Pages** and turn on **Enforce HTTPS**.
- [ ] **(you)** Link to Forge from <https://stellitron.com>.

## 7. First release

- [ ] Follow [Releasing](releasing.md) for version `0.1.0`.
- [ ] Install `0.1.0` on a clean machine, then release `0.1.1` with a small change and confirm the in-app update works end to end.
- [ ] Check the download buttons on the website pick up the new release.

## 8. Before announcing

- [ ] **(you)** Rotate any API keys used during development, including the OpenRouter key used for testing. They are only in the local app settings, not the repository, but rotating is good hygiene.
- [ ] Scan the history for secrets: `npx gitleaks detect` or GitHub secret scanning results.
- [ ] Remove leftover development files that aren't meant to be public (for example an old `screenshots/` folder).
- [ ] Read the README and website once more on a phone and a desktop.
