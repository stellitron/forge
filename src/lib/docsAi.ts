import { createSession } from "../agent/llm";
import type { DocEndpoint } from "./apiDocs";
import type { Settings } from "./store";

/**
 * Optional AI drafts for the parts of API docs the data can't supply: a short description per
 * endpoint and an introduction. The model sees structure only (methods, paths, parameter and
 * field names and types, tests), never example values, headers' values or response data.
 * Drafts are shown for review; nothing is saved until the user accepts it.
 */

export interface Draft {
  id: string;
  description: string;
}

const MAX_PER_CALL = 15;

/** What the model is told about an endpoint. Values are left out on purpose. */
export function endpointOutline(e: DocEndpoint) {
  return {
    id: e.id,
    name: e.name,
    folder: e.folder || undefined,
    route: `${e.method} ${e.path.split("?")[0]}`,
    auth: e.auth || undefined,
    parameters: e.params.length ? e.params.map((p) => `${p.name} (${p.in}${p.required ? ", required" : ""})`) : undefined,
    requestBody: e.body ? { type: e.body.type, fields: e.body.fields.map((f) => `${f.path}: ${f.type}`) } : undefined,
    response: e.response ? { status: e.response.status, fields: e.response.fields.map((f) => `${f.path}: ${f.type}`) } : undefined,
    checks: e.tests.length ? e.tests.map((t) => t.replace(/ (is|contains|matches|is not|is greater than|is less than|does not contain) .*$/, " $1 …")) : undefined,
  };
}

export function draftPrompt(title: string, endpoints: DocEndpoint[], withIntro: boolean): string {
  return [
    `You are writing reference documentation for the "${title}" API, based only on the outline below.`,
    "",
    "Rules:",
    "- Describe what each endpoint does in 1 to 3 short sentences, in Markdown. Mention notable parameters or response fields by name in backticks.",
    "- Only state what the outline supports. If the purpose is unclear from the names, say what it returns or accepts instead of guessing at business rules, limits or error codes.",
    "- Plain, direct sentences. No marketing words, no em dashes, no headings, no repeating the route.",
    withIntro ? "- Also write `intro`: 2 to 4 sentences that orient a new developer, such as which endpoint to call first (for example a login or token endpoint) and how the folders are organised." : "",
    "",
    `Reply with only JSON: {${withIntro ? '"intro": "…", ' : ""}"endpoints": [{"id": "…", "description": "…"}]}`,
    "",
    "Outline:",
    JSON.stringify(endpoints.map(endpointOutline), null, 1),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function parseDrafts(text: string, ids: Set<string>): { intro: string; drafts: Draft[] } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { intro: "", drafts: [] };
  let data: any;
  try {
    data = JSON.parse(m[0]);
  } catch {
    return { intro: "", drafts: [] };
  }
  const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s*\u2014\s*/g, ", ").trim().slice(0, 1200) : "");
  const drafts = (Array.isArray(data?.endpoints) ? data.endpoints : [])
    .filter((d: any) => ids.has(String(d?.id)) && clean(d?.description))
    .map((d: any) => ({ id: String(d.id), description: clean(d.description) }));
  return { intro: clean(data?.intro), drafts };
}

/** Drafts descriptions in batches. `onProgress` reports how many endpoints are done. */
export async function draftDescriptions(settings: Settings, title: string, endpoints: DocEndpoint[], withIntro: boolean, onProgress?: (done: number) => void): Promise<{ intro: string; drafts: Draft[] }> {
  let intro = "";
  const drafts: Draft[] = [];
  for (let k = 0; k < endpoints.length; k += MAX_PER_CALL) {
    const batch = endpoints.slice(k, k + MAX_PER_CALL);
    const session = createSession(settings, "You write accurate, concise API reference documentation.", [], draftPrompt(title, batch, withIntro && k === 0));
    const out = parseDrafts((await session.next()).text, new Set(batch.map((e) => e.id)));
    if (out.intro) intro = out.intro;
    drafts.push(...out.drafts);
    onProgress?.(Math.min(k + MAX_PER_CALL, endpoints.length));
  }
  return { intro, drafts };
}
