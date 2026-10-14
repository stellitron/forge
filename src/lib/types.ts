export type KV = { key: string; value: string; enabled: boolean };

export type Auth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apikey"; key: string; value: string; in: "header" | "query" };

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
  settings: { timeoutMs: number; followRedirects: boolean; insecure: boolean };
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

export type ItemData = HttpItem | McpItem | A2AItem | WsItem | WebItem | AgentItem;
export type ItemKind = ItemData["kind"];

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
    auth: { type: "none" },
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
  agent: "Agent test",
};
