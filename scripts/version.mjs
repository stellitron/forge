// Keeps the version identical in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml.
//
//   npm run version:check          fails if they differ (used in CI)
//   npm run version:set 0.2.0      sets all three
import { readFileSync, writeFileSync } from "node:fs";

const files = {
  pkg: "package.json",
  conf: "src-tauri/tauri.conf.json",
  cargo: "src-tauri/Cargo.toml",
};
const read = (f) => readFileSync(f, "utf8");
const cargoVersion = (s) => s.match(/^\[package\][\s\S]*?^version = "([^"]+)"/m)?.[1];

const current = {
  [files.pkg]: JSON.parse(read(files.pkg)).version,
  [files.conf]: JSON.parse(read(files.conf)).version,
  [files.cargo]: cargoVersion(read(files.cargo)),
};

const [cmd, next] = process.argv.slice(2);
if (cmd === "set") {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(next ?? "")) throw new Error("Usage: npm run version:set 1.2.3");
  for (const f of [files.pkg, files.conf]) {
    const j = JSON.parse(read(f));
    j.version = next;
    writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }
  writeFileSync(files.cargo, read(files.cargo).replace(/^(\[package\][\s\S]*?^version = ")[^"]+(")/m, `$1${next}$2`));
  console.log(`Version set to ${next}. Update CHANGELOG.md, then commit and tag v${next}.`);
} else {
  const versions = new Set(Object.values(current));
  if (versions.size !== 1) {
    console.error("Versions differ:", current);
    process.exit(1);
  }
  const tag = process.env.GITHUB_REF_NAME;
  if (tag?.startsWith("v") && tag.slice(1) !== [...versions][0]) {
    console.error(`Tag ${tag} does not match version ${[...versions][0]}`);
    process.exit(1);
  }
  console.log(`Version ${[...versions][0]} is consistent.`);
}
