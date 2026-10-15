import { base64, base64url, digest, hmac, md5, pemToDer, randomString, sha256Hex, toHex } from "./crypto";
import type { JwtAlgorithm, KV } from "./types";

/**
 * Signing for the auth types that depend on the final request: AWS Signature v4, Hawk, JWT and
 * HTTP Digest. Pure functions with time and randomness passed in, so each is tested against the
 * worked examples in its specification.
 */

// ───────────────────────── AWS Signature Version 4 ─────────────────────────

/** RFC 3986 encoding, as AWS requires (encodeURIComponent leaves !'()* alone). */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export interface SigV4Input {
  method: string;
  url: string;
  headers: KV[];
  /** Raw body, or null when it can't be hashed here (multipart, files); then the payload is unsigned. */
  body: string | null;
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  /** For tests; defaults to now. */
  date?: Date;
}

export async function signAwsV4(i: SigV4Input): Promise<KV[]> {
  const u = new URL(i.url);
  const amzDate = (i.date ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const s3 = i.service === "s3";
  const payloadHash = i.body === null ? "UNSIGNED-PAYLOAD" : await sha256Hex(i.body);

  const add: KV[] = [{ key: "X-Amz-Date", value: amzDate, enabled: true }];
  if (i.sessionToken) add.push({ key: "X-Amz-Security-Token", value: i.sessionToken, enabled: true });
  if (s3 || i.body === null) add.push({ key: "X-Amz-Content-Sha256", value: payloadHash, enabled: true });

  // Host plus every header we send, except ones a proxy may change.
  const skip = new Set(["authorization", "user-agent", "content-length", "connection", "expect", "x-amzn-trace-id"]);
  const all = new Map<string, string[]>();
  all.set("host", [u.host]);
  for (const h of [...i.headers.filter((h) => h.enabled && h.key), ...add]) {
    const k = h.key.trim().toLowerCase();
    if (skip.has(k) || k === "host") continue;
    all.set(k, [...(all.get(k) ?? []), h.value.trim().replace(/\s+/g, " ")]);
  }
  const names = [...all.keys()].sort();
  const canonicalHeaders = names.map((k) => `${k}:${all.get(k)!.join(",")}\n`).join("");
  const signedHeaders = names.join(";");

  const path = u.pathname || "/";
  const canonicalUri = s3
    ? path.split("/").map((seg) => rfc3986(safeDecode(seg))).join("/")
    : path.split("/").map((seg) => rfc3986(rfc3986(safeDecode(seg)))).join("/");
  const query = u.search.slice(1);
  const pairs = query
    ? query.split("&").filter(Boolean).map((p) => {
        const at = p.indexOf("=");
        const k = at < 0 ? p : p.slice(0, at);
        const v = at < 0 ? "" : p.slice(at + 1);
        return [rfc3986(safeDecode(k)), rfc3986(safeDecode(v))] as const;
      })
    : [];
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join("&");

  const canonical = [i.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");

  let key: ArrayBuffer = await hmac("SHA-256", `AWS4${i.secretKey}`, day);
  for (const part of [i.region, i.service, "aws4_request"]) key = await hmac("SHA-256", key, part);
  const signature = toHex(await hmac("SHA-256", key, toSign));

  return [
    ...add,
    { key: "Authorization", value: `AWS4-HMAC-SHA256 Credential=${i.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, enabled: true },
  ];
}

// ───────────────────────── Hawk ─────────────────────────

export interface HawkInput {
  method: string;
  url: string;
  id: string;
  key: string;
  algorithm: "sha256" | "sha1";
  ext?: string;
  /** For tests. */
  ts?: number;
  nonce?: string;
}

export async function hawkHeader(i: HawkInput): Promise<string> {
  const u = new URL(i.url);
  const ts = i.ts ?? Math.floor(Date.now() / 1000);
  const nonce = i.nonce ?? randomString(8);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const ext = i.ext ?? "";
  const normalized = ["hawk.1.header", ts, nonce, i.method.toUpperCase(), u.pathname + u.search, u.hostname.toLowerCase(), port, "", ext.replace(/\\/g, "\\\\").replace(/\n/g, "\\n"), ""].join("\n");
  const mac = base64(await hmac(i.algorithm === "sha1" ? "SHA-1" : "SHA-256", i.key, normalized));
  const quote = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `Hawk id="${quote(i.id)}", ts="${ts}", nonce="${nonce}"${ext ? `, ext="${quote(ext)}"` : ""}, mac="${mac}"`;
}

// ───────────────────────── JWT ─────────────────────────

const JWT: Record<JwtAlgorithm, { kind: "hmac" | "rsa" | "ec"; hash: "SHA-256" | "SHA-384" | "SHA-512"; curve?: string }> = {
  HS256: { kind: "hmac", hash: "SHA-256" },
  HS384: { kind: "hmac", hash: "SHA-384" },
  HS512: { kind: "hmac", hash: "SHA-512" },
  RS256: { kind: "rsa", hash: "SHA-256" },
  RS384: { kind: "rsa", hash: "SHA-384" },
  RS512: { kind: "rsa", hash: "SHA-512" },
  ES256: { kind: "ec", hash: "SHA-256", curve: "P-256" },
  ES384: { kind: "ec", hash: "SHA-384", curve: "P-384" },
};

export async function signJwt(alg: JwtAlgorithm, secret: string, claims: Record<string, unknown>): Promise<string> {
  const spec = JWT[alg];
  const input = `${base64url(JSON.stringify({ alg, typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
  let sig: ArrayBuffer;
  if (spec.kind === "hmac") sig = await hmac(spec.hash, secret, input);
  else {
    const der = pemToDer(secret) as BufferSource;
    const key =
      spec.kind === "rsa"
        ? await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: spec.hash }, false, ["sign"])
        : await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: spec.curve! }, false, ["sign"]);
    sig = await crypto.subtle.sign(spec.kind === "rsa" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: spec.hash }, key, new TextEncoder().encode(input));
  }
  return `${input}.${base64url(sig)}`;
}

/** Claims from the editor's JSON, with iat/exp added unless present. */
export function jwtClaims(json: string, expiresIn: number, now = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  let claims: Record<string, unknown>;
  try {
    claims = json.trim() ? JSON.parse(json) : {};
  } catch (e) {
    throw new Error(`JWT payload isn't valid JSON: ${(e as Error).message}`);
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) throw new Error("JWT payload must be a JSON object.");
  if (expiresIn > 0) {
    claims.iat ??= now;
    claims.exp ??= now + expiresIn;
  }
  return claims;
}

// ───────────────────────── HTTP Digest (RFC 7616, RFC 2617) ─────────────────────────

/** Parses `Digest realm="x", nonce="y", qop="auth"` from a WWW-Authenticate header. */
export function parseDigestChallenge(header: string): Record<string, string> | null {
  const at = header.search(/digest\s/i);
  if (at < 0) return null;
  const out: Record<string, string> = {};
  for (const m of header.slice(at + 7).matchAll(/([a-zA-Z-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out.nonce ? out : null;
}

export interface DigestInput {
  method: string;
  /** Path and query, as sent. */
  uri: string;
  username: string;
  password: string;
  challenge: Record<string, string>;
  /** For tests. */
  cnonce?: string;
  nc?: number;
}

export async function digestHeader(i: DigestInput): Promise<string> {
  const c = i.challenge;
  const algorithm = (c.algorithm ?? "MD5").toUpperCase();
  const sess = algorithm.endsWith("-SESS");
  const sha = algorithm.startsWith("SHA-256");
  if (!sha && !algorithm.startsWith("MD5")) throw new Error(`Digest algorithm ${c.algorithm} isn't supported. Forge supports MD5 and SHA-256.`);
  const H = async (s: string) => (sha ? sha256Hex(s) : md5(s));
  const qops = (c.qop ?? "").split(",").map((q) => q.trim());
  const qop = qops.includes("auth") ? "auth" : "";
  const cnonce = i.cnonce ?? randomString(16);
  const nc = (i.nc ?? 1).toString(16).padStart(8, "0");
  let ha1 = await H(`${i.username}:${c.realm ?? ""}:${i.password}`);
  if (sess) ha1 = await H(`${ha1}:${c.nonce}:${cnonce}`);
  const ha2 = await H(`${i.method.toUpperCase()}:${i.uri}`);
  const response = qop ? await H(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : await H(`${ha1}:${c.nonce}:${ha2}`);
  const parts = [`username="${i.username}"`, `realm="${c.realm ?? ""}"`, `nonce="${c.nonce}"`, `uri="${i.uri}"`];
  if (c.algorithm) parts.push(`algorithm=${c.algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  parts.push(`response="${response}"`);
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

// ───────────────────────── OAuth 2.0 PKCE (RFC 7636) ─────────────────────────

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await digest("SHA-256", verifier));
}
