import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
(async () => {
  const t = await p.show.count();
  const empty = await p.show.count({ where: { description: "" } });
  const placeholder = await p.show.count({
    where: { description: { contains: "indexada", mode: "insensitive" } },
  });
  const veranimes = await p.show.count({
    where: { description: { contains: "veranimes", mode: "insensitive" } },
  });
  const cinecalidad = await p.show.count({
    where: { description: { contains: "cinecalidad", mode: "insensitive" } },
  });
  console.log(`Total: ${t}`);
  console.log(`Vacías: ${empty}`);
  console.log(`Placeholder "indexada": ${placeholder}`);
  console.log(`Contienen "veranimes": ${veranimes}`);
  console.log(`Contienen "cinecalidad": ${cinecalidad}`);
  const dupeBanner = await p.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM "Show" WHERE banner_url IS NOT NULL AND poster_url IS NOT NULL AND banner_url = poster_url`
  );
  const veranimesPoster = await p.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM "Show" WHERE poster_url ILIKE '%veranimes%'`
  );
  const tmdbDupes = await p.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM (SELECT tmdb_id FROM "Show" WHERE tmdb_id IS NOT NULL GROUP BY tmdb_id HAVING COUNT(*) > 1) x`
  );
  console.log(`Banner=Poster duplicados: ${dupeBanner[0].c}`);
  console.log(`Posters veranimes: ${veranimesPoster[0].c}`);
  console.log(`Grupos tmdb duplicados: ${tmdbDupes[0].c}`);
  await p.$disconnect();
})();