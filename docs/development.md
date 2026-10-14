# Development

## Requirements

- Node.js 20 or newer
- Rust 1.88 or newer (`rustup update`)
- Tauri prerequisites for your OS: <https://tauri.app/start/prerequisites/>

## Scripts

| Command | What it does |
| --- | --- |
| `npm install` | Install JavaScript dependencies |
| `npm run app` | Run the desktop app with hot reload |
| `npm run dev` | Browser preview with an in-memory demo workspace |
| `npm test` | TypeScript tests (Vitest) and Rust tests (cargo) |
| `npm run check` | Everything CI runs: versions, types, tests and a production build |
| `npm run package` | Build installers into `src-tauri/target/release/bundle` |
| `npm run icons` | Regenerate every app icon from `src-tauri/icons/source/` |
| `npm run screenshots` | Capture the docs and website screenshots (needs `npm run dev` and Chrome) |
| `npm run version:set 1.2.3` | Set the version in all three manifests |

## Browser preview

`npm run dev` serves the UI at <http://localhost:1420>. Outside the desktop shell it installs `src/preview.ts`, a mock backend with a demo workspace and fetch-based HTTP. MCP, WebSocket and stdio need the real app.

Preview options in the URL:

- `?tour=0` skips the first-run guide.
- `?theme=light` or `?theme=dark` picks a theme.

## Project layout

```
src/                      React UI
  App.tsx                 shell, title bar, tabs, welcome screen
  components/             shared UI: sidebar, tables, chat, onboarding
  panels/                 one panel per item kind, plus settings
  lib/                    store, request building, encoding, import, export, updates
  lib/__tests__/          Vitest tests
  agent/                  AI sessions, Ask, agent runner, tools, secret guard
src-tauri/                Rust core
  src/                    HTTP, MCP, WebSocket, file store, local server
  icons/source/           SVG sources for all icons
  tauri.conf.json         app, bundle and updater config
site/                     the forge.stellitron.com landing page
docs/                     this documentation
scripts/                  icons, screenshots and version tools
.github/                  CI, release and site workflows, templates
```

## Tests

- TypeScript: `src/lib/__tests__/*.test.ts`. Run one file with `npx vitest run src/lib/__tests__/urlParams.test.ts`.
- Rust: `src-tauri/src/tests.rs`, run with `cd src-tauri && cargo test`. They start small local servers, so no internet is needed.

Add a test with every bug fix that reproduces the bug first.

## Conventions

- Keep secrets out of logs, prompts, errors and committed files. New AI tools must go through `checkEgress` in `src/agent/egress.ts`.
- Use CSS variables from `src/styles.css` for colours so all themes work.
- Public links come from `src/lib/brand.ts`.
- Docs and UI text: short sentences, sentence case, no em dashes.
