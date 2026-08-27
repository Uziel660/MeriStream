// Repuebla Show.source con las PLATAFORMAS reales donde está la obra,
// deducidas de los source_url de sus episodios (no de dónde salió el póster).
// TMDB NO es plataforma: se limpia.
import { prisma } from "../server/db";

const SKIP_HOSTS = new Set(["image.tmdb.org", "directo", "m3u8"]);

// Solo plataformas REALES de scraping (los CDNs tipo waaw/vidhideplus son servidores)
const PLATFORMS = new Set(["lamovie", "tioanime", "veranimes", "animeflv", "latanime", "tioplus", "cinecalidad"]);

function platformOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.replace(/^www\d?\./, "");
    if (!host || SKIP_HOSTS.has(host)) return null;
    const parts = host.split(".");
    const name = parts[0] === "wwv" || parts[0] === "www3" ? parts[1] : parts[0];
    return name && PLATFORMS.has(name) ? name : null;
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== REPoblando source con plataformas reales ===\n");

  const eps = await prisma.episode.findMany({
    where: { source_url: { not: "" } },
    select: { show_id: true, source_url: true },
  });
  console.log(`Episodios con source_url: ${eps.length}`);

  const byShow = new Map<string, Set<string>>();
  for (const e of eps) {
    const plat = platformOf(e.source_url);
    if (!plat) continue;
    if (!byShow.has(e.show_id)) byShow.set(e.show_id, new Set());
    byShow.get(e.show_id)!.add(plat);
  }
  console.log(`Shows con al menos 1 plataforma: ${byShow.size}`);

  let updated = 0;
  let cleaned = 0;
  const entries = Array.from(byShow.entries());
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    await Promise.all(
      chunk.map(([showId, plats]) => {
        const val = Array.from(plats).slice(0, 4).join(", ");
        return prisma.show
          .update({ where: { id: showId }, data: { source: val } })
          .then(() => updated++)
          .catch(() => {});
      })
    );
    process.stdout.write(`  ${Math.min(i + 100, entries.length)}/${entries.length}\r`);
  }

  // Limpiar valores que no son plataformas ('tmdb' no es plataforma; CDNs tampoco)
  const wrong = await prisma.show.updateMany({
    where: { source: { notIn: ["", ...Array.from(PLATFORMS)] } },
    data: { source: "" },
  });
  cleaned = wrong.count;

  console.log(`\nActualizados por episodios: ${updated}`);
  console.log(`Limpiados ('tmdb' no es plataforma): ${cleaned}`);

  const dist = await prisma.show.groupBy({
    by: ["source"],
    _count: { source: true },
    orderBy: { _count: { source: "desc" } },
    take: 15,
  });
  console.log("\nDistribución final:");
  for (const d of dist) console.log(`  "${d.source}": ${d._count.source}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
