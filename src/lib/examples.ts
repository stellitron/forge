import { maskText } from "./history";
import { VOLATILE_HEADER } from "./diff";
import { kv, type HttpResponse, type KV, type ResponseExample } from "./types";

/** Headers not worth keeping in an example: cookies, per-response noise, and transport details. */
const DROP = /^(set-cookie|content-length|content-encoding|transfer-encoding|connection|keep-alive|alt-svc|strict-transport-security|vary|via|server)$/i;

export const MAX_EXAMPLE_BODY = 512_000;

export function exampleHeaders(headers: KV[]): KV[] {
  return headers.filter((h) => !DROP.test(h.key) && !VOLATILE_HEADER.test(h.key)).map((h) => kv(h.key, h.value));
}

/** A response worth committing: secret values become {{placeholders}}, cookies and noise go. */
export function exampleFromResponse(res: HttpResponse, name: string, secrets: [string, string][]): ResponseExample {
  if (res.bodyBase64) throw new Error("Binary responses can't be saved as examples.");
  if (res.body.length > MAX_EXAMPLE_BODY) throw new Error(`The response is over ${MAX_EXAMPLE_BODY / 1000} KB, too large to keep in the request file.`);
  return { name, status: res.status, headers: exampleHeaders(res.headers).map((h) => ({ ...h, value: maskText(h.value, secrets) })), body: maskText(res.body, secrets) };
}

export const contentTypeOf = (ex: ResponseExample) => ex.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";

/** "200 OK", "200 OK 2"… */
export function uniqueExampleName(base: string, existing: ResponseExample[] = []): string {
  const taken = new Set(existing.map((e) => e.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
  return name;
}

/** The example shown and served by default: the first one (Make default moves an example to the top). */
export const defaultExample = (list: ResponseExample[] = []): ResponseExample | undefined => list[0];

/** An example in the shape of a live response, for docs and exports. */
export function exampleAsResponse(ex: ResponseExample): HttpResponse {
  return { status: ex.status, statusText: STATUS_TEXT[ex.status] ?? "", httpVersion: "", url: "", headers: ex.headers, body: ex.body, bodyBase64: false, size: ex.body.length, timeMs: 0, ttfbMs: 0 };
}

export const STATUS_TEXT: Record<number, string> = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 410: "Gone", 415: "Unsupported Media Type", 422: "Unprocessable Entity", 429: "Too Many Requests",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};
