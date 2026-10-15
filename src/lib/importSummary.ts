import type { ImportResult, Source } from "./importAny";
import type { HttpItem } from "./types";

/**
 * A check of what an import contains and what may need attention, built from the parsed result
 * (and the raw files, for things the importer drops, like Postman scripts). No AI involved.
 */

export type IssueLevel = "warn" | "info";

export interface ImportIssue {
  level: IssueLevel;
  text: string;
  /** Up to a few request names it applies to. */
  examples?: string[];
}

export interface ImportSummary {
  requests: number;
  collections: number;
  folders: number;
  methods: [string, number][];
  auth: [string, number][];
  bodies: [string, number][];
  withTests: number;
  withDescriptions: number;
  envs: { name: string; shared: number; secrets: number }[];
  /** {{names}} used by requests that no imported environment defines. */
  undefinedVars: string[];
  issues: ImportIssue[];
}

const AUTH_NAMES: Record<string, string> = { none: "No auth", bearer: "Bearer", basic: "Basic", apikey: "API key", oauth2: "OAuth 2.0", digest: "Digest", awsv4: "AWS Signature v4", hawk: "Hawk", jwt: "JWT" };
const BODY_NAMES: Record<string, string> = { none: "No body", json: "JSON", xml: "XML", text: "Text", form: "Form", multipart: "Multipart", graphql: "GraphQL", binary: "File" };
const BUILTIN = new Set(["$uuid", "$timestamp", "$isoTimestamp", "$randomInt", "$randomEmail"]);
const VAR = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const literal = (v: string) => v.trim().length >= 6 && !v.includes("{{");

function count<T>(list: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of list) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

/** Postman and Bruno scripts the importer can't carry over. */
export function countScripts(sources: Source[]): number {
  let n = 0;
  for (const s of sources) {
    if (/\.bru$/i.test(s.path)) {
      n += (s.content.match(/^(script:(pre-request|post-response)|tests)\s*\{/gm) ?? []).length;
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(s.content);
    } catch {
      continue;
    }
    const walk = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.event))
        for (const e of node.event) {
          const exec = e?.script?.exec;
          const code = Array.isArray(exec) ? exec.join("\n") : typeof exec === "string" ? exec : "";
          if (code.trim()) n++;
        }
      if (Array.isArray(node.item)) node.item.forEach(walk);
    };
    walk(json);
  }
  return n;
}

/** `known` lists variable names the workspace already defines, so they aren't reported as missing. */
export function summarizeImport(r: ImportResult, sources: Source[] = [], known: string[] = []): ImportSummary {
  const all = r.collections.flatMap((c) => c.items.map((i) => ({ ...i, collection: c.name })));
  const reqs: HttpItem[] = all.map((i) => i.data);
  const name = (i: (typeof all)[number]) => (i.folder ? `${i.folder}/${i.name}` : i.name);
  const issues: ImportIssue[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const add = (level: IssueLevel, verbOne: string, verbMany: string, rest: string, list: (typeof all)[number][]) =>
    list.length && issues.push({ level, text: `${plural(list.length, `request ${verbOne}`, `requests ${verbMany}`)} ${rest}`, examples: list.slice(0, 3).map(name) });

  // Variables used versus defined.
  const defined = new Set<string>([...r.envs.flatMap((e) => [...e.vars, ...e.secrets].map((v) => v.key)), ...(r.baseUrl ? ["baseUrl"] : []), ...known]);
  const used = new Map<string, number>();
  for (const d of reqs) for (const m of JSON.stringify(d).matchAll(VAR)) if (!BUILTIN.has(m[1])) used.set(m[1], (used.get(m[1]) ?? 0) + 1);
  const undefinedVars = [...used.keys()].filter((k) => !defined.has(k)).sort();

  add("warn", "has", "have", "no URL.", all.filter((i) => !i.data.url.trim()));
  add(
    "warn",
    "has",
    "have",
    "a credential typed in directly instead of a {{variable}}. It would be saved in the request file and shared through git. Replace it with a {{variable}} kept in an environment's secrets.",
    all.filter((i) => {
      const a = i.data.auth;
      const authLit =
        (a.type === "bearer" && literal(a.token)) ||
        ((a.type === "basic" || a.type === "digest") && literal(a.password)) ||
        (a.type === "apikey" && literal(a.value)) ||
        (a.type === "oauth2" && literal(a.clientSecret)) ||
        (a.type === "awsv4" && literal(a.secretKey)) ||
        (a.type === "hawk" && literal(a.key)) ||
        (a.type === "jwt" && literal(a.secret));
      return authLit || i.data.headers.some((h) => /^(authorization|x-api-key|api-key|cookie)$/i.test(h.key) && literal(h.value));
    }),
  );
  add(
    "info",
    "uses",
    "use",
    "plain http:// for a non-local host.",
    all.filter((i) => /^http:\/\/(?!localhost|127\.|0\.0\.0\.0|\[::1\]|\{\{)/i.test(i.data.url.trim())),
  );
  const seen = new Map<string, number>();
  for (const i of all) seen.set(`${i.collection}/${name(i)}`.toLowerCase(), (seen.get(`${i.collection}/${name(i)}`.toLowerCase()) ?? 0) + 1);
  add(
    "info",
    "shares",
    "share",
    "a name with another request in the same folder; they'll be numbered.",
    all.filter((i, k) => seen.get(`${i.collection}/${name(i)}`.toLowerCase())! > 1 && all.findIndex((x) => `${x.collection}/${name(x)}`.toLowerCase() === `${i.collection}/${name(i)}`.toLowerCase()) === k),
  );
  if (undefinedVars.length)
    issues.push({ level: "warn", text: `${plural(undefinedVars.length, "variable is", "variables are")} used but not defined in any environment: ${undefinedVars.slice(0, 8).map((v) => `{{${v}}}`).join(", ")}${undefinedVars.length > 8 ? ` and ${undefinedVars.length - 8} more` : ""}. Add ${undefinedVars.length === 1 ? "it" : "them"} to an environment before sending.` });
  const scripts = countScripts(sources);
  if (scripts) issues.push({ level: "warn", text: `${plural(scripts, "pre-request or test script was", "pre-request or test scripts were")} not imported, because Forge doesn't run scripts. Recreate checks in each request's Tests tab.` });
  if (r.skipped.length) issues.push({ level: "info", text: `${plural(r.skipped.length, "item was", "items were")} skipped: ${r.skipped.slice(0, 4).join(", ")}${r.skipped.length > 4 ? "…" : ""}` });
  const secretsMoved = r.envs.reduce((n, e) => n + e.secrets.length, 0);
  if (secretsMoved) issues.push({ level: "info", text: `${plural(secretsMoved, "secret value was", "secret values were")} moved to local files that stay out of git.` });

  return {
    requests: all.length,
    collections: r.collections.length,
    folders: new Set(all.filter((i) => i.folder).map((i) => `${i.collection}/${i.folder}`)).size,
    methods: count(reqs, (d) => d.method.toUpperCase()),
    auth: count(reqs, (d) => AUTH_NAMES[d.auth.type] ?? d.auth.type),
    bodies: count(reqs.filter((d) => d.bodyMode !== "none"), (d) => BODY_NAMES[d.bodyMode] ?? d.bodyMode),
    withTests: reqs.filter((d) => d.assertions.length > 0).length,
    withDescriptions: reqs.filter((d) => d.description?.trim()).length,
    envs: r.envs.map((e) => ({ name: e.name, shared: e.vars.length, secrets: e.secrets.length })),
    undefinedVars,
    issues,
  };
}
