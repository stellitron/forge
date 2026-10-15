import { describe, expect, it } from "vitest";
import { rankSuggestions } from "../../components/VarInput";
import { COMMON_HEADERS } from "../httpKnowledge";

describe("input suggestions", () => {
  it("puts matches that start with the text first, then ones that contain it", () => {
    expect(rankSuggestions(COMMON_HEADERS, "acc").map((s) => s.value)).toEqual(["Accept", "Accept-Encoding", "Accept-Language"]);
    const id = rankSuggestions(COMMON_HEADERS, "id").map((s) => s.value);
    expect(id[0]).toBe("Idempotency-Key");
    expect(id).toEqual(expect.arrayContaining(["X-Correlation-ID", "X-Request-ID"]));
  });

  it("matches on hints, caps the list, and hides itself on an exact match", () => {
    expect(rankSuggestions(COMMON_HEADERS, "cors").map((s) => s.value)).toEqual(["Origin"]);
    expect(rankSuggestions(COMMON_HEADERS, "").length).toBe(8);
    expect(rankSuggestions(COMMON_HEADERS, "Content-Type")).toEqual([]);
    expect(rankSuggestions(["a", "b"], "z")).toEqual([]);
  });
});
