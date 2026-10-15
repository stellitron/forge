import { describe, expect, it } from "vitest";
import { md5 } from "../crypto";
import { digestHeader, hawkHeader, jwtClaims, parseDigestChallenge, pkceChallenge, signAwsV4, signJwt } from "../auth";

describe("md5", () => {
  it("matches RFC 1321 test values", () => {
    expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5("The quick brown fox jumps over the lazy dog")).toBe("9e107d9d372bb6826bd81d3542a419d6");
    expect(md5("12345678901234567890123456789012345678901234567890123456789012345678901234567890")).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });
});

describe("HTTP Digest", () => {
  it("reproduces the RFC 2617 example", async () => {
    const challenge = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
    const h = await digestHeader({ method: "GET", uri: "/dir/index.html", username: "Mufasa", password: "Circle Of Life", challenge, cnonce: "0a4f113b", nc: 1 });
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(h).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(h).toContain("qop=auth, nc=00000001");
  });

  it("ignores headers that aren't a Digest challenge", () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
  });
});

describe("AWS Signature v4", () => {
  const creds = { accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "service", date: new Date("2015-08-30T12:36:00Z") };
  const sig = (headers: { key: string; value: string }[]) => headers.find((h) => h.key === "Authorization")!.value.split("Signature=")[1];

  it("matches the AWS test suite: get-vanilla", async () => {
    const h = await signAwsV4({ method: "GET", url: "https://example.amazonaws.com/", headers: [], body: "", ...creds });
    expect(sig(h)).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(h.find((x) => x.key === "Authorization")!.value).toContain("SignedHeaders=host;x-amz-date,");
  });

  it("matches the AWS test suite: get-vanilla-query-order-key-case", async () => {
    const h = await signAwsV4({ method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1", headers: [], body: "", ...creds });
    expect(sig(h)).toBe("b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });

  it("marks bodies it can't hash as unsigned", async () => {
    const h = await signAwsV4({ method: "PUT", url: "https://bucket.s3.amazonaws.com/a b.txt", headers: [], body: null, ...creds, service: "s3" });
    expect(h.find((x) => x.key === "X-Amz-Content-Sha256")!.value).toBe("UNSIGNED-PAYLOAD");
  });
});

describe("Hawk", () => {
  it("matches the example in the Hawk specification", async () => {
    const h = await hawkHeader({ method: "GET", url: "http://example.com:8000/resource/1?b=1&a=2", id: "dh37fgj492je", key: "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn", algorithm: "sha256", ext: "some-app-ext-data", ts: 1353832234, nonce: "j4h3g2" });
    expect(h).toBe('Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="');
  });
});

describe("JWT", () => {
  it("matches the HS256 example from RFC 7519 tooling (jwt.io)", async () => {
    const t = await signJwt("HS256", "your-256-bit-secret", { sub: "1234567890", name: "John Doe", iat: 1516239022 });
    expect(t).toBe("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
  });

  it("signs with an ES256 key that verifies", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
    const [h, p, s] = (await signJwt("ES256", pem, { sub: "x" })).split(".");
    const b64 = (x: string) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((x.length + 3) % 4)), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, b64(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });

  it("adds iat and exp unless set, and rejects bad payloads", () => {
    expect(jwtClaims('{"sub":"a"}', 3600, 1000)).toEqual({ sub: "a", iat: 1000, exp: 4600 });
    expect(jwtClaims('{"exp":5}', 3600, 1000)).toEqual({ exp: 5, iat: 1000 });
    expect(() => jwtClaims("[1]", 0)).toThrow(/object/);
  });
});

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B example", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
