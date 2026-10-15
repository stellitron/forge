import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { COLLECTIONS, useStore } from "../lib/store";
import { footer, json, junit, line } from "./report";
import { masker, readData, runCollection, UsageError, type RunOptions } from "./run";

import { VERSION } from "./version";

const HELP = `Forge ${VERSION}: run saved API requests and their tests.

Usage
  forge run [path ...] [options]   Run a collection, folder or request (default: everything)
  forge list [options]             List the requests in the workspace

Options
  -w, --workspace <dir>   Workspace folder (default: the nearest folder with collections/ in it)
  -e, --env <name>        Environment by name or file name, e.g. Staging or staging.json
      --var <key=value>   Set or override a variable. Repeat for more. FORGE_VAR_<key> works too
  -n, --iterations <n>    Run everything n times
  -d, --data <file>       Run once per row of a CSV, JSON or YAML file; columns become variables
  -r, --reporter <name>   cli (default), junit or json
  -o, --output <file>     Write the junit or json report to a file (the summary still prints)
      --bail              Stop at the first failed request
      --timeout <ms>      Override every request's timeout
      --delay <ms>        Wait between requests
  -k, --insecure          Skip TLS certificate checks
      --no-color          Plain output
  -h, --help              Show this help
  -v, --version           Show the version

Exit codes: 0 when every request passes its checks, 1 when any fails or errors, 2 for usage errors.
Secrets from the environment, --var and FORGE_VAR_* are masked as *** in all output.

Examples
  forge run Shop --env staging
  forge run "Shop/Users/List users" --var token=$API_TOKEN
  forge run --env ci --reporter junit --output results.xml
`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  isTTY: boolean;
}

/** Walks up from `from` to the nearest folder containing collections/. */
export function findWorkspace(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, COLLECTIONS))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

interface Parsed {
  command: string;
  paths: string[];
  flags: Record<string, string | boolean>;
  vars: Record<string, string>;
}

const ALIASES: Record<string, string> = { w: "workspace", e: "env", n: "iterations", d: "data", r: "reporter", o: "output", k: "insecure", h: "help", v: "version" };
const BOOLEAN = new Set(["bail", "insecure", "help", "version", "no-color"]);

export function parseArgs(argv: string[]): Parsed {
  const p: Parsed = { command: "", paths: [], flags: {}, vars: {} };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith("-") && a !== "-") {
      let [name, inline] = a.replace(/^--?/, "").split(/=(.*)/s, 2) as [string, string | undefined];
      name = ALIASES[name] ?? name;
      if (BOOLEAN.has(name)) {
        p.flags[name] = true;
        continue;
      }
      const value = inline ?? argv[++k];
      if (value === undefined) throw new UsageError(`--${name} needs a value.`);
      if (name === "var") {
        const at = value.indexOf("=");
        if (at <= 0) throw new UsageError(`--var expects key=value, got "${value}".`);
        p.vars[value.slice(0, at)] = value.slice(at + 1);
      } else p.flags[name] = value;
    } else if (!p.command) p.command = a;
    else p.paths.push(a);
  }
  return p;
}

const num = (v: string | boolean | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a number, got "${v}".`);
  return n;
};

export async function cli(argv: string[], io: Io): Promise<number> {
  try {
    const p = parseArgs(argv);
    if (p.flags.version) return io.out(`${VERSION}\n`), 0;
    if (p.flags.help || !p.command || p.command === "help") return io.out(HELP), p.command || p.flags.help ? 0 : 2;
    if (p.command !== "run" && p.command !== "list") throw new UsageError(`Unknown command "${p.command}". Try forge run or forge list.`);

    const workspace = typeof p.flags.workspace === "string" ? resolve(io.cwd, p.flags.workspace) : findWorkspace(io.cwd);
    if (!workspace) throw new UsageError("No Forge workspace found here. Run inside one, or pass --workspace <dir>.");
    if (!existsSync(join(workspace, COLLECTIONS))) throw new UsageError(`${workspace} isn't a Forge workspace (no collections/ folder).`);

    if (p.command === "list") {
      await useStore.getState().openWorkspace(workspace);
      const items = Object.values(useStore.getState().items).sort((a, b) => a.path.localeCompare(b.path));
      for (const i of items) io.out(`${i.kind === "http" ? (i as { method: string }).method.padEnd(7) : i.kind.toUpperCase().padEnd(7)} ${i.path.slice(COLLECTIONS.length + 1).replace(/\.json$/, "")}\n`);
      return 0;
    }

    const vars = { ...Object.fromEntries(Object.entries(io.env).filter(([k, v]) => k.startsWith("FORGE_VAR_") && v !== undefined).map(([k, v]) => [k.slice(10), v!])), ...p.vars };
    const reporter = String(p.flags.reporter ?? "cli");
    if (!["cli", "junit", "json"].includes(reporter)) throw new UsageError(`Unknown reporter "${reporter}". Use cli, junit or json.`);
    const opts: RunOptions = {
      workspace,
      targets: p.paths,
      env: typeof p.flags.env === "string" ? p.flags.env : undefined,
      vars,
      data: typeof p.flags.data === "string" ? readData(resolve(io.cwd, p.flags.data)) : undefined,
      iterations: num(p.flags.iterations, "iterations") ?? 1,
      bail: !!p.flags.bail,
      timeoutMs: num(p.flags.timeout, "timeout"),
      insecure: !!p.flags.insecure,
      delayMs: num(p.flags.delay, "delay") ?? 0,
    };
    const useColor = io.isTTY && !p.flags["no-color"] && !io.env.NO_COLOR;
    const iterations = opts.data?.length ?? opts.iterations;
    // With a report going to stdout, progress goes to stderr so the report stays parseable.
    const progress = reporter !== "cli" && !p.flags.output ? io.err : io.out;

    progress(`Forge ${VERSION} · ${workspace}${opts.env ? ` · environment ${opts.env}` : ""}\n`);
    const run = await runCollection(opts, (r, secrets) => progress(`${masker(secrets)(line(r, useColor, iterations))}\n`));
    const mask = masker(run.secrets);
    progress(`${mask(footer(run, useColor))}\n`);

    if (reporter !== "cli") {
      const report = mask(reporter === "junit" ? junit(run) : json(run));
      if (typeof p.flags.output === "string") {
        writeFileSync(resolve(io.cwd, p.flags.output), report);
        io.out(`Report written to ${p.flags.output}\n`);
      } else io.out(report);
    }
    return run.results.every((r) => r.passed) && run.results.length > 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`forge: ${e.message}\n`);
      return 2;
    }
    io.err(`forge: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

// Entry point when bundled as dist-cli/forge.mjs.
if (typeof process !== "undefined" && process.argv[1] && /forge(\.mjs)?$/.test(process.argv[1])) {
  cli(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
    isTTY: !!process.stdout.isTTY,
  }).then((code) => process.exit(code));
}
