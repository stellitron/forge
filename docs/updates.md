# Updates

Forge updates itself over the air. You stay in control of when.

## For users

- Forge checks for a new version a few seconds after launch and every six hours.
- When one is available, an **Update** pill appears in the title bar and in **Settings, Updates**, with the release notes.
- Choose **Install**. When the download finishes, choose **Restart now**. Your workspace and settings are kept.
- Turn off **Check automatically** to only check when you press **Check now**.

The check downloads a small `latest.json` file from GitHub releases. It contains the version, release notes and download links. No information about you or your workspace is sent beyond what any web request includes, such as your IP address.

## How updates stay safe

1. Every release is built by GitHub Actions from a tagged commit.
2. The build signs each update bundle with Stellitron's private update key. CI reads it from a secret of the protected `release` environment, and maintainers keep an offline backup. It is never committed.
3. The app contains the matching public key (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`).
4. Before installing, Forge verifies the signature. A bundle that wasn't signed with Stellitron's key is rejected.

Installers can also be signed with Apple and Microsoft certificates, so the operating system trusts them on first install. That signing is being set up: v0.1.0 isn't signed this way, and the release notes say which installers of a release are. See [Releasing](releasing.md#signing-setup) for the current setup. Every release is scanned on VirusTotal (the results are in the release notes and on the website), and includes `SHA256SUMS` and GitHub build provenance, so you can check that a download was built by Forge's release workflow from this repository.

## For maintainers

- The update feed is `https://github.com/stellitron/forge/releases/latest/download/latest.json`, created by the release workflow.
- Users only see a release once it is published. Draft and pre-release builds are not offered.
- To pause a bad release, mark it as a draft or pre-release on GitHub. The previous release becomes the latest again.
- Never lose the private key. Without it, existing installs can't verify new updates and users would have to reinstall by hand. Keep an offline backup.

### Protecting the key

- The private key is never in the repository. The `.gitignore` blocks `*.key`, `*.p12`, `*.pem` and similar files as a safety net.
- In CI it is an environment secret of the protected `release` environment. Only an approved run of the release workflow on a `v*` tag can read it. Pull requests, including from forks, never see it.
- Actions in the release workflow are pinned to exact commits, so a changed third-party action can't read the key.
- It has a strong password, stored separately from the key file.

### If the key leaks

Updates can only be replaced by someone who holds the key, so act before an attacker does:

1. Generate a new key pair.
2. Release a new version signed with the **old** key whose `tauri.conf.json` contains the **new** public key. Installed copies accept it and from then on trust only the new key.
3. Replace the GitHub secrets with the new key, and destroy every copy of the old one.
4. Publish a security advisory explaining which versions to update from.

### If the key is lost

Installed copies can't verify anything signed with a new key. Publish a release signed with the new key, and tell users on the website and release page to download it once by hand. Updates work normally after that.

See [Releasing](releasing.md) for the full process, including key setup.
