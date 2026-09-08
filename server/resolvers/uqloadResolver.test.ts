import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveUqload } from "./uqloadResolver";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveUqload", () => {
  it("marks the provider tombstone as unavailable instead of returning a dead iframe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<html><body>File is no longer available as it expired or has been deleted.</body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    )));

    await expect(resolveUqload("https://uqload.com/embed-expired.html")).resolves.toMatchObject({
      type: "embed",
      url: "",
      available: false,
      failure_reason: "stale",
    });
  });
});
