import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Agent, EnvHttpProxyAgent, fetch, FormData, Headers, type Dispatcher } from "undici";
import type { RawRequest } from "../lib/ipc";
import { VERSION } from "./version";
import type { HttpResponse } from "../lib/types";

/**
 * The CLI's HTTP engine. Mirrors the desktop app's Rust engine: proxies from HTTP(S)_PROXY,
 * client certificates, skipping TLS checks when asked, redirects, a cookie jar per run,
 * decompression and timing.
 */

const agents = new Map<string, Dispatcher>();
const expand = (p: string) => (p.startsWith("~/") ? `${process.env.HOME ?? ""}/${p.slice(2)}` : p);

async function dispatcher(req: RawRequest): Promise<Dispatcher> {
  const cert = req.clientCert;
  const key = JSON.stringify([req.insecure, cert]);
  if (agents.has(key)) return agents.get(key)!;
  const read = async (p: string, what: string) => {
    try {
      return await readFile(expand(p.trim()), "utf8");
    } catch (e) {
      throw new Error(`Couldn't read the ${what} file ${p}: ${(e as Error).message}`);
    }
  };
  const connect = {
    rejectUnauthorized: !req.insecure,
    ...(cert ? { cert: await read(cert.cert, "certificate"), key: await read(cert.key, "private key"), ...(cert.ca ? { ca: await read(cert.ca, "CA certificate") } : {}) } : {}),
  };
  const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const d = proxied ? new EnvHttpProxyAgent({ connect }) : new Agent({ connect });
  agents.set(key, d);
  return d;
}

/** host → cookie name → value. Shared by every request in the run, like the app's cookie jar. */
const jar = new Map<string, Map<string, string>>();
export const resetCookies = () => jar.clear();

function cookieHeader(url: URL): string {
  const parts: string[] = [];
  for (const [host, cookies] of jar) if (url.hostname === host || url.hostname.endsWith(`.${host}`)) for (const [k, v] of cookies) parts.push(`${k}=${v}`);
  return parts.join("; ");
}

function remember(url: URL, setCookies: string[]) {
  for (const c of setCookies) {
    const [pair, ...attrs] = c.split(";");
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const domain = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a))?.slice(7).replace(/^\./, "") || url.hostname;
    const m = jar.get(domain) ?? new Map<string, string>();
    m.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    jar.set(domain, m);
  }
}

async function body(req: RawRequest): Promise<BodyInit | undefined> {
  const b = req.body;
  if (!b || b.type === "none") return undefined;
  if (b.type === "raw") return b.content;
  if (b.type === "form") return new URLSearchParams(b.fields.filter((f) => f.enabled).map((f) => [f.key, f.value])).toString();
  if (b.type === "binary") return new Uint8Array(await readFile(expand(b.path)));
  const form = new FormData();
  for (const f of b.fields.filter((x) => x.enabled)) {
    if (f.file) form.append(f.key, new Blob([new Uint8Array(await readFile(expand(f.value)))]), basename(f.value));
    else form.append(f.key, f.value);
  }
  return form as unknown as BodyInit;
}

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json|.*\+json|.*\+xml))/i;

export async function send(req: RawRequest): Promise<HttpResponse> {
  const url = new URL(req.url);
  const headers = new Headers();
  for (const h of req.headers.filter((x) => x.enabled && x.key)) headers.append(h.key, h.value);
  if (req.body?.type === "form" && !headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded");
  if (!headers.has("user-agent")) headers.set("user-agent", `Forge-CLI/${VERSION}`);
  const cookies = cookieHeader(url);
  if (cookies && !headers.has("cookie")) headers.set("cookie", cookies);

  const controller = new AbortController();
  const timer = req.timeoutMs ? setTimeout(() => controller.abort(), req.timeoutMs) : undefined;
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: req.method,
      headers,
      body: (await body(req)) as never,
      redirect: req.followRedirects === false ? "manual" : "follow",
      signal: controller.signal,
      dispatcher: await dispatcher(req),
    });
    const ttfb = performance.now() - start;
    const bytes = new Uint8Array(await res.arrayBuffer());
    remember(new URL(res.url || url), res.headers.getSetCookie());
    const type = res.headers.get("content-type") ?? "";
    const textual = !type || TEXTUAL.test(type);
    return {
      status: res.status,
      statusText: res.statusText,
      httpVersion: "HTTP/1.1",
      url: res.url || url.toString(),
      headers: [...res.headers].map(([key, value]) => ({ key, value, enabled: true })),
      body: textual ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("base64"),
      bodyBase64: !textual,
      size: bytes.length,
      timeMs: performance.now() - start,
      ttfbMs: ttfb,
    };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (err.name === "AbortError") throw new Error(`Timed out after ${req.timeoutMs} ms`);
    throw new Error(`${req.method} ${url.host} failed: ${err.cause?.message ?? err.cause?.code ?? err.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

