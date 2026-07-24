import { describe, expect, it } from "vitest";
import { boundedPreview, redactSecrets, summarizeArgs } from "./adapter.js";

describe("browser-safe Pi payloads", () => {
  it("bounds tool arguments and results", () => {
    expect(summarizeArgs({ path: "a".repeat(400) })).toHaveLength(241);
    const preview = boundedPreview("x".repeat(9_000));
    expect(preview.length).toBeLessThan(8_100);
    expect(preview).toContain("characters omitted");
  });

  it("redacts credential-like content", () => {
    const value = boundedPreview({
      authorization: "Bearer top-secret",
      apiKey: "sk-test-12345678901234567890",
      safe: "visible",
    });
    expect(value).not.toContain("top-secret");
    expect(value).not.toContain("sk-test");
    expect(value).toContain("visible");
    expect(redactSecrets("access_token=verysecretvalue")).toBe("access_token=[REDACTED]");
  });
});
