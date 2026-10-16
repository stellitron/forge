import { allow, checkEgress, hostOf, knownHosts, secretValues } from "../agent/egress";
import { interpolate } from "./eval";
import { buildRequest } from "./request";
import { useStore } from "./store";
import type { HttpItem, Item } from "./types";

/**
 * Scripts can't reach the network themselves, but what they change still decides where Forge
 * sends things: a pre-request script edits its request, and any script can set a variable like
 * {{baseUrl}} that later requests use. A script from an imported collection could use either to
 * aim your tokens at its own server. So both are checked against where your saved requests go,
 * judged with the variables as they were *before* the script ran (a changed {{baseUrl}} must not
 * vouch for itself), and anything new needs your OK.
 */

/** Explains a prompt when the host is only used by imported requests you haven't trusted yet. */
function onlyImported(hosts: string[], vars: Record<string, string>): string {
  const all = knownHosts(vars, secretValues(), [], true);
  const known = knownHosts(vars, secretValues());
  return hosts.some((h) => all.has(h) && !known.has(h)) ? " Only requests you haven't trusted use it." : "";
}

export interface ScriptRisk {
  hosts: string[];
  secrets: string[];
  summary: string;
}

const body = (b: ReturnType<typeof buildRequest>["body"]) => (b?.type === "raw" ? b.content : b && b.type !== "none" ? JSON.stringify(b) : undefined);

/**
 * A pre-request script's edited request is risky when the script moved it to a host none of your
 * saved requests use, or attached a secret that your saved requests send to other hosts but not
 * this one (your API token turning up on someone else's server). Adding a token the saved
 * requests don't use anywhere, or one they already send to this host, is the everyday
 * "set the Authorization header" script and goes through.
 */
export function requestRisk(original: HttpItem, edited: HttpItem, varsBefore: Record<string, string>, varsAfter: Record<string, string>, scriptSet: string[]): ScriptRisk | null {
  const out = (it: HttpItem, vars: Record<string, string>) => {
    const r = buildRequest(it, vars);
    return { url: r.url, headers: r.headers, body: body(r.body) };
  };
  const sent = out(edited, varsAfter);
  const host = hostOf(sent.url);
  if (!host) return null;
  const known = knownHosts(varsBefore, secretValues());
  const shown = buildRequest(edited, {}).url;
  if (host !== hostOf(out(original, varsBefore).url) && !known.has(host))
    return { hosts: [host], secrets: [], summary: `The pre-request script redirected this request to ${host}, which none of your saved requests use: ${shown.slice(0, 140)}.${onlyImported([host], varsBefore)}` };
  // Values the script made itself (a signature, a timestamp) aren't your secrets; copies of
  // existing secrets still match those secrets' own names.
  const ignore = new Set(scriptSet);
  const now = checkEgress(sent, sent, { vars: varsBefore, ignore }).secrets;
  const before = new Set(checkEgress(out(original, varsBefore), out(original, varsBefore), { vars: varsBefore, ignore }).secrets);
  const here = known.get(host) ?? new Set<string>();
  const moved = now.filter((n) => !before.has(n) && !here.has(n) && [...known.values()].some((names) => names.has(n)));
  if (!moved.length) return null;
  return { hosts: [host], secrets: moved, summary: `The pre-request script added ${moved.map((n) => `{{${n}}}`).join(", ")} to a request to ${host}. Your saved requests send ${moved.length > 1 ? "these" : "it"} to other hosts, not this one: ${shown.slice(0, 140)}` };
}

/** Variables a script set that would point saved requests at hosts none of them use now. */
export function variableRisk(changes: Record<string, string>, varsBefore: Record<string, string>, phase: "pre" | "post"): ScriptRisk | null {
  const names = Object.keys(changes);
  if (!names.length) return null;
  const after = { ...varsBefore, ...changes };
  const known = knownHosts(varsBefore, secretValues());
  const fresh = new Set<string>();
  const used = new Set<string>();
  for (const it of Object.values(useStore.getState().items) as Item[]) {
    if (!("url" in it) || typeof it.url !== "string" || !names.some((n) => it.url.includes(`{{${n}}}`))) continue;
    const host = hostOf(interpolate(it.url, after).replace(/^ws/i, "http"));
    if (host && host !== hostOf(interpolate(it.url, varsBefore)) && !known.has(host)) {
      fresh.add(host);
      names.filter((n) => it.url.includes(`{{${n}}}`)).forEach((n) => used.add(n));
    }
  }
  // A URL-looking value is a destination even if no saved request uses the variable yet.
  for (const [k, v] of Object.entries(changes)) {
    const host = /^(https?|wss?):\/\//i.test(v.trim()) ? hostOf(v.trim().replace(/^ws/i, "http")) : "";
    if (host && !known.has(host)) fresh.add(host), used.add(k);
  }
  if (!fresh.size) return null;
  const hosts = [...fresh];
  return {
    hosts,
    secrets: [],
    summary: `The ${phase === "pre" ? "pre-request" : "post-response"} script wants to set ${[...used].map((n) => `{{${n}}}`).join(", ")}, which would send requests to ${hosts.join(", ")}. None of your saved requests use ${hosts.length > 1 ? "those hosts" : "that host"}.${onlyImported(hosts, varsBefore)}`,
  };
}

/** Remembers an approved host for this session, like approvals for AI-built requests. */
export const allowRisk = (r: ScriptRisk) => r.hosts.forEach((host) => allow({ host, secrets: r.secrets }));
