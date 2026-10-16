# Releasing

Releases are built by GitHub Actions when a version tag is pushed. Update bundles are always signed; macOS and Windows installers are signed once their certificates are set up (see [Signing setup](#signing-setup)). Publishing the draft release makes it available to every installed copy through the updater.

## Checklist

### Before

- [ ] `main` is green in CI.
- [ ] Changes are listed under **Unreleased** in `CHANGELOG.md`.
- [ ] Docs and screenshots match the new behaviour (`npm run screenshots` if the UI changed).
- [ ] You tested the main flows in a production build (`npm run package`): send a request, run a folder, import, export, Ask, settings, onboarding.

### Version

- [ ] Pick the version with [Semantic Versioning](https://semver.org): patch for fixes, minor for features, major for breaking file format or behaviour changes.
- [ ] `npm run version:set X.Y.Z`
- [ ] In `CHANGELOG.md`, rename **Unreleased** to `X.Y.Z` with the date, and add a new empty **Unreleased** section.
- [ ] `npm run check`
- [ ] Commit: `git commit -am "Release X.Y.Z"`

### Build

- [ ] `git tag vX.Y.Z && git push origin main vX.Y.Z`
- [ ] Watch the **Release** workflow. It builds macOS (Apple silicon and Intel), Windows and Linux, signs the update bundles (and the installers whose certificates are set up), scans the installers on VirusTotal, and creates a **draft** release with `latest.json`.

### Verify the draft

- [ ] Every platform has its installer and its `.sig` file.
- [ ] `latest.json` lists every platform with the new version.
- [ ] Download and open the macOS build. It opens without a security warning.
- [ ] Read the **VirusTotal** section of the draft notes. If the VirusTotal job failed, an engine flagged a file: open its report before you publish (see [VirusTotal scan](#virustotal-scan)). Publishing puts the result on the website and the README badge.
- [ ] Add the changelog section to the release notes, above the VirusTotal section; keep that section. The updater shows these notes to users.

### Publish

- [ ] Publish the release. Installed copies will see it within six hours, or at their next launch.
- [ ] Update an older install through **Settings, Updates** to confirm the update path works.
- [ ] Announce it if it matters to users.

## If something goes wrong

- **Bad release already published:** mark it as a pre-release or draft. The previous release becomes the latest again for the updater. Then ship a fixed patch version. Never reuse a version number.
- **Workflow failed:** fix the cause on `main`, delete the tag (`git push --delete origin vX.Y.Z` and `git tag -d vX.Y.Z`), and tag again.
- **Signing key lost:** existing installs can't accept updates signed with a new key. Publish a release that explains how to reinstall, then use the new key from then on.

## Signing setup

Releases read their signing secrets from a protected GitHub environment named `release`. Only an approved run of the release workflow on a `v*` tag can use them.

### Update signing (required)

Every update is signed so installed copies only accept releases from Stellitron.

```bash
npx tauri signer generate -w ~/.tauri/forge-updater.key
```

Use a strong password, put the `.pub` contents in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, and back up the key and its password separately. If the key is lost, installed copies can't update again. Add to the `release` environment:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the contents of the private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |

### macOS signing and notarization

Without it the app is built unsigned, and macOS blocks it until the user allows it in System Settings. With the Apple Developer Program:

1. **Create the certificate.** In Xcode, open **Settings, Accounts**, select the team, then **Manage Certificates**, then **+**, then **Developer ID Application**. Without Xcode, create a certificate signing request in Keychain Access and upload it under **Certificates** at developer.apple.com.
2. **Export it.** In Keychain Access, find "Developer ID Application: …", right-click it, choose **Export**, and save it as `.p12` with a strong password. Export the certificate together with its private key.
3. **Create a notarization key** (recommended). At App Store Connect, open **Users and Access, Integrations, App Store Connect API**, then add a **Team Key** with the Developer role. Download the `.p8` file, which can be downloaded only once. Note the Key ID and the Issuer ID.
4. **Add the secrets** to the `release` environment, for example `gh secret set APPLE_CERTIFICATE --env release < <(base64 -i certificate.p12)`:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | `base64 -i certificate.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | the certificate's name, for example `Developer ID Application: Stellitron Technologies Private Limited (TEAMID)`. `security find-identity -v -p codesigning` prints it |
| `APPLE_API_ISSUER` | the Issuer ID |
| `APPLE_API_KEY` | the Key ID |
| `APPLE_API_PRIVATE_KEY` | the contents of the `.p8` file |

Instead of the API key, notarization can use an Apple ID: set `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password from account.apple.com) and `APPLE_TEAM_ID`.

The workflow signs and notarizes when `APPLE_CERTIFICATE` is set, and fails early if the certificate is there but notarization credentials aren't. To check a build: `codesign --verify --deep --strict --verbose=2 Forge.app` and `spctl -a -vv Forge.app`, which should say "accepted, source=Notarized Developer ID".

### Windows signing (optional)

Unsigned installers show a SmartScreen warning. The options:

- **SignPath Foundation**: free code signing for open-source projects (<https://signpath.org>). The certificate is issued to SignPath Foundation, with the project named in the signature. Applications are reviewed against their criteria.
- **Azure Trusted Signing**: a monthly fee, signs under Stellitron's name, and has eligibility rules for the organization.
- **An OV certificate** from a certificate authority, used through the authority's cloud signing service, since the key can't be exported.

All of these plug into `bundle.windows.signCommand`. See <https://tauri.app/distribute/sign/windows/>. A signature includes a timestamp, so installers signed while a certificate was valid stay valid after it expires.

### VirusTotal scan

Each release's installers (`.dmg`, `.exe`, `.msi`, `.AppImage`, `.deb`, `.rpm` and `forge.mjs`) are scanned on VirusTotal while the release is still a draft. The results go into the release notes, with a link to each file's report, and into `virustotal.json` on the release. When you publish the release, the site workflow puts that file on forge.stellitron.com: the Download section and the README badge show the results.

1. Create a free account at virustotal.com and copy the API key from your profile.
2. Add it to the `release` environment: `gh secret set VT_API_KEY --env release`.

Without the key, the scan is skipped and the release carries on as before.

- The free API allows 4 requests a minute. The scan waits between calls, so a release takes about 10 to 15 minutes longer. Files VirusTotal has already seen aren't uploaded again.
- Uploaded files are shared with VirusTotal's security partners. That's fine for public installers; don't point the script at anything private.
- VirusTotal's terms limit the free API to non-commercial use. Scanning Forge's own free releases fits that. A paid key is a drop-in replacement.
- If engines flag a file, the VirusTotal job fails (after attaching the results) so it can't be missed, and the notes show it. Unsigned installers sometimes get false positives from smaller engines. Look at the report, report a false positive to that vendor, and decide before publishing. The site and badge show whatever the published results say.

### Checksums and provenance

Every release gets `SHA256SUMS` and a GitHub build provenance attestation for each file. No secrets are needed. Check a file with `gh attestation verify <file> -R stellitron/forge`.
