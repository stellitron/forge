export type KV = { key: string; value: string; enabled: boolean };

export type OAuth2Grant = "authorization_code" | "client_credentials" | "password";

export interface OAuth2Auth {
  type: "oauth2";
  grant: OAuth2Grant;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  audience: string;
  /** Resource owner password grant only. */
  username: string;
  password: string;
  /** Authorization code: proves the app that started the login is the one finishing it. */
  pkce: boolean;
  /** Where the browser returns to; a loopback address Forge listens on. */
  redirectUri: string;
  /** How the client authenticates to the token endpoint. */
  clientAuth: "body" | "basic";
  /** Environment secret that holds the access token (plus _refresh and _expires). */
  tokenVar: string;
}

export type JwtAlgorithm = "HS256" | "HS384" | "HS512" | "RS256" | "RS384" | "RS512" | "ES256" | "ES384";

export type Auth =
  /** Use the nearest folder's auth (or none if no folder sets one). */
  | { type: "inherit" }
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apikey"; key: string; value: string; in: "header" | "query" }
  | OAuth2Auth
  | { type: "digest"; username: string; password: string }
  | { type: "awsv4"; accessKey: string; secretKey: string; sessionToken: string; region: string; service: string }
  | { type: "hawk"; id: string; key: string; algorithm: "sha256" | "sha1"; ext: string }
  | {
      type: "jwt";
      algorithm: JwtAlgorithm;
      /** HMAC secret, or a PEM private key (PKCS#8) for RS and ES algorithms. */
      secret: string;
      /** JSON claims; {{variables}} are filled in. */
      payload: string;
      /** Adds iat and exp when they aren't in the payload; 0 to skip. */
      expiresIn: number;
      prefix: string;
    };

/** PEM files for mutual TLS; paths may use {{variables}}. */
export interface ClientCert {
  cert: string;
  key: string;
  ca: string;
}

export type BodyMode = "none" | "json" | "text" | "xml" | "form" | "multipart" | "graphql" | "binary";

export type AssertSource = "status" | "header" | "jsonpath" | "body" | "time" | "size";
export type AssertOp =
  | "eq" | "neq" | "contains" | "notContains" | "gt" | "lt" | "exists" | "notExists" | "matches";

export interface Assertion {
  enabled: boolean;
  source: AssertSource;
  path: string; // header name or JSONPath, unused for status/body/time/size
  op: AssertOp;
  value: string;
}

/** Pulls a value out of a response into an environment variable (e.g. a login token). */
export interface Extraction {
  enabled: boolean;
  variable: string;
  source: "jsonpath" | "header";
  path: string;
}

export interface HttpItem {
  kind: "http";
  method: string;
  url: string;
  params: KV[];
  /** Values for `:name` segments in the URL. */
  pathVars?: KV[];
  headers: KV[];
  auth: Auth;
  bodyMode: BodyMode;
  body: string;
  form: KV[];
  multipart: (KV & { file?: boolean })[];
  graphql: { query: string; variables: string };
  assertions: Assertion[];
  extractions: Extraction[];
  settings: { timeoutMs: number; followRedirects: boolean; insecure: boolean; clientCert?: ClientCert };
  /** Markdown shown in generated API docs (the Docs tab). */
  description?: string;
  /** Saved responses: shown in docs, used as context by AI, and served by the mock server. The first is the default. */
  examples?: ResponseExample[];
  /** JavaScript run before sending (Postman's pm API, Bruno's bru/req). */
  preScript?: string;
  /** JavaScript run after the response arrives, for tests and saving values. */
  postScript?: string;
}

/** A response saved with a request, committed with it (secret values are stored as {{placeholders}}). */
export interface ResponseExample {
  name: string;
  status: number;
  headers: KV[];
  body: string;
}

export interface McpItem {
  kind: "mcp";
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string;
  env: KV[];
  cwd: string;
  url: string;
  headers: KV[];
}

export interface A2AItem {
  kind: "a2a";
  url: string;
  headers: KV[];
}

export interface WsItem {
  kind: "ws";
  url: string;
  headers: KV[];
  message: string;
}

export interface WebItem {
  kind: "web";
  url: string;
  maxLinks: number;
}

/** Captures the APIs a web app calls while you (or the agent) use it in a separate browser. */
export interface RadarItem {
  kind: "radar";
  url: string;
  /** Browser program path; empty picks the first Chrome-family browser found. */
  browser: string;
  /** What the exploring agent should focus on. */
  goal: string;
  maxSteps: number;
  /** Lets the agent's clicks send POST/PUT/PATCH/DELETE; otherwise they're blocked but recorded. */
  allowWrites: boolean;
}

export interface AgentItem {
  kind: "agent";
  goal: string;
  baseUrl: string;
  specUrl: string;
  mcpRef: string; // workspace path of an MCP item, or ""
  a2aRef: string; // workspace path of an A2A item, or ""
  maxSteps: number;
  approveMutations: boolean;
}

export type ItemData = HttpItem | McpItem | A2AItem | WsItem | WebItem | RadarItem | AgentItem;
export type ItemKind = ItemData["kind"];

/**
 * Settings a folder passes down to everything inside it, kept in `<folder>/_folder.json`. A
 * collection is the top-level folder, so its settings are the collection's.
 */
export interface FolderSettings {
  /** "inherit" (the default) passes the parent folder's auth through. */
  auth: Auth;
  /** Added to every request; a request's own header of the same name wins. */
  headers: KV[];
  /** Collection and folder variables. The active environment overrides them. */
  vars: KV[];
  /** Run before each request's own scripts, outer folders first. */
  preScript?: string;
  postScript?: string;
  description?: string;
}

export const emptyFolder = (): FolderSettings => ({ auth: { type: "inherit" }, headers: [], vars: [] });

/** A saved item. `path` is relative to the workspace root and doubles as its id. */
export type Item = ItemData & { name: string; path: string };

/**
 * `vars` live in environments/<name>.json and are meant to be committed.
 * `secrets` live in environments/<name>.local.json, which the workspace .gitignore excludes;
 * captured values (tokens) and imported Postman environments go there.
 */
export interface Environment {
  name: string;
  path: string;
  vars: KV[];
  secrets: KV[];
}

export interface HttpResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  url: string;
  headers: KV[];
  body: string;
  bodyBase64: boolean;
  size: number;
  timeMs: number;
  ttfbMs: number;
}

export interface AssertionResult {
  label: string;
  pass: boolean;
  actual: string;
}

export const kv = (key = "", value = "", enabled = true): KV => ({ key, value, enabled });

export const defaults: { [K in ItemKind]: () => Extract<ItemData, { kind: K }> } = {
  http: () => ({
    kind: "http",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    // New requests use their folder's auth; with none set anywhere, that's no auth.
    auth: { type: "inherit" },
    bodyMode: "none",
    body: "",
    form: [],
    multipart: [],
    graphql: { query: "", variables: "{}" },
    assertions: [],
    extractions: [],
    settings: { timeoutMs: 30000, followRedirects: true, insecure: false },
  }),
  mcp: () => ({ kind: "mcp", transport: "stdio", command: "", args: "", env: [], cwd: "", url: "", headers: [] }),
  a2a: () => ({ kind: "a2a", url: "", headers: [] }),
  ws: () => ({ kind: "ws", url: "", headers: [], message: "" }),
  web: () => ({ kind: "web", url: "", maxLinks: 50 }),
  radar: () => ({ kind: "radar", url: "", browser: "", goal: "", maxSteps: 40, allowWrites: false }),
  agent: () => ({
    kind: "agent",
    goal: "",
    baseUrl: "",
    specUrl: "",
    mcpRef: "",
    a2aRef: "",
    maxSteps: 30,
    approveMutations: true,
  }),
};

export const kindLabel: Record<ItemKind, string> = {
  http: "HTTP / GraphQL",
  mcp: "MCP server",
  a2a: "A2A agent",
  ws: "WebSocket",
  web: "Web check",
  radar: "Website radar",
  agent: "Agent test",
};
