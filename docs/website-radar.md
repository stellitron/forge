# Website radar

Website radar builds a collection from a web app you can log into, even when it has no API docs. Forge opens the site in a separate browser and records every API call the app makes while you use it. It groups the calls into endpoints, and you choose which ones to import as requests.

## Capture an app

1. In the sidebar menu choose **New, Website radar** and enter the site's URL.
2. Click **Open browser**. Forge starts Chrome, Edge, Brave or Chromium (the first one it finds, or the one you pick) with its own profile.
3. Log in as you normally would. Password managers, SSO and two-factor login work because it's a real browser. The radar profile remembers the login next time.
4. Use the app: open pages, search, filter, open dialogs. Calls from other tabs, popups and workers are captured too.

The **Endpoints** list fills as you go. Calls are grouped by method and URL, with ids replaced by path variables (`/users/42` becomes `/users/:userId`). GraphQL operations are listed one by one. Calls to other sites and analytics or monitoring calls are hidden and left unselected. Turn on **Third-party & tracking** to see them. Click an endpoint to see a sample request and response.

## Explore with AI

With a model connected (see [AI features](ai.md)), click **Explore** after logging in. The agent clicks through the app in the radar browser to find endpoints you haven't triggered yet. Add a focus, like "the billing pages", to point it somewhere.

- It stays on the site, never types passwords, and skips buttons like delete, pay, sign out and checkout.
- Requests that would create, change or delete data are **blocked, but still recorded**. Submitting a form shows you its endpoint and body without changing anything. GraphQL queries go through; mutations are blocked. Turn on **Let it change data** only for a test account.
- Page text goes to the model so it can see the controls on the page. Captured headers, cookies and tokens don't.

## Pick and import

Tick the endpoints you want, or type what you want into **Pick with AI** ("only orders and payments") and the model selects, names and groups them. The model only gets methods, paths, status codes and field names, never values.

**Import** creates a collection named after the site:

- The busiest API host becomes `{{baseUrl}}`. Other hosts stay as written, each in its own folder.
- Bearer tokens become Bearer auth with `{{token}}`. Cookies and credential headers like `X-CSRF-Token` become variables too. All of these values go in a `<site> (radar)` environment, kept in the gitignored `.local.json` file, and that environment is made active.
- Path variables, query params and bodies (JSON, GraphQL and forms) are filled from the latest successful call.
- Browser-only headers, like `User-Agent`, `sec-*`, `Referer` and tracing headers, are dropped.

Session tokens and cookies expire. When requests start returning 401, log in again in the radar browser and import once more, or update the values in the environment.

## Privacy and safety

- On macOS and Linux, Forge controls the radar browser over a private pipe that only Forge can use. No debugging port is opened, so other programs on your computer can't connect to it.
- On Windows, the browser opens a debugging port on `127.0.0.1` while it runs. Any program on your computer could use that port to read the sites you're logged into there, and the panel warns you about this. Close the radar browser when you're done.
- Forge closes the radar browser when Forge quits.
- Logins stay in the radar profile until you click **Forget logins**, which signs you out of every site you used with it.
- Use a test account where you can, and keep banking and other sensitive accounts out of the radar browser.
