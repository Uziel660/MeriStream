import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

(async () => {
  console.log("=== Recuento exacto por dominio en Episode.source_url ===");
  const eps = await p.episode.findMany({ where: { source_url: { not: "" } }, select: { source_url: true } });
  const count: Record<string, number> = {};
  for (const e of eps) {
    const u = e.source_url.toLowerCase();
    let h = "otro";
    for (const key of ["tubepelis", "veranimes", "cinecalidad", "animeflv", "tioanime", "latanime", "lamovie", "discord", "monoschinos"]) {
      if (u.includes(key)) { h = key; break; }
    }
    count[h] = (count[h] || 0) + 1;
  }
  console.log("Episode.source_url por host:");
  for (const [k, v] of Object.entries(count).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log("\n=== source_site con streams en SourceLink ===");
  const links = await p.sourceLink.findMany({ select: { source_site: true } });
  const sc: Record<string, number> = {};
  for (const l of links) sc[l.source_site] = (sc[l.source_site] || 0) + 1;
  for (const [k, v] of Object.entries(sc).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log("\n=== Muestras de scaffolds 'otro' en Episode.source_url ===");
  let shown = 0;
  for (const e of eps) {
    const u = e.source_url.toLowerCase();
    if (!["tubepelis","veranimes","cinecalidad","animeflv","tioanime","latanime","lamovie"].some(k => u.includes(k))) {
      console.log(`  ${e.source_url}`);
      if (++shown >= 15) break;
    }
  }
  await p.$disconnect();
})();