/**
 * Fuzzy matching for quick open: the query's characters must appear in order. Matches score
 * higher at word starts (after space, /, -, _, ., or a lower→upper case change), in consecutive
 * runs, and near the start; a shorter target wins ties. Returns null when it doesn't match.
 */
export function fuzzyScore(query: string, target: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, hits: [] };
  const t = target.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    // Prefer the next occurrence at a word start; otherwise take the first.
    let at = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] !== ch) continue;
      if (at < 0) at = i;
      if (isStart(target, i)) {
        at = i;
        break;
      }
      if (i === prev + 1) break;
    }
    if (at < 0) return null;
    score += 1;
    if (isStart(target, at)) score += 6;
    if (at === prev + 1) score += 6;
    if (at === 0) score += 6;
    hits.push(at);
    prev = at;
    ti = at + 1;
  }
  // Earlier and tighter matches first, then shorter names.
  score -= hits[0] * 0.2 + (hits[hits.length - 1] - hits[0] - hits.length + 1) * 0.3 + target.length * 0.01;
  // The whole query as one run starting at a word ("user" in "Get user") beats scattered initials.
  const whole = query.toLowerCase().replace(/\s+/g, "");
  for (let i = t.indexOf(whole); i >= 0; i = t.indexOf(whole, i + 1))
    if (isStart(target, i)) {
      score += 15;
      break;
    }
  return { score, hits };
}

function isStart(s: string, i: number): boolean {
  if (i === 0) return true;
  const p = s[i - 1];
  return /[\s/\\\-_.:·(]/.test(p) || (p === p.toLowerCase() && s[i] !== s[i].toLowerCase());
}

/** Best matches first. `text` gives what to match against; `boost` adds a fixed preference. */
export function fuzzyFilter<T>(query: string, list: T[], text: (t: T) => string, boost: (t: T) => number = () => 0, limit = 50): { item: T; hits: number[] }[] {
  const out: { item: T; hits: number[]; score: number }[] = [];
  for (const item of list) {
    const r = fuzzyScore(query, text(item));
    if (r) out.push({ item, hits: r.hits, score: r.score + boost(item) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
