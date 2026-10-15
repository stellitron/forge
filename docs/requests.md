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
