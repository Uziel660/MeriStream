// tools/sanitize-anime-catalog.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ANIME_SOURCES = new Set([
  "animeflv",
  "jkanime",
  "tioanime",
  "latanime",
  "veranimes",
  "hianimes",
  "lamovie_animes",
  "gnula_anime",
  "wwv",
]);

async function sanitizeCatalog() {
  console.log("[Sanitize] Iniciando saneamiento del catálogo de Anime...");

  // 1. Detectar y limpiar los géneros que tienen el volcado completo del menú de Cinecalidad/GNULA
  // Cadena típica: contiene "Dc comics" o "Marvel" o "Animación, Anime, Aventura, Bélico"
  const contaminatedShows = await prisma.show.findMany({
    where: {
      OR: [
        { genres: { contains: "Dc comics", mode: "insensitive" } },
        { genres: { contains: "Animación, Anime, Aventura, Bélico" } },
        { genres: { contains: "Anime, Aventura, Bélico, Ciencia Ficción" } },
      ],
    },
    select: { id: true, title: true, genres: true, category: true, source: true, tmdb_id: true },
  });

  console.log(`[Sanitize] Obras con menú inyectado en genres encontradas: ${contaminatedShows.length}`);

  let cleanedGenresCount = 0;
  for (const show of contaminatedShows) {
    const rawGenres = show.genres.split(",").map((g) => g.trim());
    const filtered = rawGenres.filter(
      (g) =>
        !/^(dc comics|marvel|anime|animación|acción y aventura|sci-fi & fantasy)$/i.test(g)
    );
    const newGenres = filtered.length > 0 ? filtered.slice(0, 4).join(", ") : "Película";

    await prisma.show.update({
      where: { id: show.id },
      data: { genres: newGenres },
    });
    cleanedGenresCount++;
  }
  console.log(`[Sanitize] Géneros limpiados en ${cleanedGenresCount} obras.`);

  // 2. Corregir shows que están marcados con category = 'anime' pero vienen de fuentes de películas/series
  const nonAnimeShows = await prisma.show.findMany({
    where: {
      category: "anime",
      source: {
        notIn: Array.from(ANIME_SOURCES),
      },
    },
    select: { id: true, title: true, source: true, genres: true, episodes: { select: { id: true } } },
  });

  console.log(`[Sanitize] Obras no-anime con category='anime' encontradas: ${nonAnimeShows.length}`);

  let categoryFixedCount = 0;
  for (const show of nonAnimeShows) {
    const isSeries = show.episodes.length > 1 || /temporada|season|cap[ií]tulo/i.test(show.title);
    const newCategory = isSeries ? "series" : "movie";

    const cleanedGenres = show.genres
      .split(",")
      .map((g) => g.trim())
      .filter((g) => !/^anime$/i.test(g))
      .join(", ") || (isSeries ? "Serie" : "Película");

    await prisma.show.update({
      where: { id: show.id },
      data: {
        category: newCategory,
        genres: cleanedGenres,
      },
    });
    categoryFixedCount++;
  }
  console.log(`[Sanitize] Categoría corregida a movie/series en ${categoryFixedCount} obras.`);

  // 3. Limpiar shows de fuentes como cinecalidad, ww3, tubepelis que tengan 'Anime' en sus géneros aunque category no sea anime
  const strayAnimeGenres = await prisma.show.findMany({
    where: {
      category: { not: "anime" },
      source: { notIn: Array.from(ANIME_SOURCES) },
      genres: { contains: "Anime", mode: "insensitive" },
    },
    select: { id: true, title: true, genres: true },
  });

  console.log(`[Sanitize] Obras no-anime con 'Anime' restante en genres: ${strayAnimeGenres.length}`);
  for (const show of strayAnimeGenres) {
    const cleaned = show.genres
      .split(",")
      .map((g) => g.trim())
      .filter((g) => !/^anime$/i.test(g))
      .join(", ") || "General";

    await prisma.show.update({
      where: { id: show.id },
      data: { genres: cleaned },
    });
  }

  // 4. Limpiar MediaItems que tengan kind = 'anime' pero provengan de fuentes no-anime
  const animeMediaItems = await prisma.mediaItem.findMany({
    where: { kind: "anime" },
    select: {
      id: true,
      title: true,
      normalized_title: true,
      year: true,
      tmdb_id: true,
      episodes: {
        select: {
          id: true,
          season_number: true,
          episode_number: true,
          links: { select: { id: true, source_site: true } },
        },
      },
    },
  });

  let mediaItemFixedCount = 0;
  for (const item of animeMediaItems) {
    const sites = item.episodes.flatMap((e) => e.links.map((l) => (l.source_site || "").toLowerCase()));
    const hasAnimeSource = sites.some((s) => Array.from(ANIME_SOURCES).some((as) => s.includes(as)));
    
    if (sites.length > 0 && !hasAnimeSource) {
      const isSeries = item.episodes.length > 1;
      const targetKind = isSeries ? "series" : "movie";

      // Verificar si ya existe un MediaItem con (normalized_title, targetKind, year)
      const existing = await prisma.mediaItem.findFirst({
        where: {
          normalized_title: item.normalized_title,
          kind: targetKind,
          year: item.year,
        },
        include: { episodes: { include: { links: true } } },
      });

      if (existing && existing.id !== item.id) {
        // Mover los enlaces de item a existing
        for (const ep of item.episodes) {
          let destEp = existing.episodes.find(
            (e) => e.season_number === ep.season_number && e.episode_number === ep.episode_number
          );
          if (!destEp) {
            destEp = await prisma.mediaEpisode.create({
              data: {
                media_item_id: existing.id,
                season_number: ep.season_number,
                episode_number: ep.episode_number,
              },
              include: { links: true },
            });
          }
          for (const link of ep.links) {
            try {
              await prisma.sourceLink.update({
                where: { id: link.id },
                data: { media_episode_id: destEp.id },
              });
            } catch {
              await prisma.sourceLink.delete({ where: { id: link.id } }).catch(() => {});
            }
          }
        }
        // Eliminar el MediaItem huérfano
        await prisma.mediaItem.delete({ where: { id: item.id } });
      } else {
        await prisma.mediaItem.update({
          where: { id: item.id },
          data: { kind: targetKind },
        });
      }
      mediaItemFixedCount++;
    }
  }
  console.log(`[Sanitize] MediaItems corregidos de anime a movie/series: ${mediaItemFixedCount}`);

  // 5. Conteo final de validación
  const finalAnimeCount = await prisma.show.count({ where: { category: "anime" } });
  const finalMovieCount = await prisma.show.count({ where: { category: "movie" } });
  const finalSeriesCount = await prisma.show.count({ where: { category: "series" } });

  console.log(`[Sanitize] Conteo final Shows: Anime=${finalAnimeCount}, Movie=${finalMovieCount}, Series=${finalSeriesCount}`);
  await prisma.$disconnect();
}

sanitizeCatalog().catch((e) => {
  console.error("[Sanitize] Error:", e);
  process.exit(1);
});
