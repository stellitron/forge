# Releasing

Releases are built and signed by GitHub Actions when a version tag is pushed. Publishing the draft release makes it available to every installed copy through the updater.

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
- [ ] Watch the **Release** workflow. It builds macOS (Apple silicon and Intel), Windows and Linux, signs everything, and creates a **draft** release with `latest.json`.

### Verify the draft

- [ ] Every platform has its installer and its `.sig` file.
- [ ] `latest.json` lists every platform with the new version.
- [ ] Download and open the macOS build. It opens without a security warning.
- [ ] Paste the changelog section into the release notes. The updater shows these notes to users.

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

### macOS signing (optional)

Without it the app is built unsigned and macOS warns that it's from an unidentified developer. With an Apple Developer account, export a Developer ID Application certificate as `.p12` and add:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | `base64 -i certificate.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | for example `Developer ID Application: Stellitron (TEAMID)` |
| `APPLE_ID` | the Apple ID used for notarization |
| `APPLE_PASSWORD` | an app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | the 10-character team ID |

The workflow signs and notarizes when `APPLE_CERTIFICATE` is set.

### Windows signing (optional)

Unsigned installers show a SmartScreen warning. Azure Trusted Signing or an OV/EV certificate removes it; see <https://tauri.app/distribute/sign/windows/>.
