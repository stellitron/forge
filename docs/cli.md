# Command-line runner

`forge` runs the requests in a workspace and checks their tests, the same way the app's runner does. Use it in CI to test your API on every pull request, or from a terminal.

It uses the same request building, auth (including OAuth 2.0 client credentials, AWS Signature v4, Digest, Hawk and JWT), client certificates, tests and captured values as the desktop app, so a request that passes in the app passes in CI. It never changes files in the workspace.

## Install

You need Node.js 20 or newer. Download `forge.mjs` from the [latest release](https://github.com/stellitron/forge/releases/latest):

```bash
curl -fsSL https://github.com/stellitron/forge/releases/latest/download/forge.mjs -o forge.mjs
node forge.mjs --help
```

From a clone of this repository, `npm run cli:build` creates `dist-cli/forge.mjs`.

## Run

```bash
node forge.mjs run                          # everything in the workspace
node forge.mjs run Shop --env staging       # one collection, with an environment
node forge.mjs run "Shop/Users/List users"  # one request
node forge.mjs list                         # what's there
```

Paths are relative to `collections/` and match a collection, a folder or a single request. Requests run in file order, like the app's runner, and values captured by one request are available to the next. To control the order, prefix file names with numbers, such as `1 Login` and `2 List orders`.

Forge finds the workspace by looking for a `collections/` folder from the current directory upwards. Use `--workspace <dir>` to point elsewhere.

## Variables and secrets

Shared values come from the environment you pick with `--env`. Secrets usually aren't in the repository, so pass them in:

- `--var key=value`, repeatable
- environment variables named `FORGE_VAR_<key>`, which suits CI secret stores

These override the environment's values. If `<env>.local.json` exists next to the environment, its secrets are used too.

Every secret value, and any captured value whose name looks like a credential (token, key, password and similar), is shown as `***` in all output and reports.

For OAuth 2.0, the client credentials and password grants fetch a token automatically. The authorization code grant needs a browser, so in CI pass a token instead, for example `FORGE_VAR_token`.

## Options

| Option | |
| --- | --- |
| `-e, --env <name>` | Environment by name or file name |
| `--var <key=value>` | Set or override a variable |
| `-n, --iterations <n>` | Run everything n times |
| `-d, --data <file>` | Run once per row of a CSV, JSON or YAML file; columns become variables |
| `-r, --reporter <name>` | `cli` (default), `junit` or `json` |
| `-o, --output <file>` | Write the junit or json report to a file |
| `--bail` | Stop at the first failed request |
| `--timeout <ms>` | Override every request's timeout |
| `--delay <ms>` | Wait between requests |
| `-k, --insecure` | Skip TLS certificate checks |
| `--no-color` | Plain output (also when `NO_COLOR` is set) |

Exit codes: `0` when every request passes its checks, `1` when any fails or errors, `2` for usage errors such as an unknown environment.

## Data-driven runs

With `--data`, each row is one run of the selected requests, and each column becomes a variable. Tests can use the same variables, for example a JSONPath check that `$.sku` equals `{{sku}}`.

```csv
sku,quantity
A-1,2
B-7,1
```

## GitHub Actions

```yaml
name: API tests
on: [pull_request]

jobs:
  api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - name: Get Forge
        run: curl -fsSL https://github.com/stellitron/forge/releases/latest/download/forge.mjs -o forge.mjs
      - name: Run API tests
        run: node forge.mjs run --env staging --reporter junit --output forge-results.xml
        env:
          FORGE_VAR_apiKey: ${{ secrets.STAGING_API_KEY }}
      - name: Keep the report
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: forge-results
          path: forge-results.xml
```

The JUnit report also works with GitLab, Jenkins, Azure Pipelines and most test dashboards.
