// Scans release files on VirusTotal and summarises the results, for the release notes, the
// website and a README badge. No dependencies (Node 20+).
//
//   node scripts/virustotal.mjs scan <dir> --version v0.2.0 --out virustotal.json --markdown virustotal.md
//   node scripts/virustotal.mjs badge virustotal.json > virustotal-badge.json
//
// scan needs VT_API_KEY. Without it, it prints a notice and exits 0, so releases still work.
// The free API allows 4 requests a minute; every call here waits its turn.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://www.virustotal.com/api/v3";
const DIRECT_LIMIT = 32 * 1024 * 1024;

/** Files people download and run. Update bundles, signatures and checksums aren't scanned. */
export function selectFiles(names) {
  return names
    .filter((n) => /\.(dmg|exe|msi|AppImage|deb|rpm|mjs)$/i.test(n))
    .filter((n) => !/\.(sig|tar\.gz|zip)$/i.test(n))
    .sort();
}

/** Engines that gave a verdict, the way VirusTotal counts "x / y security vendors". */
export function tally(stats) {
  const s = { malicious: 0, suspicious: 0, undetected: 0, harmless: 0, ...stats };
  return { malicious: s.malicious, suspicious: s.suspicious, total: s.malicious + s.suspicious + s.undetected + s.harmless };
}

export const reportUrl = (sha256) => `https://www.virustotal.com/gui/file/${sha256}`;

export function summarize(version, files, scannedAt = new Date()) {
  const flagged = files.reduce((n, f) => n + f.malicious + f.suspicious, 0);
  return { version, scannedAt: scannedAt.toISOString(), flagged, engines: files.length ? Math.min(...files.map((f) => f.total)) : 0, files };
}

/** The section added to the release notes, between markers so a re-run replaces it. */
export function markdown(summary) {
  const rows = summary.files.map((f) => `| [${f.name}](${f.url}) | ${f.malicious + f.suspicious ? `**${f.malicious + f.suspicious} flagged**` : "clean"} | ${f.malicious + f.suspicious} / ${f.total} |`);
  return [
    "<!-- virustotal:start -->",
    "### VirusTotal",
    "",
    `Every installer was scanned on VirusTotal on ${summary.scannedAt.slice(0, 10)}. Open a file's report to see each engine's result.`,
    "",
    "| File | Result | Engines flagging it |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "Checksums and build provenance are in `SHA256SUMS` and on the release's attestations: `gh attestation verify <file> -R stellitron/forge`.",
    "<!-- virustotal:end -->",
  ].join("\n");
}

/** Replaces an earlier VirusTotal section in release notes, or appends one. */
export function withSection(notes, section) {
  const re = /<!-- virustotal:start -->[\s\S]*?<!-- virustotal:end -->/;
  return re.test(notes) ? notes.replace(re, section) : `${notes.trimEnd()}\n\n${section}\n`;
}

/** shields.io endpoint JSON: https://img.shields.io/endpoint?url=… */
export function badge(summary) {
  if (!summary?.files?.length) return { schemaVersion: 1, label: "VirusTotal", message: "not scanned", color: "lightgrey" };
  const version = summary.version ? ` · ${summary.version}` : "";
  return summary.flagged
    ? { schemaVersion: 1, label: "VirusTotal", message: `${summary.flagged}/${summary.engines}${version}`, color: "orange" }
    : { schemaVersion: 1, label: "VirusTotal", message: `0/${summary.engines}${version}`, color: "brightgreen" };
}

/** A VirusTotal client that waits between calls to stay under the rate limit. */
export function client(apiKey, { fetchImpl = fetch, gapMs = 15500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = 0;
  const call = async (url, init = {}) => {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetchImpl(url.startsWith("http") ? url : `${API}${url}`, { ...init, headers: { "x-apikey": apiKey, accept: "application/json", ...init.headers } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`VirusTotal ${init.method ?? "GET"} ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  return {
    report: (sha256) => call(`/files/${sha256}`),
    async upload(name, bytes) {
      // Files over 32 MB need a one-time upload URL.
      const target = bytes.length > DIRECT_LIMIT ? (await call("/files/upload_url")).data : "/files";
      const form = new FormData();
      form.append("file", new Blob([bytes]), name);
      return (await call(target, { method: "POST", body: form })).data.id;
    },
    analysis: (id) => call(`/analyses/${id}`),
  };
}

/** Scans one file: reuses VirusTotal's existing report when the exact file is known, otherwise uploads and waits. */
export async function scanFile(vt, name, bytes, { maxPolls = 40 } = {}) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let stats = (await vt.report(sha256))?.data?.attributes?.last_analysis_stats;
  if (!stats) {
    const id = await vt.upload(name, bytes);
    for (let i = 0; i < maxPolls; i++) {
      const a = await vt.analysis(id);
      if (a?.data?.attributes?.status === "completed") {
        stats = a.data.attributes.stats;
        break;
      }
    }
    if (!stats) throw new Error(`VirusTotal didn't finish analysing ${name} in time`);
  }
  return { name, sha256, url: reportUrl(sha256), ...tally(stats) };
}

async function main(argv) {
  const [cmd, target, ...rest] = argv;
  const opt = (k) => {
    const i = rest.indexOf(`--${k}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === "badge") {
    let summary = null;
    try {
      summary = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      /* no results yet */
    }
    process.stdout.write(JSON.stringify(badge(summary)) + "\n");
    return;
  }
  if (cmd !== "scan" || !target) throw new Error("Usage: virustotal.mjs scan <dir> --version vX --out file.json --markdown file.md | badge <file.json>");
  const key = process.env.VT_API_KEY;
  if (!key) {
    console.log("::notice::VT_API_KEY isn't set; skipping the VirusTotal scan. See docs/releasing.md.");
    return;
  }
  const vt = client(key);
  const names = selectFiles(readdirSync(target).filter((n) => statSync(join(target, n)).isFile()));
  const files = [];
  for (const n of names) {
    console.log(`Scanning ${n}…`);
    const r = await scanFile(vt, basename(n), readFileSync(join(target, n)));
    console.log(`  ${r.malicious + r.suspicious} / ${r.total} engines flagged it · ${r.url}`);
    files.push(r);
  }
  const summary = summarize(opt("version") ?? "", files);
  writeFileSync(opt("out") ?? "virustotal.json", JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(opt("markdown") ?? "virustotal.md", markdown(summary) + "\n");
  if (summary.flagged) console.log(`::warning::VirusTotal engines flagged ${summary.flagged} result(s). Unsigned installers often get false positives; check each report before publishing.`);
  // A later workflow step fails the job on this, after the results are attached.
  writeFileSync(opt("flagged") ?? "virustotal.flagged", String(summary.flagged));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
