import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "../fuzzy";

const rank = (q: string, list: string[]) => fuzzyFilter(q, list, (s) => s).map((r) => r.item);

describe("fuzzy matching", () => {
  it("needs the characters in order", () => {
    expect(fuzzyScore("lso", "List orders")).not.toBeNull();
    expect(fuzzyScore("osl", "List orders")).toBeNull();
    expect(fuzzyScore("", "x")).toEqual({ score: 0, hits: [] });
  });
  it("prefers word starts, so initials find things", () => {
    expect(fuzzyScore("lo", "List orders")!.hits).toEqual([0, 5]);
    expect(rank("lo", ["Hello world", "List orders"])[0]).toBe("List orders");
    expect(rank("gu", ["Bug report", "getUser"])[0]).toBe("getUser");
  });
  it("ranks exact substrings and tighter matches higher", () => {
    expect(rank("orders", ["Create order schema", "List orders", "Order details"])[0]).toBe("List orders");
    expect(rank("user", ["Shop / Users / Get user", "Superuser report", "u s e r"])[0]).toBe("Shop / Users / Get user");
  });
  it("ignores spaces in the query and caps results", () => {
    expect(fuzzyScore("list ord", "List orders")).not.toBeNull();
    expect(fuzzyFilter("a", Array.from({ length: 100 }, (_, i) => `a${i}`), (s) => s, () => 0, 10)).toHaveLength(10);
  });
  it("is fast enough for big workspaces", () => {
    const list = Array.from({ length: 20_000 }, (_, i) => `Collection ${i % 50} / Folder ${i % 7} / Request number ${i}`);
    const t = performance.now();
    fuzzyFilter("cf3rq", list, (s) => s);
    // Loose enough for a busy CI machine; it catches pathological (e.g. quadratic) slowdowns.
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
