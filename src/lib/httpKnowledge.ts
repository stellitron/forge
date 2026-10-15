import type { AutoRow } from "../components/ui";
import type { Suggestion } from "../components/VarInput";
import type { HttpItem } from "./types";

/** Common request headers, with what each one is for. */
export const COMMON_HEADERS: Suggestion[] = [
  { value: "Accept", hint: "Response formats you accept" },
  { value: "Accept-Encoding", hint: "Compression you accept" },
  { value: "Accept-Language", hint: "Preferred languages" },
  { value: "Authorization", hint: "Credentials (or use the Auth tab)" },
  { value: "Cache-Control", hint: "Caching rules" },
  { value: "Connection", hint: "Keep the connection open or close it" },
  { value: "Content-Type", hint: "Format of the body you send" },
  { value: "Cookie", hint: "Cookies to send" },
  { value: "If-Match", hint: "Only if the ETag matches" },
  { value: "If-None-Match", hint: "Only if changed (by ETag)" },
  { value: "If-Modified-Since", hint: "Only if changed since a date" },
  { value: "Idempotency-Key", hint: "Makes retries safe" },
  { value: "Origin", hint: "Where the request comes from (CORS)" },
  { value: "Prefer", hint: "Preferred server behaviour" },
  { value: "Range", hint: "Part of the content" },
  { value: "Referer", hint: "Page that made the request" },
  { value: "User-Agent", hint: "Client name and version" },
  { value: "X-API-Key", hint: "API key, common convention" },
  { value: "X-Correlation-ID", hint: "Trace a request across services" },
  { value: "X-Forwarded-For", hint: "Original client IP" },
  { value: "X-Request-ID", hint: "Unique ID for this request" },
  { value: "X-Requested-With", hint: "Marks AJAX requests" },
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
  if (a.type === "oauth2") out.push({ key: "Authorization", value: `Bearer {{${a.tokenVar || "token"}}}`, note: "OAuth 2.0, from the Auth tab" });
  if (a.type === "digest") out.push({ key: "Authorization", value: "Digest …", note: "after the server's challenge" });
  if (a.type === "awsv4") out.push({ key: "Authorization", value: "AWS4-HMAC-SHA256 …", note: "signed when sent" }, { key: "X-Amz-Date", value: "now", note: "signed when sent" });
  if (a.type === "hawk") out.push({ key: "Authorization", value: "Hawk …", note: "signed when sent" });
  if (a.type === "jwt") out.push({ key: "Authorization", value: `${a.prefix ? `${a.prefix} ` : ""}eyJ…`, note: `${a.algorithm} JWT, signed when sent` });
  const ct = CONTENT_TYPE[item.bodyMode];
  if (ct && !has("content-type")) out.push({ key: "Content-Type", value: ct, note: "from the Body tab" });
  if (!has("user-agent")) out.push({ key: "User-Agent", value: "Forge", note: "default" });
  if (!has("accept-encoding")) out.push({ key: "Accept-Encoding", value: "gzip, br, deflate, zstd", note: "default, decoded for you" });
  return out;
}
