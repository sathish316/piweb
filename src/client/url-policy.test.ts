import { describe, expect, it } from "vitest";
import { safeUrl } from "./App.js";

describe("Markdown URL policy", () => {
  it("allows explicit safe schemes", () => {
    expect(safeUrl("https://example.com")).toBe("https://example.com");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
    expect(safeUrl("mailto:user@example.com")).toBe("mailto:user@example.com");
  });
  it("rejects executable and unknown schemes", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("data:text/html,boom")).toBe("");
    expect(safeUrl("file:///etc/passwd")).toBe("");
  });
});
