# Contributing to Forge

Thanks for helping make Forge better. This guide covers how to report problems, propose changes and get a pull request merged.

## Ways to help

- **Report a bug.** Open an issue with the bug template. Include your OS, Forge version (Settings, About) and the smallest steps that reproduce it. Remove tokens and private URLs first.
- **Suggest a feature.** Open an issue with the feature template and describe the problem before the solution.
- **Improve the docs.** Typos, unclear steps and missing examples are all welcome fixes.
- **Write code.** Look for issues labelled `good first issue` or `help wanted`, or comment on an issue before starting something large so we can agree on the approach.

Security problems are the exception: never open a public issue for them. Follow [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 20 or newer, Rust 1.88 or newer and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/stellitron/forge.git
cd forge
npm install
npm run app
```

See [docs/development.md](docs/development.md) for the project layout, scripts and the browser preview.

## Making a change

1. Fork the repository and create a branch from `main`, named for the change, like `fix-cookie-reset` or `feat-grpc`.
2. Keep the change focused. One pull request should do one thing.
3. Add or update tests. TypeScript tests live in `src/lib/__tests__/`, Rust tests in `src-tauri/src/tests.rs`.
4. Run the checks locally:

   ```bash
   npm run check     # versions, types, tests, Rust tests and production build
   ```

5. Update the docs and `CHANGELOG.md` (under **Unreleased**) when behaviour changes.
6. Open a pull request and fill in the template. CI must pass before review.

## Code style

- Match the code around you: naming, comment density and structure.
- TypeScript is strict. Avoid `any` unless you are parsing unknown JSON.
- Keep secrets out of logs, error messages, AI prompts and files that are committed. When in doubt, ask in the pull request.
- New UI should work in light, dark and system themes and with keyboard only.

## Writing style

Docs and UI text use plain, short sentences.

- No em dashes. Use a period, comma, colon or parentheses instead.
- Say what something does, not how great it is.
- Use "you" for the reader and sentence case for headings and buttons.

## Commit messages

Use a short imperative subject, like `Fix cookie reset on workspace switch`. Add a body when the reason is not obvious.

## License of contributions

Forge is licensed under the Apache License 2.0. By submitting a contribution you agree that it is licensed under the same terms, as described in section 5 of the license. You keep the copyright to your work.

## Code of Conduct

Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
