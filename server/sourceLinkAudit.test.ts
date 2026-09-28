import { describe, expect, it, vi, beforeEach } from "vitest";

const rows: any[] = [];
const updates: any[] = [];

vi.mock("./db", () => ({
  prisma: {
    sourceLink: {
      findMany: vi.fn(async () => rows),
      update: vi.fn(async (args: any) => { updates.push(args); return args; }),
    },
  },
}));

import { auditSourceLinks, isCatalogNavigationLocator } from "./sourceLinkAudit";

describe("sourceLinkAudit", () => {
  beforeEach(() => {
    rows.splice(0);
    updates.splice(0);
  });

  it("detecta rutas de catálogo pero conserva las fichas con slug", () => {
    expect(isCatalogNavigationLocator("https://provider.example/series/page/2")).toBe(true);
    expect(isCatalogNavigationLocator("https://provider.example/series/the-bear")).toBe(false);
    expect(isCatalogNavigationLocator("https://gnula.life/archives/series")).toBe(true);
  });

  it("marca temporal/directo y host de página inválido sin borrar el registro", async () => {
    rows.push(
      { id: "catalog", source_site: "gnula", url: "https://gnula.life/archives/series", link_type: "page", canonical_locator: null, source_status: "discovered", last_checked: null },
      { id: "signed", source_site: "gnula", url: "https://cdn.example/video.mp4?token=abc", link_type: "direct", canonical_locator: null, source_status: "discovered", last_checked: null },
      { id: "wrong-host", source_site: "gnula", url: "https://unknown.example/show/episode-1", link_type: "page", canonical_locator: null, source_status: "discovered", last_checked: null },
    );
    const result = await auditSourceLinks({ fetch: vi.fn() as any });
    expect(result.failed).toBe(3);
    expect(result.catalogLocators).toBe(1);
    expect(result.ephemeralDirect).toBe(1);
    expect(updates).toHaveLength(3);
    expect(updates.every((entry) => entry.data.source_status === "failed")).toBe(true);
  });
});
