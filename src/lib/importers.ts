import { splitArgs } from "./ipc";
import { defaults, kv, type Auth, type HttpItem, type KV } from "./types";

export interface Imported {
  name: string;
  folder: string; // relative folder inside the collection, "" for root
  data: HttpItem;
}

const str = (x: any): string => (typeof x === "string" ? x : x == null ? "" : String(x));

function postmanUrl(u: any): { url: string; params: KV[] } {
  if (typeof u === "string") return { url: u, params: [] };
  if (!u) return { url: "", params: [] };
  const raw = str(u.raw);
  const base = raw.split("?")[0];
  const params = (u.query ?? []).map((q: any) => kv(str(q.key), str(q.value), !q.disabled));
  return { url: base, params };
}

function postmanAuth(a: any): Auth {
  if (!a) return { type: "none" };
  const get = (list: any[] | undefined, key: string) => str(list?.find((x: any) => x.key === key)?.value);
  switch (a.type) {
    case "bearer":
      return { type: "bearer", token: get(a.bearer, "token") };
    case "basic":
      return { type: "basic", username: get(a.basic, "username"), password: get(a.basic, "password") };
    case "apikey":
      return { type: "apikey", key: get(a.apikey, "key"), value: get(a.apikey, "value"), in: get(a.apikey, "in") === "query" ? "query" : "header" };
    default:
      return { type: "none" };
  }
}

/** Postman collection v2.0 / v2.1 → items. Scripts are dropped; auth, body, params and headers carry over. */
export function importPostman(json: any): { name: string; items: Imported[]; variables: KV[] } {
  if (!json?.info || !Array.isArray(json.item)) throw new Error("Not a Postman v2 collection (missing info/item)");
  const items: Imported[] = [];
  const walk = (list: any[], folder: string, inheritedAuth: any) => {
    for (const it of list) {
      if (Array.isArray(it.item)) {
        walk(it.item, folder ? `${folder}/${it.name}` : str(it.name), it.auth ?? inheritedAuth);
        continue;
      }
      const r = it.request ?? {};
      const d = defaults.http();
      d.method = str(r.method || "GET").toUpperCase();
      const { url, params } = postmanUrl(r.url);
      d.url = url;
      d.params = params;
      d.headers = (r.header ?? []).map((h: any) => kv(str(h.key), str(h.value), !h.disabled));
      d.auth = postmanAuth(r.auth ?? inheritedAuth);
      const b = r.body;
      if (b?.mode === "raw") {
        const lang = b.options?.raw?.language;
        d.bodyMode = lang === "xml" ? "xml" : lang === "text" ? "text" : "json";
        d.body = str(b.raw);
      } else if (b?.mode === "urlencoded") {
        d.bodyMode = "form";
        d.form = (b.urlencoded ?? []).map((f: any) => kv(str(f.key), str(f.value), !f.disabled));
      } else if (b?.mode === "formdata") {
        d.bodyMode = "multipart";
        d.multipart = (b.formdata ?? []).map((f: any) => ({ ...kv(str(f.key), str(f.type === "file" ? f.src : f.value), !f.disabled), file: f.type === "file" }));
      } else if (b?.mode === "graphql") {
        d.bodyMode = "graphql";
        d.graphql = { query: str(b.graphql?.query), variables: str(b.graphql?.variables) || "{}" };
      }
      items.push({ name: str(it.name) || `${d.method} ${d.url}`, folder, data: d });
    }
  };
  walk(json.item, "", json.auth);
  const variables = (json.variable ?? []).map((v: any) => kv(str(v.key), str(v.value), !v.disabled));
  return { name: str(json.info.name) || "Imported", items, variables };
}

/** Postman environment export → variables. */
export function importPostmanEnv(json: any): { name: string; vars: KV[] } {
  if (!Array.isArray(json?.values)) throw new Error("Not a Postman environment");
  return { name: str(json.name) || "Imported", vars: json.values.map((v: any) => kv(str(v.key), str(v.value), v.enabled !== false)) };
}

/** Parses a `curl ...` command line (as copied from browser devtools) into an HTTP item. */
export function importCurl(cmd: string): HttpItem {
  // Drop line continuations (also the stray "\" left when newlines were stripped on paste).
  const args = splitArgs(cmd.replace(/\\\r?\n/g, " ").trim()).filter((a) => !(a.length && !a.trim()));
  if (args[0] !== "curl") throw new Error("Command must start with curl");
  const d = defaults.http();
  let data: string[] = [];
  let explicitMethod = "";
  const form: (KV & { file?: boolean })[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i] ?? "";
    if (a === "-X" || a === "--request") explicitMethod = next().toUpperCase();
    else if (a === "-H" || a === "--header") {
      const h = next();
      const c = h.indexOf(":");
      if (c > 0) d.headers.push(kv(h.slice(0, c).trim(), h.slice(c + 1).trim()));
    } else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode"].includes(a)) data.push(next());
    else if (a === "-F" || a === "--form") {
      const f = next();
      const eq = f.indexOf("=");
      const val = f.slice(eq + 1);
      form.push({ ...kv(f.slice(0, eq), val.replace(/^@/, "")), file: val.startsWith("@") });
    } else if (a === "-u" || a === "--user") {
      const [u, ...p] = next().split(":");
      d.auth = { type: "basic", username: u, password: p.join(":") };
    } else if (a === "-k" || a === "--insecure") d.settings.insecure = true;
    else if (a === "--url") d.url = next();
    else if (a === "-A" || a === "--user-agent") d.headers.push(kv("User-Agent", next()));
    else if (a === "-b" || a === "--cookie") d.headers.push(kv("Cookie", next()));
    else if (!a.startsWith("-") && !d.url) d.url = a;
  }
  const [base, qs] = d.url.split("?");
  d.url = base;
  if (qs) d.params = Array.from(new URLSearchParams(qs)).map(([k, v]) => kv(k, v));
  if (form.length) {
    d.bodyMode = "multipart";
    d.multipart = form;
  } else if (data.length) {
    d.body = data.join("&");
    const ct = d.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
    d.bodyMode = /json/.test(ct) || /^\s*[[{]/.test(d.body) ? "json" : /xml/.test(ct) ? "xml" : "text";
  }
  d.method = explicitMethod || (data.length || form.length ? "POST" : "GET");
  return d;
}
