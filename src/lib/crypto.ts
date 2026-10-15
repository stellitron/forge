/** Small hashing and signing helpers on top of Web Crypto, plus MD5 (which Web Crypto lacks, and HTTP Digest needs). */

const enc = new TextEncoder();
const bytes = (v: string | Uint8Array) => (typeof v === "string" ? enc.encode(v) : v);

export const toHex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export function base64(b: ArrayBuffer | Uint8Array): string {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s);
}

export const base64url = (b: ArrayBuffer | Uint8Array | string) =>
  (typeof b === "string" ? btoa(String.fromCharCode(...enc.encode(b))) : base64(b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomString(len = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(len));
  return base64url(b).slice(0, len);
}

type Sha = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

export async function digest(alg: Sha, data: string | Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.digest(alg, bytes(data) as BufferSource);
}

export const sha256Hex = async (data: string | Uint8Array) => toHex(await digest("SHA-256", data));

export async function hmac(alg: Sha, key: string | Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const raw = key instanceof ArrayBuffer ? new Uint8Array(key) : bytes(key);
  const k = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: alg }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** MD5 (RFC 1321). Only for protocols that require it, such as HTTP Digest. */
export function md5(input: string): string {
  const msg = enc.encode(input);
  const s = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const len = ((msg.length + 8) >> 6) * 64 + 64;
  const buf = new Uint8Array(len);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(len - 8, (msg.length * 8) >>> 0, true);
  view.setUint32(len - 4, Math.floor((msg.length * 8) / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < len; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => view.getUint32(off + i * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) (F = (B & C) | (~B & D)), (g = i);
      else if (i < 32) (F = (D & B) | (~D & C)), (g = (5 * i + 1) % 16);
      else if (i < 48) (F = B ^ C ^ D), (g = (3 * i + 5) % 16);
      else (F = C ^ (B | ~D)), (g = (7 * i) % 16);
      const tmp = D;
      D = C;
      C = B;
      const x = (A + F + K[i] + M[g]) >>> 0;
      const r = s[(i >> 4) * 4 + (i % 4)];
      B = (B + ((x << r) | (x >>> (32 - r)))) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return toHex(out);
}

/** Reads a PEM private key (PKCS#8) for RSA and ECDSA signing. */
export function pemToDer(pem: string): Uint8Array {
  if (/BEGIN (RSA|EC) PRIVATE KEY/.test(pem))
    throw new Error("This key is in PKCS#1/SEC1 format. Convert it with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem");
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (!b64) throw new Error("Paste a PEM private key (-----BEGIN PRIVATE KEY-----).");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
