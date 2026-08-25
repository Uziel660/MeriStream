import { describe, it, expect } from "vitest";
import { taskWorker } from "./taskWorker";

describe("BackgroundCrawlerWorker", () => {
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
