declare const __FORGE_VERSION__: string;

/** Set by scripts/build-cli.mjs from package.json; "dev" when running from source. */
export const VERSION = typeof __FORGE_VERSION__ === "undefined" ? "dev" : __FORGE_VERSION__;
