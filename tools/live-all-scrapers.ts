// Test LIVE de TODOS los scrapers contra URLs reales de la BD.
// Extracta N URLs reales por plataforma y prueba extractStream + analyze.
import { ScraperManager } from "../server/scrapers/ScraperManager";
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function sampleUrlsByHost(): Promise<Record<string, string[]>> {
  const eps = await p.episode.findMany({ where: { source_url: { not: "" } }, select: { source_url: true } });
  const byHost: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const e of eps) {
    const u = e.source_url.toLowerCase();
    let h = "otro";
    for (const key of ["tubepelis", "veranimes", "cinecalidad", "animeflv", "tioanime", "latanime", "lamovie"]) {
      if (u.includes(key)) { h = key; break; }
    }
    if (!byHost[h]) byHost[h] = [];
    if (!seen.has(e.source_url) && byHost[h].length < 3) {
      seen.add(e.source_url);
      byHost[h].push(e.source_url);
    }
  }
  return byHost;
}

(async () => {
  const mgr = ScraperManager.getInstance();
  const byHost = await sampleUrlsByHost();
  await p.$disconnect();

  const report: string[] = [];
  report.push("=== TEST LIVE MULTI-PLATAFORMA ===\n");

  for (const [host, urls] of Object.entries(byHost)) {
    report.push(`\n[${host}] ${urls.length} muestras`);
    for (const url of urls) {
      const adapter = mgr.getAdapter(url);
      const id = adapter ? adapter.id : "none";
      let streamResult = "n/a";
      try {
        const t0 = Date.now();
        const r = await adapter.extractStream(url);
        const ms = Date.now() - t0;
        const ok = r.stream_url && r.stream_url !== url && /^https?:\/\//.test(r.stream_url);
        streamResult = `${ok ? "OK" : "FALLÓ"} (${ms}ms) → ${(r.stream_url || "").slice(0, 70)}`;
      } catch (e: any) {
        streamResult = `EXCP ${e.message}`;
      }
      report.push(`  ${url.split("/")[2]} [${id}] ${streamResult}`);
    }
  }

  const fs = await import("fs");
  fs.writeFileSync("scraper-live-report.txt", report.join("\n"));
  console.log(report.join("\n"));
})();