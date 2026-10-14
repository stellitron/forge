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
