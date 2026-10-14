import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { formatBytes, interpolate } from "../lib/eval";
import { http, uid } from "../lib/ipc";
import { useStore } from "../lib/store";
import type { HttpResponse, Item, WebItem } from "../lib/types";

interface Check {
  group: string;
  name: string;
  status: "pass" | "warn" | "fail" | "info";
  detail: string;
}

const SECURITY_HEADERS: [string, string][] = [
  ["strict-transport-security", "HSTS"],
  ["content-security-policy", "Content-Security-Policy"],
  ["x-content-type-options", "X-Content-Type-Options"],
  ["referrer-policy", "Referrer-Policy"],
  ["permissions-policy", "Permissions-Policy"],
];

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/** Fast, no-browser checks for a web page: availability, perf, SEO basics, security headers, broken links. */
async function check(url: string, maxLinks: number, progress: (s: string) => void): Promise<{ res: HttpResponse; checks: Check[] }> {
  const checks: Check[] = [];
  const add = (group: string, name: string, status: Check["status"], detail: string) => checks.push({ group, name, status, detail });
  const res = await http.send(uid(), { method: "GET", url, headers: [{ key: "Accept", value: "text/html,*/*", enabled: true }], timeoutMs: 30000 }, "web check");
  const h = (k: string) => res.headers.find((x) => x.key.toLowerCase() === k)?.value;

  add("Availability", "HTTP status", res.status < 300 ? "pass" : res.status < 400 ? "warn" : "fail", `${res.status} ${res.statusText}`);
  if (res.url !== url) add("Availability", "Redirect", "info", `Final URL ${res.url}`);
  add("Availability", "HTTPS", res.url.startsWith("https://") ? "pass" : "fail", res.url.startsWith("https://") ? "Served over TLS" : "Page is not served over HTTPS");
  add("Performance", "Time to first byte", res.ttfbMs < 600 ? "pass" : res.ttfbMs < 1500 ? "warn" : "fail", `${res.ttfbMs.toFixed(0)} ms`);
  add("Performance", "Total load (HTML)", res.timeMs < 1500 ? "pass" : res.timeMs < 4000 ? "warn" : "fail", `${res.timeMs.toFixed(0)} ms`);
  add("Performance", "HTML size", res.size < 500_000 ? "pass" : "warn", formatBytes(res.size));
  add("Performance", "Compression", h("content-encoding") ? "pass" : "warn", h("content-encoding") ?? "Response was not compressed");
  add("Performance", "Caching", h("cache-control") ? "pass" : "warn", h("cache-control") ?? "No Cache-Control header");
  for (const [k, label] of SECURITY_HEADERS) add("Security", label, h(k) ? "pass" : "warn", h(k) ?? "Missing");
  const xfo = h("x-frame-options") || /frame-ancestors/.test(h("content-security-policy") ?? "");
  add("Security", "Clickjacking protection", xfo ? "pass" : "warn", xfo ? "X-Frame-Options or frame-ancestors set" : "Missing");
  const cookies = res.headers.filter((x) => x.key.toLowerCase() === "set-cookie");
  for (const c of cookies) {
    const name = c.value.split("=")[0];
    const flags = ["secure", "httponly", "samesite"].filter((f) => !c.value.toLowerCase().includes(f));
    add("Security", `Cookie ${name}`, flags.length ? "warn" : "pass", flags.length ? `Missing ${flags.join(", ")}` : "Secure; HttpOnly; SameSite");
  }
  if (h("server") || h("x-powered-by")) add("Security", "Server fingerprint", "info", [h("server"), h("x-powered-by")].filter(Boolean).join(" · "));

  const doc = new DOMParser().parseFromString(res.body, "text/html");
  const title = doc.querySelector("title")?.textContent?.trim();
  const desc = doc.querySelector('meta[name="description"]')?.getAttribute("content");
  add("SEO & a11y", "Title", title ? (title.length <= 60 ? "pass" : "warn") : "fail", title ? `${title} (${title.length} chars)` : "Missing <title>");
  add("SEO & a11y", "Meta description", desc ? "pass" : "warn", desc ?? "Missing");
  add("SEO & a11y", "Viewport meta", doc.querySelector('meta[name="viewport"]') ? "pass" : "warn", doc.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "Missing. Page may not be mobile-friendly");
  add("SEO & a11y", "<html lang>", doc.documentElement.getAttribute("lang") ? "pass" : "warn", doc.documentElement.getAttribute("lang") ?? "Missing");
  add("SEO & a11y", "Canonical", doc.querySelector('link[rel="canonical"]') ? "pass" : "info", doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "None");
  const h1 = doc.querySelectorAll("h1").length;
  add("SEO & a11y", "Single <h1>", h1 === 1 ? "pass" : "warn", `${h1} found`);
  const imgs = [...doc.querySelectorAll("img")];
  const noAlt = imgs.filter((i) => !i.hasAttribute("alt")).length;
  add("SEO & a11y", "Image alt text", noAlt ? "warn" : "pass", `${noAlt} of ${imgs.length} images missing alt`);
  const mixed = [...doc.querySelectorAll("script[src],link[href],img[src],iframe[src]")].filter((el) => /^http:\/\//.test(el.getAttribute("src") ?? el.getAttribute("href") ?? ""));
  if (res.url.startsWith("https://")) add("Security", "Mixed content", mixed.length ? "fail" : "pass", mixed.length ? `${mixed.length} insecure http:// resources` : "None");

  const links = [
    ...new Set(
      [...doc.querySelectorAll("a[href]")]
        .map((a) => a.getAttribute("href")!)
        .filter((href) => !/^(#|mailto:|tel:|javascript:)/i.test(href))
        .map((href) => {
          try {
            return new URL(href, res.url).toString().split("#")[0];
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    ),
  ].slice(0, maxLinks);
  let done = 0;
  const results = await pool(links, 8, async (link) => {
    let r: HttpResponse | null = null;
    try {
      r = await http.send(uid(), { method: "HEAD", url: link, headers: [], timeoutMs: 15000 }, "web check");
      if (r.status === 405 || r.status === 403) r = await http.send(uid(), { method: "GET", url: link, headers: [], timeoutMs: 15000 }, "web check");
    } catch (e) {
      progress(`Checked ${++done}/${links.length} links`);
      return { link, status: 0, err: String(e) };
    }
    progress(`Checked ${++done}/${links.length} links`);
    return { link, status: r.status, err: "" };
  });
  const broken = results.filter((r) => r.status === 0 || r.status >= 400);
  add("Links", "Broken links", broken.length ? "fail" : "pass", `${broken.length} broken of ${links.length} checked`);
  for (const b of broken) add("Links", b.link, "fail", b.status ? `HTTP ${b.status}` : b.err.slice(0, 120));
  return { res, checks };
}

export default function WebPanel({ item }: { item: Item & WebItem }) {
  const update = useStore((s) => s.updateItem);
  const [state, setState] = useState<{ loading?: boolean; progress?: string; checks?: Check[]; error?: string; res?: HttpResponse }>({});
  const run = async () => {
    let url = interpolate(item.url.trim(), useStore.getState().vars());
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    setState({ loading: true, progress: "Fetching page…" });
    try {
      const r = await check(url, item.maxLinks, (p) => setState((s) => ({ ...s, progress: p })));
      setState(r);
    } catch (e) {
      setState({ error: String(e) });
    }
  };
  const counts = state.checks?.reduce((a, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a), {} as Record<string, number>);
  const groups = [...new Set(state.checks?.map((c) => c.group))];
  return (
    <div className="panel">
      <div className="urlbar">
        <div className="group">
          <input value={item.url} onChange={(e) => update(item.path, { url: e.target.value })} placeholder="https://example.com" spellCheck={false} onKeyDown={(e) => e.key === "Enter" && run()} />
        </div>
        <label className="check" title="Max links to verify">
          links
          <input className="input mono" style={{ width: 64 }} type="number" value={item.maxLinks} onChange={(e) => update(item.path, { maxLinks: Number(e.target.value) })} />
        </label>
        <button className="btn primary" onClick={run} disabled={state.loading}>
          {state.loading ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Run checks
        </button>
      </div>
      <div className="scroll grow">
        {state.loading && <div className="empty">{state.progress}</div>}
        {state.error && <pre className="block err" style={{ margin: 14 }}>{state.error}</pre>}
        {!state.loading && !state.checks && !state.error && (
          <div className="empty">
            <div className="big">Web page health check</div>
            Status, TTFB, compression, caching, security headers, cookies, mixed content, SEO/a11y basics and broken links.
          </div>
        )}
        {state.checks && (
          <div className="pad col">
            <div className="row">
              <span className="ok">{counts?.pass ?? 0} passed</span>
              <span className="warn">{counts?.warn ?? 0} warnings</span>
              <span className="err">{counts?.fail ?? 0} failed</span>
            </div>
            {groups.map((g) => (
              <div key={g} className="card" style={{ padding: 0 }}>
                <div style={{ padding: "10px 14px" }}>
                  <h3>{g}</h3>
                </div>
                {state.checks!.filter((c) => c.group === g).map((c, i) => (
                  <div className="result" key={i}>
                    <span className={c.status === "pass" ? "ok" : c.status === "fail" ? "err" : c.status === "warn" ? "warn" : "muted"} style={{ width: 40, fontWeight: 700, fontSize: 11 }}>
                      {c.status.toUpperCase()}
                    </span>
                    <span style={{ width: 220, flexShrink: 0, wordBreak: "break-all" }}>{c.name}</span>
                    <span className="mono dim selectable" style={{ wordBreak: "break-all" }}>{c.detail}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
