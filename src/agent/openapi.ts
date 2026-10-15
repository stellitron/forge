/** Compact OpenAPI helpers so an agent can explore large specs without blowing its context. */

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export function summarize(spec: any): string {
  const lines: string[] = [];
  const title = spec?.info?.title ?? "API";
  lines.push(`${title} ${spec?.info?.version ?? ""} (OpenAPI ${spec?.openapi ?? spec?.swagger ?? "?"})`);
  const servers = (spec?.servers ?? []).map((s: any) => s.url);
  if (spec?.host) servers.push(`${(spec.schemes ?? ["https"])[0]}://${spec.host}${spec.basePath ?? ""}`);
  if (servers.length) lines.push(`Servers: ${servers.join(", ")}`);
  const sec = Object.keys(spec?.components?.securitySchemes ?? spec?.securityDefinitions ?? {});
  if (sec.length) lines.push(`Security schemes: ${sec.join(", ")}`);
  lines.push("Operations:");
  for (const [path, ops] of Object.entries<any>(spec?.paths ?? {})) {
    for (const m of METHODS) {
      const op = ops?.[m];
      if (!op) continue;
      const params = [...(ops.parameters ?? []), ...(op.parameters ?? [])]
        .map((p: any) => (p.$ref ? p.$ref.split("/").pop() : `${p.name}${p.required ? "*" : ""}(${p.in})`))
        .join(", ");
      const body = op.requestBody ? " +body" : "";
      lines.push(`  ${m.toUpperCase()} ${path}${params ? ` [${params}]` : ""}${body}: ${op.summary ?? op.operationId ?? ""}`);
    }
  }
  return lines.join("\n");
}

function resolve(spec: any, node: any, depth: number, seen: Set<string>): any {
  if (depth > 6 || node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => resolve(spec, n, depth + 1, seen));
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    if (seen.has(node.$ref)) return { $ref: node.$ref, note: "circular" };
    const target = node.$ref
      .slice(2)
      .split("/")
      .reduce((o: any, k: string) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
    return resolve(spec, target, depth + 1, new Set([...seen, node.$ref]));
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolve(spec, v, depth + 1, seen)]));
}

export function operation(spec: any, method: string, path: string): unknown {
  const ops = spec?.paths?.[path];
  const op = ops?.[method.toLowerCase()];
  if (!op) return { error: `No operation ${method.toUpperCase()} ${path}` };
  return resolve(spec, { ...op, parameters: [...(ops.parameters ?? []), ...(op.parameters ?? [])] }, 0, new Set());
}
