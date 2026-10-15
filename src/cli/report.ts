import type { RequestResult, RunResult } from "./run";

/** Report formats: a readable summary for terminals and CI logs, JUnit XML for test dashboards, and JSON. */

const color = (on: boolean) => {
  const c = (code: number) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { green: c(32), red: c(31), dim: c(2), bold: c(1), yellow: c(33) };
};

export function summary(results: RequestResult[]) {
  const tests = results.flatMap((r) => r.tests);
  return {
    requests: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed && !r.error).length,
    errors: results.filter((r) => r.error).length,
    tests: tests.length,
    testsPassed: tests.filter((t) => t.pass).length,
  };
}

/** One line per request as it finishes, with failed checks underneath. */
export function line(r: RequestResult, useColor: boolean, iterations: number): string {
  const c = color(useColor);
  const mark = r.passed ? c.green("✓") : c.red("✗");
  const iter = iterations > 1 ? c.dim(`#${r.iteration} `) : "";
  const status = r.error ? c.red("error") : r.status! >= 400 ? c.yellow(String(r.status)) : String(r.status);
  const out = [`  ${mark} ${iter}${r.method.padEnd(6)} ${r.path}  ${status}${r.timeMs !== undefined ? c.dim(`  ${r.timeMs} ms`) : ""}`];
  if (r.error) out.push(`      ${c.red(r.error)}`);
  for (const t of r.tests.filter((x) => !x.pass)) out.push(`      ${c.red("✗")} ${t.label} ${c.dim(`(got ${t.actual})`)}`);
  return out.join("\n");
}

export function footer(run: RunResult, useColor: boolean): string {
  const c = color(useColor);
  const s = summary(run.results);
  const ok = s.failed === 0 && s.errors === 0;
  const parts = [`${s.requests} request${s.requests === 1 ? "" : "s"}`, c.green(`${s.passed} passed`)];
  if (s.failed) parts.push(c.red(`${s.failed} failed`));
  if (s.errors) parts.push(c.red(`${s.errors} errored`));
  const tests = s.tests ? `${s.testsPassed}/${s.tests} checks passed` : "no checks";
  const skipped = run.skipped.length ? c.dim(` · ${run.skipped.length} non-HTTP item${run.skipped.length === 1 ? "" : "s"} skipped`) : "";
  return `\n${ok ? c.green(c.bold("PASS")) : c.red(c.bold("FAIL"))}  ${parts.join(", ")} · ${tests} · ${(run.durationMs / 1000).toFixed(1)} s${skipped}`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** JUnit XML, read by GitHub, GitLab, Jenkins and most CI dashboards. One suite per folder. */
export function junit(run: RunResult): string {
  const byFolder = new Map<string, RequestResult[]>();
  for (const r of run.results) byFolder.set(r.folder || "root", [...(byFolder.get(r.folder || "root") ?? []), r]);
  const s = summary(run.results);
  const suites = [...byFolder].map(([folder, rs]) => {
    const cases = rs
      .map((r) => {
        const name = `${r.method} ${r.name}${run.results.some((x) => x.iteration > 1) ? ` #${r.iteration}` : ""}`;
        const time = ((r.timeMs ?? 0) / 1000).toFixed(3);
        const failed = r.tests.filter((t) => !t.pass);
        const body = r.error
          ? `<error message="${xml(r.error)}"/>`
          : failed.length
            ? `<failure message="${xml(failed.map((t) => t.label).join("; "))}">${xml(failed.map((t) => `${t.label} (got ${t.actual})`).join("\n"))}</failure>`
            : "";
        return `    <testcase classname="${xml(folder)}" name="${xml(name)}" time="${time}">${body}</testcase>`;
      })
      .join("\n");
    const failures = rs.filter((r) => !r.passed && !r.error).length;
    const errors = rs.filter((r) => r.error).length;
    const time = (rs.reduce((n, r) => n + (r.timeMs ?? 0), 0) / 1000).toFixed(3);
    return `  <testsuite name="${xml(folder)}" tests="${rs.length}" failures="${failures}" errors="${errors}" time="${time}">\n${cases}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Forge" tests="${s.requests}" failures="${s.failed}" errors="${s.errors}" time="${(run.durationMs / 1000).toFixed(3)}">\n${suites.join("\n")}\n</testsuites>\n`;
}

export function json(run: RunResult): string {
  const { secrets: _hidden, ...rest } = run;
  return JSON.stringify({ summary: summary(run.results), ...rest }, null, 2) + "\n";
}
