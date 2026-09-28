import { describe, expect, it } from "vitest";
import { getProviderAuditTargets, isLocalizedTitleVariant } from "./providerAudit";
import { scraperManager } from "./universalScraper";

describe("provider conformance targets", () => {
  it("includes maintained and legacy catalogs without duplicate URLs", () => {
    const targets = getProviderAuditTargets();
    expect(targets.length).toBeGreaterThan(20);
    const urls = targets.map((target) => target.url.toLowerCase());
    expect(new Set(urls).size).toBe(urls.length);
    expect(targets.some((target) => target.provider === "gnula-movies")).toBe(true);
    expect(targets.some((target) => target.provider === "doramasyt")).toBe(true);
    expect(targets.some((target) => target.provider === "tioplus")).toBe(true);
    expect(targets.some((target) => target.mirror && /gnulahd\.nu/i.test(target.url))).toBe(false);
    expect(targets.some((target) => target.mirror && /lamovie\.online/i.test(target.url))).toBe(true);
    expect(targets.some((target) => target.mirror && /doramasflix\.com/i.test(target.url))).toBe(true);
    expect(targets.some((target) => /^open-|direct/i.test(target.provider))).toBe(false);
  });

  it("has a conformance target for every concrete catalog adapter", () => {
    const targets = getProviderAuditTargets();
    const providers = targets.map((target) => target.provider.toLowerCase());
    const uncovered = scraperManager
      .getAvailableAdapters()
      .map((adapter) => adapter.id.toLowerCase().replace(/_/g, "-"))
      .filter((id) => id !== "generic" && id !== "direct-stream")
      .filter((id) => !providers.some((provider) =>
        provider === id || provider.startsWith(`${id}-`) || (id === "animeflv" && provider === "jkanime"),
      ));

    expect(uncovered).toEqual([]);
  });

  it("recognizes translated catalog labels when the detail slug is consistent", () => {
    expect(isLocalizedTitleVariant(
      "Insustituible",
      "Irreplaceable",
      "https://doramasflix.io/doramas/irreplaceable",
    )).toBe(true);
    expect(isLocalizedTitleVariant(
      "Insustituible",
      "Another Work",
      "https://doramasflix.io/doramas/irreplaceable",
    )).toBe(false);
  });
});

