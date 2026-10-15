// Regenerates every platform's app icon from the SVG sources in src-tauri/icons/source.
// Forge is a desktop app, so only the macOS, Windows and Linux icons are kept.
//   forge.svg              Windows, Linux, web favicon
//   forge-macos.svg        macOS (Apple grid: margin + shadow)
//   forge-small.svg        bold variant for 16-32 px (.ico, 32x32.png)
//   forge-macos-small.svg  bold variant for the 16/32 px slots of the .icns
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ICONS = "src-tauri/icons";
const SRC = `${ICONS}/source`;
const tmp = mkdtempSync(join(tmpdir(), "forge-icons-"));
const tauri = (svg, out, png) => execFileSync("npx", ["tauri", "icon", `${SRC}/${svg}`, "-o", out, ...(png ? ["-p", png] : [])], { stdio: "ignore" });

tauri("forge.svg", ICONS); // everything, then platform-specific overrides below
// tauri icon also writes mobile and Windows Store icons; Forge doesn't ship those.
for (const f of readdirSync(ICONS)) if (/^(Square\d+x\d+Logo|StoreLogo)\.png$|^64x64\.png$|^(ios|android)$/.test(f)) rmSync(`${ICONS}/${f}`, { recursive: true, force: true });

tauri("forge-small.svg", `${tmp}/small`, "16,24,32");
tauri("forge.svg", `${tmp}/big`, "48,64,128,256");
copyFileSync(`${tmp}/small/32x32.png`, `${ICONS}/32x32.png`);

// .ico with PNG frames: bold artwork up to 32 px, regular above.
const frames = [16, 24, 32].map((s) => [s, readFileSync(`${tmp}/small/${s}x${s}.png`)]).concat([48, 64, 128, 256].map((s) => [s, readFileSync(`${tmp}/big/${s}x${s}.png`)]));
const head = Buffer.alloc(6 + 16 * frames.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(frames.length, 4);
let offset = head.length;
frames.forEach(([s, png], i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(s >= 256 ? 0 : s, e);
  head.writeUInt8(s >= 256 ? 0 : s, e + 1);
  head.writeUInt16LE(1, e + 4);
  head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(png.length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
writeFileSync(`${ICONS}/icon.ico`, Buffer.concat([head, ...frames.map(([, png]) => png)]));

// .icns: Apple-grid artwork, bold at 16/32 px. iconutil ships with macOS only.
if (process.platform === "darwin") {
  tauri("forge-macos.svg", `${tmp}/mac`);
  tauri("forge-macos-small.svg", `${tmp}/macsmall`);
  execFileSync("iconutil", ["-c", "iconset", `${tmp}/mac/icon.icns`, "-o", `${tmp}/mac.iconset`]);
  execFileSync("iconutil", ["-c", "iconset", `${tmp}/macsmall/icon.icns`, "-o", `${tmp}/small.iconset`]);
  for (const f of ["icon_16x16.png", "icon_16x16@2x.png", "icon_32x32.png"]) copyFileSync(`${tmp}/small.iconset/${f}`, `${tmp}/mac.iconset/${f}`);
  execFileSync("iconutil", ["-c", "icns", `${tmp}/mac.iconset`, "-o", `${ICONS}/icon.icns`]);
} else console.warn("Skipped icon.icns (needs macOS iconutil); the existing file was left as is.");

copyFileSync(`${SRC}/forge.svg`, "public/favicon.svg");
rmSync(tmp, { recursive: true, force: true });
console.log("Icons regenerated in", ICONS);
