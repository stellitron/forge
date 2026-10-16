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

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (FIPS 180-4), synchronous, for places that can't await Web Crypto. Hex output. */
export function sha256Sync(input: string | Uint8Array): string {
  const msg = bytes(input);
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(padded.length - 4, (len << 3) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}
