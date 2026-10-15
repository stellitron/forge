// Bundles the command-line runner into one file, dist-cli/forge.mjs (Node 20 or newer).
// The app's own request, auth and test code is reused; the Tauri bridge is replaced with a Node
// implementation (src/cli/tauriShim.ts).
import { build } from "esbuild";
import { readFileSync, chmodSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const shim = "./src/cli/tauriShim.ts";

await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist-cli/forge.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  legalComments: "none",
  define: { __FORGE_VERSION__: JSON.stringify(version) },
  alias: {
    "@tauri-apps/api/core": shim,
    "@tauri-apps/api/event": shim,
    "@tauri-apps/plugin-opener": shim,
    "@tauri-apps/plugin-dialog": shim,
    "@tauri-apps/plugin-http": shim,
  },
  // Some bundled CommonJS packages call require(); give ESM output a working one.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __forgeRequire } from 'node:module';\nconst require = __forgeRequire(import.meta.url);" },
  logLevel: "warning",
});
chmodSync("dist-cli/forge.mjs", 0o755);
console.log(`Built dist-cli/forge.mjs (Forge ${version})`);
