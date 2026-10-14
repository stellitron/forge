import type { AutoRow } from "../components/ui";
import type { HttpItem } from "./types";

export const COMMON_HEADERS = [
  "Accept", "Accept-Encoding", "Accept-Language", "Authorization", "Cache-Control", "Connection", "Content-Type", "Cookie",
  "If-Match", "If-None-Match", "If-Modified-Since", "Idempotency-Key", "Origin", "Prefer", "Range", "Referer", "User-Agent",
  "X-API-Key", "X-Correlation-ID", "X-Forwarded-For", "X-Request-ID", "X-Requested-With",
];

const MIME = ["application/json", "application/xml", "application/x-www-form-urlencoded", "multipart/form-data", "text/plain", "text/html", "text/csv", "application/octet-stream", "application/graphql-response+json"];

const VALUES: Record<string, string[]> = {
  accept: ["application/json", "*/*", "application/xml", "text/event-stream", "text/html"],
  "content-type": MIME,
  "cache-control": ["no-cache", "no-store", "max-age=0"],
  "accept-encoding": ["gzip, deflate, br", "identity"],
  "accept-language": ["en-US,en;q=0.9", "en"],
  authorization: ["Bearer {{token}}", "Basic {{credentials}}"],
  "x-request-id": ["{{$uuid}}"],
  "x-correlation-id": ["{{$uuid}}"],
  "idempotency-key": ["{{$uuid}}"],
  prefer: ["return=representation", "return=minimal"],
  connection: ["keep-alive", "close"],
};

export const headerValues = (key: string) => VALUES[key.trim().toLowerCase()];

/** One-click additions shown on the Headers tab; ones already present are hidden. */
export const QUICK_HEADERS: [string, string][] = [
  ["Accept", "application/json"],
  ["Cache-Control", "no-cache"],
  ["X-Request-ID", "{{$uuid}}"],
  ["Accept-Language", "en-US"],
  ["Idempotency-Key", "{{$uuid}}"],
];

const CONTENT_TYPE: Partial<Record<HttpItem["bodyMode"], string>> = {
  json: "application/json",
  xml: "application/xml",
  text: "text/plain",
  graphql: "application/json",
  form: "application/x-www-form-urlencoded",
  multipart: "multipart/form-data; boundary=…",
  binary: "application/octet-stream",
};

/** Headers Forge adds on its own, shown read-only so what's sent is never a surprise. Placeholders only, no values. */
export function autoHeaders(item: HttpItem): AutoRow[] {
  const has = (k: string) => item.headers.some((h) => h.enabled && h.key.trim().toLowerCase() === k.toLowerCase());
  const out: AutoRow[] = [];
  const a = item.auth;
  if (a.type === "bearer" && a.token && !has("authorization")) out.push({ key: "Authorization", value: `Bearer ${a.token}`, note: "from the Auth tab" });
  if (a.type === "basic") out.push({ key: "Authorization", value: "Basic ••••••", note: "from the Auth tab" });
  if (a.type === "apikey" && a.in === "header" && a.key) out.push({ key: a.key, value: a.value || "(empty)", note: "from the Auth tab" });
  const ct = CONTENT_TYPE[item.bodyMode];
  if (ct && !has("content-type")) out.push({ key: "Content-Type", value: ct, note: "from the Body tab" });
  if (!has("user-agent")) out.push({ key: "User-Agent", value: "Forge", note: "default" });
  if (!has("accept-encoding")) out.push({ key: "Accept-Encoding", value: "gzip, br, deflate, zstd", note: "default, decoded for you" });
  return out;
}
