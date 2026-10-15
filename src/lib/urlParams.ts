import type { KV } from "./types";

/**
 * The URL bar and the Params table are two views of one query string, like in Postman: editing
 * either updates the other. The table shows readable values; the URL holds them with only the
 * characters that would break the query (& # spaces, = in keys, a stray %) percent-encoded.
 * Everything else, including {{vars}} and +, stays as typed. Disabled params live only in the table.
 */

/** Encodes what would change the query's structure; valid %XX escapes are left alone. */
export function encodeQueryPart(s: string, isKey = false): string {
  return s.replace(/%(?![0-9A-Fa-f]{2})/g, "%25").replace(isKey ? /[&#=\s]/g : /[&#\s]/g, (c) => encodeURIComponent(c));
}

/** The reverse of encodeQueryPart for display; other escapes (%2B, %2F…) are shown as written. */
export function decodeQueryPart(s: string, isKey = false): string {
  return s.replace(isKey ? /%(26|23|20|3D)/gi : /%(26|23|20)/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** A literal + outside {{vars}}: most servers read it as a space. */
export const hasLiteralPlus = (s: string) => s.replace(/\{\{[^}]*\}\}/g, "").includes("+");

export function splitUrl(url: string): { base: string; query: string | null; hash: string } {
  const h = url.indexOf("#");
  const hash = h >= 0 ? url.slice(h) : "";
  const rest = h >= 0 ? url.slice(0, h) : url;
  const q = rest.indexOf("?");
  return q >= 0 ? { base: rest.slice(0, q), query: rest.slice(q + 1), hash } : { base: rest, query: null, hash };
}

export function parseQuery(query: string): KV[] {
  if (!query) return [];
  return query.split("&").map((part) => {
    const i = part.indexOf("=");
    return { key: decodeQueryPart(i >= 0 ? part.slice(0, i) : part, true), value: i >= 0 ? decodeQueryPart(part.slice(i + 1)) : "", enabled: true };
  });
}

export const queryOf = (params: KV[]) =>
  params
    .filter((p) => p.enabled && p.key)
    .map((p) => (p.value === "" ? encodeQueryPart(p.key, true) : `${encodeQueryPart(p.key, true)}=${encodeQueryPart(p.value)}`))
    .join("&");

export function composeUrl(url: string, params: KV[]): string {
  const { base, hash } = splitUrl(url);
  const q = queryOf(params);
  return `${base}${q ? `?${q}` : ""}${hash}`;
}

/**
 * What the URL bar shows. Older items (and imports) keep params only in the table; they're shown
 * in the URL so both views agree, without rewriting the file until the user edits something.
 */
export function displayUrl(url: string, params: KV[]): string {
  return splitUrl(url).query === null && params.some((p) => p.enabled && p.key) ? composeUrl(url, params) : url;
}

/** Params after the user edited the URL: enabled rows come from the URL, disabled rows are kept. */
export function paramsFromUrl(url: string, previous: KV[]): KV[] {
  const { query } = splitUrl(url);
  const fromUrl = parseQuery(query ?? "").filter((p) => p.key || p.value);
  return [...fromUrl, ...previous.filter((p) => !p.enabled)];
}

/** `:name` path segments (Postman/Express style), e.g. /users/:id/orders/:orderId → ["id", "orderId"]. */
export function pathVarNames(url: string): string[] {
  const { base } = splitUrl(url);
  const path = base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/^\{\{[^}]+\}\}/, "");
  const names: string[] = [];
  for (const m of path.matchAll(/\/:([A-Za-z_][\w-]*)/g)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

/** Keeps one row per path variable in the URL, preserving values the user already entered. */
export function syncPathVars(url: string, current: KV[] = []): KV[] {
  return pathVarNames(url).map((key) => current.find((v) => v.key === key) ?? { key, value: "", enabled: true });
}

export function applyPathVars(url: string, vars: KV[] | undefined, resolve: (s: string) => string): string {
  if (!vars?.length) return url;
  const { base, query, hash } = splitUrl(url);
  const path = base.replace(/\/:([A-Za-z_][\w-]*)/g, (whole, name: string) => {
    const v = vars.find((x) => x.key === name && x.value !== "");
    return v ? `/${encodeURIComponent(resolve(v.value))}` : whole;
  });
  return `${path}${query !== null ? `?${query}` : ""}${hash}`;
}
