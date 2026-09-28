import { describe, expect, it } from "vitest";
import { getProviderAuditTargets } from "./providerAudit";

describe("provider conformance targets", () => {
  it("includes maintained and legacy catalogs without duplicate URLs", () => {
    const targets = getProviderAuditTargets();
    expect(targets.length).toBeGreaterThan(20);
    const urls = targets.map((target) => target.url.toLowerCase());
    expect(new Set(urls).size).toBe(urls.length);
    expect(targets.some((target) => target.provider === "gnula-movies")).toBe(true);
    expect(targets.some((target) => target.provider === "doramasyt")).toBe(true);
    expect(targets.some((target) => target.provider === "tioplus")).toBe(true);
    expect(targets.some((target) => /^open-|direct/i.test(target.provider))).toBe(false);
  });
});

