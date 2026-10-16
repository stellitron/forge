# Editing requests

<img src="images/request-light.png" alt="A request with its response in the light theme" width="900">

## URL and params

The URL bar and the **Params** table are two views of the same query string. Type `?page=1&limit=20` in the URL or add rows in the table, and the other updates.

- Turn a row off with its checkbox to keep it without sending it.
- Write `/:id` in the path to get a **Path variables** table. The values are encoded when sent, so `a/b c` becomes `a%2Fb%20c`.

### Special characters

The table shows readable values. In the URL, Forge encodes only what would break the query.

| You type in the table | URL shows | Server receives |
| --- | --- | --- |
| `rock & roll #1` | `rock%20%26%20roll%20%231` | `rock & roll #1` |
| key `a=b` | `a%3Db` | key `a=b` |
| `100%` | `100%25` | `100%` |
| `+05:30` | `+05:30` | usually ` 05:30` (see below) |

Most servers read a `+` in a query as a space. Forge sends the `+` you typed as it is, because some APIs depend on that, and shows a warning with a one-click change to `%2B` for a literal plus.

Values from `{{variables}}` are always fully encoded, so a token like `ab+c/d==` arrives exactly as stored. A variable used on its own, like `?{{query}}`, is inserted as is, for variables that hold a whole query string.

## Headers

- Common header names and values autocomplete as you type.
- Quick chips add frequent headers such as `Accept: application/json` or `X-Request-ID: {{$uuid}}`.
- **Auto** rows show the headers Forge adds for you: `Authorization` from the Auth tab, `Content-Type` from the Body tab, `User-Agent` and `Accept-Encoding`. Add your own row with the same name to replace one.

## Bulk edit

Every table has **Bulk edit**, which turns it into text with one `key: value` per line. Start a line with `//` to turn it off. You can paste a block of headers copied from browser dev tools, or a query string like `a=1&b=2`.

## Suggest

With an AI model connected, **Suggest** proposes likely params or headers as a checklist with a reason for each. Nothing is added until you tick items and choose **Add**. Only the method, URL path and field names are sent, never values.

## Auth

Choose a type in the Auth tab. A preview shows what will be sent, and every secret field warns you if you type a real value instead of a `{{variable}}`, with one click to move it into the environment's secrets.

| Type | What Forge does |
| --- | --- |
| Bearer token | Sends `Authorization: Bearer <token>`. |
| Basic | Sends the username and password, base64-encoded. |
| API key | Sends a key as a header or a query parameter. |
| OAuth 2.0 | Gets a token, stores it as a secret, and refreshes it before it expires. See below. |
| AWS Signature v4 | Signs every request with your access keys, region and service. Works with API Gateway, S3, Lambda URLs and other AWS APIs. |
| Digest | Answers the server's `401` challenge with a hashed password (MD5, MD5-sess or SHA-256). |
| Hawk | Signs the method, URL and time with a shared key. |
| JWT | Creates and signs a new token for each request (HS256/384/512, RS256/384/512, ES256/384). `iat` and `exp` are added unless you set them. |

### OAuth 2.0

1. Pick a grant type:
   - **Authorization code**, for signing in as a person. Forge opens your browser, you sign in, and the provider sends you back to a loopback address such as `http://127.0.0.1:8765/callback` that Forge listens on only while you sign in. Register that exact URL with your provider. PKCE is on by default.
   - **Client credentials**, for app-to-app access. Forge fetches a token automatically when you send.
   - **Password**, for older APIs that still use it.
2. Fill in the token URL, client ID and scope. Keep the client secret in a `{{variable}}`.
3. Choose **Sign in** or **Get new token**. The token is stored in the active environment's secrets as `{{token}}` (change the name with **Store token as**), together with its refresh token and expiry.

Requests that use the same token name share one token. When it is about to expire, Forge refreshes it before sending; if a server rejects it early, Forge refreshes once and retries.

### Client certificates (mutual TLS)

Some servers ask the client for a certificate during the TLS handshake. In the request's **Settings** tab, set the certificate and private key files (PEM, unencrypted key), and a CA certificate if the server uses a private CA. This works together with any auth type.

To convert a `.p12` or `.pfx` file: `openssl pkcs12 -in client.p12 -out client.pem -nodes`.

### Not supported

NTLM and Kerberos need to talk to the operating system's sign-in services and aren't supported. If your company API uses them, a gateway that accepts tokens or client certificates usually works instead.

## Body

The Body tab label shows the current type, such as **Body · JSON**. Supported types are JSON, text, XML, form URL-encoded, multipart (with files), GraphQL and a raw file.

## Variables

Write `{{name}}` anywhere: URL, params, headers, auth and body. Values come from the active environment, with secrets overriding shared values of the same name. Built-in variables:

| Variable | Value |
| --- | --- |
| `{{$uuid}}` | A random UUID |
| `{{$timestamp}}` | Unix time in seconds |
| `{{$isoTimestamp}}` | ISO 8601 time |
| `{{$randomInt}}` | A number from 0 to 999 |
| `{{$randomEmail}}` | A random email address |

Hover a variable to see where its value comes from. Secret values are never shown.

## Tests and captured values

The **Tests** tab holds assertions on status, headers, JSONPath, body text, response time and size. **Suggest from response** creates sensible ones from the last response.

Captures copy a value from a response into a variable, for example a login token from `$.access_token`. Captured values are stored as secrets of the active environment.

## Scripts

For anything assertions and captures can't do, the **Scripts** tab runs JavaScript before the request is sent (**Pre-request**) and after the response arrives (**Post-response**). The snippet buttons add common steps.

```js
// Post-response
pm.test("Status is 200", () => pm.response.to.have.status(200));
const data = pm.response.json();
pm.expect(data.items.length).to.be.above(0);
pm.environment.set("orderId", data.items[0].id);
```

Scripts from Postman, Bruno and Insomnia run as they are, and they come along when you import:

| API | What it gives you |
| --- | --- |
| `pm` (Postman), `insomnia` | `pm.test`, `pm.expect`, `pm.response` (`code`, `json()`, `text()`, `headers`, `responseTime`, `to.have.status`…), `pm.request` (change the URL, method, headers or body before sending), `pm.environment` / `pm.variables` / `pm.collectionVariables` / `pm.globals`, `pm.info` |
| Bruno | `bru.getEnvVar` / `setEnvVar` / `getVar` / `setVar`, `req` (`getUrl`, `setHeader`, `setBody`…), `res` (`status`, `body`, `getHeader`…), `test`, `expect` |
| Both | Chai-style `expect`: `equal`, `eql`, `deep`, `not`, `include`, `property`, `lengthOf`, `above`, `below`, `a`/`an`, `match`, `oneOf`, `keys`, `members`, `ok`, `exist`, `empty`… |

- Tests from scripts show next to assertions in the response's **Tests** tab, in the folder runner and in the CLI.
- `console.log` goes to the Console, and to the terminal in the CLI.
- If a pre-request script throws an error, the request isn't sent.
- Forge has one variable scope, the active environment, so every `pm.*` variable store reads and writes it. Like captured values, variables a script sets are saved in the environment's gitignored local file.
- Collection- and folder-level scripts from Postman and Bruno are combined into each request's script, in the order those tools run them.

Scripts run sandboxed, in a background worker in the app and an isolated context in the CLI. They have no network, file or module access. A script that runs longer than 5 seconds is stopped.

A script can still change where its request goes, or set a variable like `{{baseUrl}}` that later requests use. So Forge asks before:

- sending a request that a pre-request script moved to a host none of your saved requests use,
- sending a secret that a pre-request script attached to a host where your saved requests don't send it (for example, your API's `{{token}}` on a request to another site),
- saving a variable that would point your requests at a new host.

"Your saved requests" means requests you trust. See [Workspace trust](security.md#workspace-trust).

Everyday scripts, like setting an `Authorization` header from a token you captured or signing a request, don't trigger these prompts. An approval lasts until Forge restarts. The CLI can't ask, so it blocks these changes unless you pass `--trust-scripts`.

### Sending requests from scripts

`pm.sendRequest` works in both of its forms, with a callback or with `await`, for example to fetch a fresh token before each request. Bruno's `await bru.sendRequest({ url, method, headers, data })` works too.

```js
pm.sendRequest({
  url: pm.environment.get("baseUrl") + "/oauth/token",
  method: "POST",
  body: { mode: "urlencoded", urlencoded: [{ key: "grant_type", value: "client_credentials" }] },
}, (err, res) => pm.environment.set("token", res.json().access_token));
```

The script doesn't send anything itself. Forge sends the request for it, with the same checks as above. A host none of your trusted requests use, or a secret going somewhere it isn't normally sent, needs your OK first. Time spent waiting for the response doesn't count toward the 5-second script limit.

`require()` and Postman's built-in libraries (lodash, CryptoJS, moment) aren't available.

In the CLI, scripts run in a separate worker thread with an empty environment and no network access. A runaway script is stopped without hanging the job, and CI secrets in environment variables can't be reached from scripts.

## Folder and collection settings

Right-click a folder and choose **Folder settings** (or **Collection settings** for a top-level folder) to set what everything inside it shares:

- **Auth.** Requests set to **Inherit from folder** (the default for new requests) use the nearest folder's auth. Sign in once on the collection instead of in every request. The request's Auth tab shows where its auth comes from.
- **Headers.** Added to every request inside. A request's own header with the same name wins. Inherited headers show in the request's Headers tab.
- **Variables.** Like Postman's collection variables, these are shared with the collection and committed. The active environment overrides them, so keep secrets in environments.
- **Scripts.** Run before each request's own scripts, outermost folder first. Each level runs separately, so they can use the same variable names.

Settings live in each folder's `_folder.json` (see [Workspace format](workspace-format.md)). Imports from Postman and Bruno bring collection and folder auth and scripts across as folder settings.

## Examples

Save a response with the bookmark button in the response bar. Examples are kept in the request file, with known secret values stored as `{{placeholders}}` and cookies dropped. Manage them at the bottom of the request's **Docs** tab, where you can rename them, edit status, type and body, or make one the default.

Examples appear in generated docs and in OpenAPI and Postman exports, and the AI sees them when it reads a request. Postman saved responses and OpenAPI response examples come in on import. Each request's default example is what the [mock server](#mock-server) returns.

## Mock server

Right-click a folder and choose **Mock server**, then **Start**. Forge serves the saved examples of every request in the folder on `127.0.0.1`, for example `http://127.0.0.1:4010`. A frontend can then be built before the backend exists. Routes follow the request URLs: `{{baseUrl}}/users/:id` answers `GET /users/42`. Routes update as you edit requests and examples.

- **Point `{{baseUrl}}` here** creates a "Mock" environment and switches to it.
- Choose a response per call with `Prefer: example=Name` or `Prefer: code=404`, or add `?__example=Name` to the URL. Otherwise each request returns its first example.
- A request without examples answers `501` with a hint. An unknown route answers `404` listing the routes there are.
- Only this computer can connect, and browsers only get answers for pages served from `localhost`, `127.0.0.1` or `[::1]`, plus origins you allow in the panel. Any website open in your browser runs on your computer too, and examples can contain real data, so other origins are refused. Stop the mock when you're done.

## History

Every request you send is kept in the sidebar's **History** view (the clock button), newest first. Open an entry to see the exact request and response, **Send again** with today's variable values, or **Save as request**. History is kept per workspace on this computer only, never in the workspace. Secret values are stored as their `{{placeholders}}`, and credentials typed directly into headers are hidden. It keeps the last 300 sends. Turn it off or clear it in **Settings**.

## Compare responses

The **Compare** tab of a response shows what changed since an earlier response to the same request. Pick any earlier send, for example one made with the staging environment, to compare staging with production. JSON responses list each change by path (`$.items[0].price: 10 → 12`); other responses show a line diff. Headers that change on every response, like `Date` or request IDs, are left out unless you include them.

## Cookies

Cookies servers set are sent back automatically, like in a browser, and all requests share them. Each environment has its own cookie jar, so a staging login doesn't follow you to production. Open **Cookies** from Settings, from <kbd>⌘</kbd> <kbd>K</kbd>, or from the cookie button on a response that set one, to see, edit, add or delete them. Jars are kept on this computer between sessions, never in the workspace. Turn that off in **Settings** to keep them only until Forge closes.

## GraphQL

In a GraphQL request, **Load schema** sends an introspection query to the endpoint, with the request's auth and headers. With the schema loaded, the query editor suggests fields and arguments as you type (or press <kbd>Ctrl</kbd> <kbd>Space</kbd>) and underlines mistakes. Every request to the same endpoint shares the schema until Forge closes. If the server has introspection turned off, Forge says so.

## Data and reports

<img src="images/data-dark.png" alt="The Data tab showing a response as a table" width="900">

JSON responses get a **Data** tab. Forge works out the structure itself, without AI. Lists become tables, nested objects become columns, and child lists become linked tables. You can search, sort and choose columns.

**Export** creates PDF, Word, PowerPoint (with charts), Excel, CSV or Markdown files in the workspace `reports/` folder, or anywhere with **Save as**. The numbers come straight from the data.

## Code

**Code** turns the request into cURL, fetch, axios, Python, Go, Java, C#, PHP, Ruby, Rust, HTTPie or PowerShell. Variables stay as `{{placeholders}}` unless you choose to fill them in.

## API documentation

Right-click a collection or folder and choose **Generate docs…** to create documentation from your requests:

- **Web page**: one HTML file with a searchable list of endpoints, light and dark themes, and copy buttons. Share it or host it anywhere.
- **Markdown**: one `.md` file for a repository or wiki.

For each endpoint the docs show the method and path, parameters (path, query and headers), auth, the request body with its fields, the response from your last run with a field table, your tests as checked behaviour, and code samples in the languages you pick.

Everything above comes from the requests themselves, with no AI involved. Tokens, keys and passwords are always hidden in examples and code samples, and `{{placeholders}}` stay as they are.

Response examples come from your last run, which may have been against real data. Choose how they appear:

| Option | What you get |
| --- | --- |
| **Sample values** (default) | Names, emails, phone numbers, addresses, locations, dates of birth, IP addresses and ID numbers become fake values like `user@example.com`. Field names, types and other values stay real. |
| **Real values** | Only secrets are hidden. Use this for internal docs, or after running against test data. |
| **Leave out** | No response examples. |

OpenAPI export always uses sample values for its response examples.

### Descriptions

Each request has a **Docs** tab for a Markdown description of what it does. Descriptions appear in the generated docs and travel with Postman and OpenAPI export.

If some requests have no description, **Draft with AI** writes them for you to review. The model sees only names and types (routes, parameter names, field names and types, test names), never example values or response data. Nothing is saved until you accept a draft, and accepted text goes into the request's Docs tab where you can edit it.

## Export

Right-click a collection or folder and choose **Export…**:

- **Postman collection (v2.1)**: folders, requests, auth settings and bodies. Forge tests become Postman test scripts, and captured values become `pm.environment.set` calls. Postman, Insomnia, Bruno and Hoppscotch can all import it.
- **OpenAPI 3.0** (YAML or JSON): paths with path, query and header parameters, request bodies, auth schemes and example responses from your last run, with secrets hidden and personal data replaced by sample values.

MCP servers, A2A agents, WebSockets, web checks and agent tests have no equivalent in these formats and are left out. Secrets stay as `{{variables}}`.

To export an environment, open **Environments** and choose **Export**. It is saved as a Postman environment, and secret values are left empty unless you choose to include them.

You can also export a single response from the **Data** tab, or turn one request into code with **Code**.
