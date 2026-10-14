// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildReport, render, toMarkdown, type Format } from "../report";

const OUT = process.env.REPORT_OUT;
const fixture = { products: Array.from({ length: 60 }, (_, i) => ({ id: i + 1, title: `Item ${i + 1}`, category: ["beauty", "furniture", "groceries"][i % 3], price: 10 + i * 2.5, rating: (i % 5) + 0.5, reviews: [{ rating: 4, comment: "ok", reviewerName: "A" }], meta: { createdAt: "2024-05-0" + ((i % 9) + 1) + "T00:00:00Z" } })), total: 194, skip: 0, limit: 60 };
const data = OUT ? JSON.parse(readFileSync(`${OUT}/../products.json`, "utf8")) : fixture;

describe("reports", () => {
  const r = buildReport({ title: "Products", source: { method: "GET", url: "https://dummyjson.com/products", status: 200, timeMs: 512 }, data });

  it("are assembled from the data, not invented", () => {
    expect(r.tables[0].total).toBe(data.products.length);
    expect(r.facts).toContainEqual(["Total", "194"]);
    expect(r.charts[0].title).toBe("Products by Category");
    expect(r.charts[0].values.reduce((a, b) => a + b, 0)).toBe(data.products.length);
    expect(r.aiSummary).toBeUndefined();
    expect(toMarkdown(r)).toContain("| Id |");
  });

  it.each(["pdf", "docx", "pptx", "xlsx", "csv", "md"] as Format[])("renders %s", async (f) => {
    const bytes = await render(r, f);
    expect(bytes.length).toBeGreaterThan(200);
    const head = new TextDecoder().decode(bytes.slice(0, 4));
    if (f === "pdf") expect(head).toBe("%PDF");
    if (["docx", "pptx", "xlsx"].includes(f)) expect(head.slice(0, 2)).toBe("PK"); // zip container
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(`${OUT}/products.${f}`, bytes);
    }
  }, 60_000);
});
