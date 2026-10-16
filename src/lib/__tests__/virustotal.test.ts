import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { badge, client, markdown, scanFile, selectFiles, summarize, tally, withSection } from "../../../scripts/virustotal.mjs";

const stats = (malicious = 0, undetected = 70) => ({ malicious, suspicious: 0, undetected, harmless: 0, timeout: 1, "type-unsupported": 3 });

/** A fake VirusTotal: knows some hashes, accepts uploads, finishes analyses on the second poll. */
function fakeVt(known: Record<string, ReturnType<typeof stats>>) {
  const calls: string[] = [];
  let polls = 0;
  const fetchImpl = async (url: string, init: any = {}) => {
    calls.push(`${init.method ?? "GET"} ${url.replace("https://www.virustotal.com/api/v3", "")}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const m = /\/files\/([0-9a-f]{64})$/.exec(url);
    if (m) return known[m[1]] ? json({ data: { attributes: { last_analysis_stats: known[m[1]] } } }) : new Response("", { status: 404 });
    if (url.endsWith("/files/upload_url")) return json({ data: "https://upload.virustotal.com/big" });
    if (init.method === "POST") return json({ data: { id: "an-1" } });
    if (url.endsWith("/analyses/an-1")) return json({ data: { attributes: ++polls < 2 ? { status: "queued" } : { status: "completed", stats: stats(1) } } });
    return new Response("nope", { status: 500 });
  };
  return { calls, vt: client("key", { fetchImpl, gapMs: 0 }) };
}

describe("VirusTotal release scan", () => {
  it("scans the files people install, not update bundles or signatures", () => {
    expect(selectFiles(["Forge_0.2.0_aarch64.dmg", "Forge.app.tar.gz", "Forge.app.tar.gz.sig", "Forge_0.2.0_x64-setup.exe", "Forge_0.2.0_x64-setup.nsis.zip", "latest.json", "SHA256SUMS", "forge.mjs", "forge_0.2.0_amd64.AppImage", "forge_0.2.0_amd64.deb", "Forge_0.2.0_x64_en-US.msi"])).toEqual([
      "Forge_0.2.0_aarch64.dmg",
      "Forge_0.2.0_x64-setup.exe",
      "Forge_0.2.0_x64_en-US.msi",
      "forge.mjs",
      "forge_0.2.0_amd64.AppImage",
      "forge_0.2.0_amd64.deb",
    ]);
  });

  it("counts engines the way VirusTotal shows them", () => {
    expect(tally(stats(2, 68))).toEqual({ malicious: 2, suspicious: 0, total: 70 });
  });

  it("reuses an existing report for a known file, and uploads and waits for a new one", async () => {
    const bytes = new TextEncoder().encode("installer");
    const unrelated = "62d9b7b6ae0ce6fb1ed6bec4ed43bd9b1b8bd70ec6e8a7f5fcb7e47e5e0fa4d1";
    const { createHash } = await import("node:crypto");
    const real = createHash("sha256").update(bytes).digest("hex");
    const known = fakeVt({ [real]: stats() });
    expect(await scanFile(known.vt, "a.exe", bytes)).toMatchObject({ name: "a.exe", sha256: real, malicious: 0, total: 70, url: `https://www.virustotal.com/gui/file/${real}` });
    expect(known.calls).toEqual([`GET /files/${real}`]);

    const fresh = fakeVt({ [unrelated]: stats() });
    expect(await scanFile(fresh.vt, "b.exe", bytes)).toMatchObject({ malicious: 1, total: 71 });
    expect(fresh.calls).toEqual([`GET /files/${real}`, "POST /files", "GET /analyses/an-1", "GET /analyses/an-1"]);
  });

  it("uses an upload URL for files over 32 MB", async () => {
    const big = new Uint8Array(33 * 1024 * 1024);
    const f = fakeVt({});
    await scanFile(f.vt, "big.dmg", big);
    expect(f.calls.slice(1, 3)).toEqual(["GET /files/upload_url", "POST https://upload.virustotal.com/big"]);
  });

  it("waits between calls to stay under the free API's limit", async () => {
    const waits: number[] = [];
    const vt = client("k", { fetchImpl: async () => new Response("{}", { status: 404 }), gapMs: 15500, sleep: async (ms: number) => void waits.push(ms) });
    await vt.report("a");
    await vt.report("b");
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(15000);
  });

  it("writes release notes that a re-run replaces, and a badge", () => {
    const s = summarize("v0.2.0", [{ name: "a.dmg", sha256: "x", url: "https://vt/x", malicious: 0, suspicious: 0, total: 70 }, { name: "b.exe", sha256: "y", url: "https://vt/y", malicious: 1, suspicious: 0, total: 72 }], new Date("2026-10-20T00:00:00Z"));
    expect(s).toMatchObject({ flagged: 1, engines: 70 });
    const md = markdown(s);
    expect(md).toContain("| [a.dmg](https://vt/x) | clean | 0 / 70 |");
    expect(md).toContain("| [b.exe](https://vt/y) | **1 flagged** | 1 / 72 |");
    const once = withSection("See CHANGELOG.md.", md);
    expect(withSection(once, md)).toBe(once);
    // VirusTotal's own "flagged / engines" form, so the proportion is visible.
    expect(badge(s)).toEqual({ schemaVersion: 1, label: "VirusTotal", message: "1/70 · v0.2.0", color: "orange" });
    expect(badge({ ...s, flagged: 0 })).toEqual({ schemaVersion: 1, label: "VirusTotal", message: "0/70 · v0.2.0", color: "brightgreen" });
    expect(badge(null)).toMatchObject({ message: "not scanned" });
    expect(summarize("v", [])).toMatchObject({ engines: 0, flagged: 0 });
  });
});
