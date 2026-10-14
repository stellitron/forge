# Workspace format

A Forge workspace is an ordinary folder. Everything in it is plain JSON, so it diffs well, merges like code and works with any git host.

```
my-workspace/
  .gitignore                        Forge adds *.local.json here
  collections/
    Demo API/                       a collection is a top-level folder
      Users/                        folders nest as deep as you like
        list-users.json             one file per request
        create-user.json
      github-mcp.json               MCP servers, A2A agents, WebSockets,
      travel-agent.json             web checks and agent tests are files too
  environments/
    staging.json                    shared variables, commit this
    staging.local.json              secrets for staging, never committed
  reports/                          exports from the Data tab
```

## What to commit

| Commit | Keep out of git |
| --- | --- |
| `collections/**` | `environments/*.local.json` (Forge ignores these for you) |
| `environments/*.json` | `reports/` if exports contain private data |

Forge writes `*.local.json` into the workspace `.gitignore` when it opens the folder. If you place the workspace inside an existing repository, check that its own `.gitignore` doesn't override this.

## A request file

```json
{
  "forge": 1,
  "kind": "http",
  "name": "List users",
  "method": "GET",
  "url": "{{baseUrl}}/users?_limit=3",
  "params": [{ "key": "_limit", "value": "3", "enabled": true }],
  "pathVars": [],
  "headers": [],
  "auth": { "type": "bearer", "token": "{{token}}" },
  "bodyMode": "none",
  "body": "",
  "assertions": [{ "enabled": true, "source": "status", "path": "", "op": "eq", "value": "200" }],
  "extractions": [{ "enabled": true, "variable": "userId", "source": "jsonpath", "path": "$[0].id" }],
  "settings": { "timeoutMs": 30000, "followRedirects": true, "insecure": false }
}
```

- `forge` is the file format version.
- `kind` is one of `http`, `mcp`, `a2a`, `ws`, `web` or `agent`.
- `params` mirrors the URL query. Disabled params live only in this list.
- Fields Forge doesn't recognise are kept, so newer files open in older versions without losing data.

## An environment

`environments/staging.json`, shared:

```json
{
  "name": "Staging",
  "vars": [{ "key": "baseUrl", "value": "https://staging.example.com", "enabled": true }]
}
```

`environments/staging.local.json`, private:

```json
{
  "name": "Staging",
  "vars": [{ "key": "token", "value": "eyJhbGciOi...", "enabled": true }]
}
```

When both files define the same name, the local value wins.

## Working as a team

1. Put the workspace in a repository, or in a folder of your project repository.
2. Commit collections and shared environments.
3. Each person keeps their own `*.local.json` with their own tokens.
4. Review request changes in pull requests like any other code.

Forge saves every edit automatically about a third of a second after you stop typing. A dot on the tab shows a pending write.

## Settings outside the workspace

App settings, such as the theme, the AI provider and its API key, are stored per user, not in the workspace:

| System | Location |
| --- | --- |
| macOS | `~/Library/Application Support/com.stellitron.forge/settings.json` |
| Windows | `%APPDATA%\com.stellitron.forge\settings.json` |
| Linux | `~/.config/com.stellitron.forge/settings.json` |

The file is readable only by your user account.
