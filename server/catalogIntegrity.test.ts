import { describe, expect, it } from "vitest";
import {
  canonicalCatalogUrl,
  catalogPageFingerprint,
  dedupeCatalogItems,
  isRepeatedCatalogPage,
} from "./catalogIntegrity";

describe("catalog integrity", () => {
  it("canonicalizes tracking parameters, hashes and trailing slashes", () => {
    expect(canonicalCatalogUrl("https://site.test/pelicula/a/?utm_source=x#player")).toBe("https://site.test/pelicula/a");
  });

  it("deduplicates URLs but keeps distinct works with the same title", () => {
    const items = dedupeCatalogItems([
      { title: "Dune", url: "https://site.test/dune/?utm_source=home" },
      { title: "Dune (2021)", url: "https://site.test/dune/?utm_source=search", year: 2021 },
      { title: "Dune", url: "https://site.test/dune-1984/" },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Dune", year: 2021 });
  });

  it("detects a repeated page independently of titles or card order", () => {
    const first = [{ title: "A", url: "https://site.test/a/" }, { title: "B", url: "https://site.test/b/" }];
    const second = [{ title: "B (actual)", url: "https://site.test/b/?utm_source=x" }, { title: "A", url: "https://site.test/a" }];
    const fingerprint = catalogPageFingerprint(first);
    expect(isRepeatedCatalogPage(second, fingerprint)).toBe(true);
  });
});

