import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

async function main() {
  // Para los episodes con source_url .m3u8, ¿tienen SourceLink o link a tioplus?
  const eps = await p.episode.findMany({
    where: { source_url: { contains: ".m3u8" } },
    select: { id: true, show_id: true, source_url: true },
    take: 200,
  });

  // Ver si estos shows tienen relación con tioplus
  const showIds = [...new Set(eps.map((e) => e.show_id))];
  console.log(`Muestra de ${eps.length} episodes (${showIds.length} shows)`);

  // SourceLink asociados a estos episodes vía MediaItem? Estructura distinta.
  // Ver si hay SourceLink con source_site=tioplus
  const tioplusLinks = await p.sourceLink.count({ where: { source_site: { contains: "tioplus" } } });
  console.log(`SourceLink con source_site=tioplus: ${tioplusLinks}`);

  // Ver el source de los shows de estos episodes
  const shows = await p.show.findMany({ where: { id: { in: showIds } }, select: { id: true, title: true, source: true } });
  const bySource: Record<string, number> = {};
  for (const s of shows) bySource[s.source] = (bySource[s.source] || 0) + 1;
  console.log("\nSource de estos shows:");
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) console.log(`  "${k}": ${v}`);

  // Un ejemplo completo
  const sample = eps[0];
  console.log("\nEjemplo episode source_url:", sample.source_url);
  await p.$disconnect();
}
main();