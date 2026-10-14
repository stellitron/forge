import { describe, expect, it } from "vitest";
import { analyze, highlights, pickColumns, query } from "../shape";

const products = {
  products: [
    { id: 1, title: "Mascara", category: "beauty", price: 9.99, stock: 99, tags: ["a", "b"], dimensions: { width: 15.1, height: 13 }, inStock: true, reviews: [{ rating: 3, comment: "meh" }, { rating: 5, comment: "great" }], meta: { createdAt: "2024-05-23T08:56:21.618Z" } },
    { id: 2, title: "Eyeshadow", category: "beauty", price: 19.99, stock: 34, tags: ["c"], dimensions: { width: 10, height: 9 }, inStock: false, reviews: [{ rating: 4, comment: "ok" }], meta: { createdAt: "2024-06-01T00:00:00Z" } },
    { id: 3, title: "Sofa", category: "furniture", price: 1299, stock: 4, tags: [], dimensions: { width: 200, height: 90 }, inStock: true, reviews: [], meta: { createdAt: "2024-01-02T00:00:00Z" } },
  ],
  total: 194,
  skip: 0,
  limit: 30,
};

describe("response shape", () => {
  const s = analyze(products);
  const main = s.datasets[0];

  it("finds the record list, nested child lists and top-level facts", () => {
    expect(s.datasets.map((d) => [d.id, d.rows.length])).toEqual([["$.products", 3], ["$.products[*].reviews", 3]]);
    expect(s.facts).toEqual([["Total", "194"], ["Skip", "0"], ["Limit", "30"]]);
    // Child rows keep a link to their parent.
    expect(s.datasets[1].rows[0]).toEqual({ "Product id": 1, rating: 3, comment: "meh" });
  });

  it("flattens nested objects and types every column", () => {
    const t = Object.fromEntries(main.columns.map((c) => [c.key, c.type]));
    expect(t).toMatchObject({ id: "integer", price: "number", "dimensions.width": "number", inStock: "boolean", "meta.createdAt": "date", tags: "string", reviews: "list" });
    expect(main.rows[0].tags).toBe("a, b");
    expect(main.columns[0].key).toBe("id"); // identifiers first
    const price = main.columns.find((c) => c.key === "price")!;
    expect(price.numeric).toMatchObject({ min: 9.99, max: 1299, median: 19.99 });
    expect(main.columns.find((c) => c.key === "category")!.top).toEqual([["beauty", 2], ["furniture", 1]]);
  });

  it("queries: filter, sort, group with aggregates", () => {
    expect(query(main, { where: [{ column: "price", op: "lt", value: 100 }], sort: [{ column: "price", dir: "desc" }], columns: ["title", "price"] }).rows).toEqual([
      { title: "Eyeshadow", price: 19.99 },
      { title: "Mascara", price: 9.99 },
    ]);
    expect(query(main, { groupBy: "category", aggregate: { column: "stock", fn: "sum" } }).rows).toEqual([
      { category: "beauty", count: 2, "sum of stock": 133 },
      { category: "furniture", count: 1, "sum of stock": 4 },
    ]);
  });

  it("writes highlights without AI and picks readable columns", () => {
    const h = highlights(main).join(" ");
    expect(h).toContain("3 products with");
    expect(h).toContain("Price: 9.99 to 1,299, average 442.99, total 1,328.98.");
    expect(h).toContain("Category: 2 distinct; most common beauty (2), furniture (1).");
    expect(h).not.toContain("Title:"); // all-unique text says nothing
    expect(pickColumns(main, 4)).toContain("title");
  });

  it("handles a single object and a bare array of scalars", () => {
    expect(analyze({ id: 7, name: "Ada", address: { city: "Pune" } }).datasets.map((d) => d.label)).toEqual(["Fields", "Record"]);
    expect(analyze([1, 2, 3]).datasets[0].columns[0].numeric?.sum).toBe(6);
  });

  it("stays fast on big responses", () => {
    const big = { items: Array.from({ length: 50_000 }, (_, i) => ({ id: i, group: `g${i % 7}`, value: i * 1.5, nested: { flag: i % 2 === 0 } })) };
    const t0 = performance.now();
    const r = analyze(big);
    expect(r.datasets[0].rows.length).toBe(50_000);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
