import { describe, expect, it } from "vitest";
import { auditDirectProviders } from "./directProviderAudit";

describe("direct provider audit", () => {
  it("reports a registered provider with no playable source by media kind", async () => {
    const summary = await auditDirectProviders({
      providers: [{
        id: "vidsrc",
        kinds: ["movie"],
        resolve: async () => [],
      }],
    });

    const entry = summary.entries.find((candidate) => candidate.provider === "vidsrc");
    expect(entry).toMatchObject({
      registered: true,
      ok: false,
      checked_kinds: ["movie"],
      failed_kinds: ["movie"],
    });
    expect(entry?.anomalies).toContain("movie_no_playable_source");
  });

  it("keeps unconfigured clients visible to the administrator", async () => {
    const summary = await auditDirectProviders({
      providers: [{
        id: "anime-sdk",
        kinds: ["anime"],
        resolve: async () => [],
      }],
    });

    const entry = summary.entries.find((candidate) => candidate.provider === "anime-sdk");
    expect(entry).toMatchObject({ configured: false, ok: false });
    expect(entry?.anomalies).toContain("not_configured");
  });
});

