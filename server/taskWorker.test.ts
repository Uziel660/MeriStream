import { describe, it, expect } from "vitest";
import { detectPaginationTemplate, sourceSiteFromUrl, taskWorker } from "./taskWorker";

describe("task worker source identity", () => {
  it("normalizes provider subdomains to the curated provider id", () => {
    expect(sourceSiteFromUrl("https://ww3.gnulahd.nu/ver/coyote-vs-acme/")).toBe("gnula");
    expect(sourceSiteFromUrl("https://www.cinecalidad.am/ver-pelicula/demo/")).toBe("cinecalidad");
    expect(sourceSiteFromUrl("https://latanime.org/ver/demo-episodio-1")).toBe("latanime");
  });
});

describe("BackgroundCrawlerWorker", () => {
  it("detects a reusable pagination template from labelled page links", () => {
    const detected = detectPaginationTemplate([
      "Página 2: https://example.com/catalog/page/2",
      "Página 3: https://example.com/catalog/page/3",
    ]);
    expect(detected?.template).toBe("https://example.com/catalog/page/{page}");
    expect(detected?.page_start).toBe(2);
  });

  it("creates, retrieves, and pauses a crawl job without SQLite serialization error", async () => {
    const job = await taskWorker.createJob({
      target_url: "https://animeflv.net",
      scope: "catalog_pages",
      max_pages: 2,
      delay_ms: 1000,
    });

    expect(job).toBeDefined();
    expect(job.id).toContain("task-");
    expect(job.target_url).toBe("https://animeflv.net");
    expect(job.status).toBe("pending");
    expect(Array.isArray(job.items_queue)).toBe(true);
    expect(Array.isArray(job.logs)).toBe(true);
    expect(job.logs.length).toBeGreaterThanOrEqual(1);

    const fetched = await taskWorker.getJob(job.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(job.id);
    expect(Array.isArray(fetched?.items_queue)).toBe(true);
    expect(Array.isArray(fetched?.logs)).toBe(true);

    const paused = await taskWorker.pauseJob(job.id);
    expect(paused).toBe(true);

    const deleted = await taskWorker.deleteJob(job.id);
    expect(deleted).toBe(true);
  });
});
