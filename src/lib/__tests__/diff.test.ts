import { describe, expect, it } from "vitest";
import { headerDiff, hunks, jsonDiff, lineDiff, type LineOp } from "../diff";

const apply = (_a: string[], ops: LineOp[]) => ops.filter((o) => o.op !== "del").map((o) => o.text);
const original = (ops: LineOp[]) => ops.filter((o) => o.op !== "add").map((o) => o.text);

describe("jsonDiff", () => {
  it("reports changed, added and removed values at their paths", () => {
    const { changes } = jsonDiff({ id: 1, items: [{ price: 10 }, { price: 5 }], meta: { "x-y": true }, gone: 1 }, { id: 1, items: [{ price: 12 }], meta: { "x-y": false }, fresh: "a" });
    expect(changes).toEqual([
      { path: "$.items[0].price", kind: "changed", before: 10, after: 12 },
      { path: "$.items[1]", kind: "removed", before: { price: 5 } },
      { path: '$.meta["x-y"]', kind: "changed", before: true, after: false },
      { path: "$.gone", kind: "removed", before: 1 },
      { path: "$.fresh", kind: "added", after: "a" },
    ]);
  });
  it("treats a type change as a change, and stops at the limit", () => {
    expect(jsonDiff({ a: [1] }, { a: { 0: 1 } }).changes).toEqual([{ path: "$.a", kind: "changed", before: [1], after: { 0: 1 } }]);
    const r = jsonDiff(Array.from({ length: 50 }, (_, i) => i), Array.from({ length: 50 }, (_, i) => -i), 10);
    expect(r.changes).toHaveLength(10);
    expect(r.more).toBe(true);
  });
  it("finds nothing in equal documents", () => {
    expect(jsonDiff({ a: [1, { b: null }] }, { a: [1, { b: null }] }).changes).toEqual([]);
  });
});

describe("lineDiff", () => {
  it("produces a minimal script that rebuilds both sides", () => {
    const a = "a b c d e f g".split(" ");
    const b = "a x c d f g h".split(" ");
    const ops = lineDiff(a, b)!;
    expect(apply(a, ops)).toEqual(b);
    expect(original(ops)).toEqual(a);
    expect(ops.filter((o) => o.op !== "same")).toHaveLength(4); // -b +x, -e, +h
  });
  it("handles empty and identical inputs, and random edits", () => {
    expect(lineDiff([], [])).toEqual([]);
    expect(lineDiff(["a"], [])).toEqual([{ op: "del", text: "a" }]);
    expect(lineDiff([], ["a"])).toEqual([{ op: "add", text: "a" }]);
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: Math.floor(Math.random() * 30) }, () => "abc"[Math.floor(Math.random() * 3)]);
      const b = Array.from({ length: Math.floor(Math.random() * 30) }, () => "abc"[Math.floor(Math.random() * 3)]);
      const ops = lineDiff(a, b)!;
      expect(apply(a, ops)).toEqual(b);
      expect(original(ops)).toEqual(a);
    }
  });
  it("gives up on huge rewrites instead of hanging", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    expect(lineDiff(a, b, 100)).toBeNull();
  });
  it("is fast on large, mostly equal bodies", () => {
    const a = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
    const b = [...a];
    b[25_000] = "changed";
    const t = performance.now();
    const ops = lineDiff(a, b)!;
    expect(performance.now() - t).toBeLessThan(200);
    expect(ops.filter((o) => o.op !== "same")).toEqual([{ op: "del", text: "line 25000" }, { op: "add", text: "changed" }]);
  });
});

describe("hunks and headers", () => {
  it("collapses long unchanged runs", () => {
    const ops = lineDiff(Array.from({ length: 20 }, (_, i) => `${i}`), Array.from({ length: 20 }, (_, i) => (i === 10 ? "x" : `${i}`)))!;
    const h = hunks(ops, 2);
    expect(h[0]).toEqual({ op: "skip", count: 8 });
    expect(h.filter((x) => x.op !== "skip")).toHaveLength(6);
    expect(h[h.length - 1]).toEqual({ op: "skip", count: 7 });
  });
  it("ignores volatile headers unless asked", () => {
    const a = [{ key: "Date", value: "Mon" }, { key: "Content-Type", value: "application/json" }, { key: "X-Old", value: "1" }];
    const b = [{ key: "date", value: "Tue" }, { key: "content-type", value: "text/html" }, { key: "X-New", value: "2" }];
    expect(headerDiff(a, b)).toEqual([
      { path: "content-type", kind: "changed", before: "application/json", after: "text/html" },
      { path: "x-new", kind: "added", after: "2" },
      { path: "x-old", kind: "removed", before: "1" },
    ]);
    expect(headerDiff(a, b, false)).toHaveLength(4);
  });
});
