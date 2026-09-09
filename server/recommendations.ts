import { Router, Response } from "express";
import { prisma } from "./db";
import { optionalAuth, AuthRequest } from "./auth";
import { filterShowsToMainPath } from "./showService";
import { repairTmdbPosters } from "./publicCatalog";
import { catalogIdentityKey } from "./catalogDedup";

const recommendationsRouter = Router();

interface RecommendedRail {
  id: string;
  title: string;
  subtitle?: string;
  reason?: string;
  shows: any[];
}

function recommendationIdentity(show: any): string {
  const tmdbId = Number(show?.tmdb_id);
  if (Number.isInteger(tmdbId) && tmdbId > 0) {
    const category = String(show?.category || show?.kind || "").toLowerCase();
    const family = /movie|pel[ií]cula|film/.test(category) ? "movie" : "tv";
    return `tmdb-recommendation:${family}:${tmdbId}`;
  }
  return catalogIdentityKey(show) || `id:${String(show?.id || "")}`;
}

/** Keep recommendation rails disjoint before they reach any client surface. */
function dedupeRecommendationRails(rails: RecommendedRail[]): RecommendedRail[] {
  const used = new Set<string>();
  return rails
    .map((rail) => ({
      ...rail,
      shows: rail.shows.filter((show) => {
        const key = recommendationIdentity(show);
        if (used.has(key)) return false;
        used.add(key);
        return true;
      }),
    }))
    .filter((rail) => rail.shows.length > 0);
}

/**
 * GET /api/recommendations
 * Devuelve rieles de recomendaciones personalizadas basadas en el historial del usuario.
 */
recommendationsRouter.get("/", optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      // Usuario no autenticado: devolver rieles populares/tendencia de arranque
      const guestData = await getGuestRecommendations();
      return res.json(guestData);
    }

    // 1. Obtener historial de visualización del usuario
    const watchHistory = await prisma.watchProgress.findMany({
      where: { user_id: userId },
      orderBy: { last_watched_at: "desc" },
      take: 40,
    });

    if (watchHistory.length === 0) {
      // Usuario nuevo sin historial: devolver recomendaciones de bienvenida
      const guestData = await getGuestRecommendations();
      return res.json(guestData);
    }

    // 2. Obtener los shows vistos para extraer géneros y preferencias
    const watchedShowIds = Array.from(new Set(watchHistory.map((w) => w.show_id)));
    const watchedShows = await prisma.show.findMany({
      where: { id: { in: watchedShowIds } },
      select: { id: true, title: true, genres: true, category: true, rating: true },
    });

    const watchedShowMap = new Map(watchedShows.map((s) => [s.id, s]));

    // 3. Calcular ponderación de géneros y categorías con decaimiento temporal
    const genreScores: Record<string, number> = {};
    const categoryScores: Record<string, number> = {};

    watchHistory.forEach((item, index) => {
      const show = watchedShowMap.get(item.show_id);
      if (!show) return;

      // Más reciente = mayor peso (factor de 1.0 a 0.2)
      const recencyWeight = Math.max(0.2, 1.0 - index * 0.03);
      // Mayor progreso visto = mayor afinidad
      const progressWeight = Math.max(0.5, (item.progress_percent || 50) / 100);
      const itemWeight = recencyWeight * progressWeight;

      // Ponderar categoría
      if (show.category) {
        const cat = show.category.toLowerCase();
        categoryScores[cat] = (categoryScores[cat] || 0) + itemWeight * 2;
      }

      // Ponderar géneros
      if (show.genres) {
        const genres = show.genres.split(/[,/|•]+/).map((g) => g.trim()).filter(Boolean);
        genres.forEach((g) => {
          if (g.length > 2 && !/multimedia|general/i.test(g)) {
            const cleanGenre = g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
            genreScores[cleanGenre] = (genreScores[cleanGenre] || 0) + itemWeight;
          }
        });
      }
    });

    // Ordenar géneros por puntaje
    const topGenres = Object.entries(genreScores)
      .sort((a, b) => b[1] - a[1])
      .map(([genre]) => genre);

    // Obtener el último show visto con información completa
    const lastWatchedItem = watchHistory[0];
    const lastWatchedShow = lastWatchedItem ? watchedShowMap.get(lastWatchedItem.show_id) : null;

    // 4. Generar candidatos de la base de datos (excluyendo los ya vistos)
    const primaryGenre = topGenres[0] || "Acción";
    const secondaryGenre = topGenres[1] || "Aventura";
    const thirdGenre = topGenres[2] || "Comedia";

    // A. "Recomendados para ti" (coincidencia con top géneros)
    const personalizedShows = await prisma.show.findMany({
      where: {
        id: { notIn: watchedShowIds },
        OR: [
          { genres: { contains: primaryGenre, mode: "insensitive" } },
          { genres: { contains: secondaryGenre, mode: "insensitive" } },
        ],
      },
      orderBy: [{ rating: "desc" }, { year: "desc" }],
      take: 24,
    });

    // B. "Porque viste [Último Show]"
    let becauseYouWatchedShows: any[] = [];
    if (lastWatchedShow && lastWatchedShow.genres) {
      const lastGenres = lastWatchedShow.genres.split(/[,/|•]+/).map((g) => g.trim()).filter((g) => g.length > 2);
      const matchGenre = lastGenres[0] || primaryGenre;

      becauseYouWatchedShows = await prisma.show.findMany({
        where: {
          id: { notIn: [...watchedShowIds, lastWatchedShow.id] },
          genres: { contains: matchGenre, mode: "insensitive" },
        },
        orderBy: [{ rating: "desc" }, { year: "desc" }],
        take: 20,
      });
    }

    // C. "Joyas mejor valoradas en tus géneros favoritos"
    const topRatedGenreShows = await prisma.show.findMany({
      where: {
        id: { notIn: watchedShowIds },
        rating: { gte: 8.0 },
        OR: [
          { genres: { contains: primaryGenre, mode: "insensitive" } },
          { genres: { contains: secondaryGenre, mode: "insensitive" } },
          { genres: { contains: thirdGenre, mode: "insensitive" } },
        ],
      },
      orderBy: { rating: "desc" },
      take: 20,
    });

    // D. "Explora nuevos horizontes" (descubrimiento con alta valoración)
    const discoveryShows = await prisma.show.findMany({
      where: {
        id: { notIn: watchedShowIds },
        rating: { gte: 7.8 },
        NOT: {
          genres: {
            contains: primaryGenre,
            mode: "insensitive",
          },
        },
      },
      orderBy: { year: "desc" },
      take: 20,
    });

    const recommendedCandidates = [
      ...personalizedShows,
      ...becauseYouWatchedShows,
      ...topRatedGenreShows,
      ...discoveryShows,
    ];
    const repairedRecommended = await repairTmdbPosters(recommendedCandidates as any[]);
    const repairedById = new Map(repairedRecommended.map((show: any) => [show.id, show]));
    const playableRecommended = await filterShowsToMainPath(repairedRecommended as any[]);
    const playableRecommendedIds = new Set(playableRecommended.map((show) => show.id));
    const visible = (items: any[]) => items
      .filter((show) => playableRecommendedIds.has(show.id))
      .map((show) => repairedById.get(show.id) || show);
    const visiblePersonalized = visible(personalizedShows);
    const visibleBecauseWatched = visible(becauseYouWatchedShows);
    const visibleTopRated = visible(topRatedGenreShows);
    const visibleDiscovery = visible(discoveryShows);

    const rails: RecommendedRail[] = [];

    if (visiblePersonalized.length > 0) {
      rails.push({
        id: "for-you",
        title: "Recomendados para ti",
        reason: "top_affinity",
        shows: shuffle(visiblePersonalized).slice(0, 16),
      });
    }

    if (lastWatchedShow && visibleBecauseWatched.length > 0) {
      rails.push({
        id: `because-${lastWatchedShow.id}`,
        title: `Porque viste ${lastWatchedShow.title}`,
        reason: "because_watched",
        shows: visibleBecauseWatched.slice(0, 16),
      });
    }

    if (visibleTopRated.length > 0) {
      rails.push({
        id: "top-rated-genre",
        title: `Lo mejor de ${primaryGenre}`,
        reason: "high_rating",
        shows: visibleTopRated.slice(0, 16),
      });
    }

    if (visibleDiscovery.length > 0) {
      rails.push({
        id: "discovery",
        title: "Descubre algo nuevo",
        reason: "discovery",
        shows: shuffle(visibleDiscovery).slice(0, 16),
      });
    }

    // 5. SELECCIÓN DE LA OBRA HERO DEFINITIVA (Alta calidad visual + Máxima Afinidad)
    let heroCandidate = visiblePersonalized.find(
      (s) => (s as any).backdrop_path || (s as any).banner_url || ((s.rating || 0) >= 8.2 && s.description && s.description.length > 50)
    );

    if (!heroCandidate && visiblePersonalized.length > 0) {
      heroCandidate = visiblePersonalized[0];
    }

    if (!heroCandidate && visibleTopRated.length > 0) {
      heroCandidate = visibleTopRated[0];
    }

    return res.json({ hero: heroCandidate || null, rails: dedupeRecommendationRails(rails) });
  } catch (error: any) {
    console.error("Error al calcular recomendaciones:", error);
    return res.status(500).json({ error: "Error al generar recomendaciones: " + (error?.message || error) });
  }
});

/**
 * Recomendaciones por defecto para usuarios sin sesión o nuevos
 */
async function getGuestRecommendations(): Promise<{ hero: any | null; rails: RecommendedRail[] }> {
  try {
    const [topHeroPicks, popularAnime, topMoviesSeries, trendingAll] = await Promise.all([
      prisma.show.findMany({
        where: {
          rating: { gte: 8.2 },
          OR: [
            { backdrop_path: { not: null } },
            { banner_url: { not: null } },
          ],
        },
        orderBy: [{ rating: "desc" }, { year: "desc" }],
        take: 10,
      }),
      prisma.show.findMany({
        where: { category: "anime", rating: { gte: 7.5 } },
        orderBy: [{ rating: "desc" }, { year: "desc" }],
        take: 16,
      }),
      prisma.show.findMany({
        where: {
          category: { in: ["movie", "series", "pelicula", "peliculas", "serie"] },
          rating: { gte: 7.5 },
        },
        orderBy: [{ rating: "desc" }, { year: "desc" }],
        take: 16,
      }),
      prisma.show.findMany({
        orderBy: [{ year: "desc" }, { rating: "desc" }],
        take: 16,
      }),
    ]);

    const allCandidates = [...topHeroPicks, ...popularAnime, ...topMoviesSeries, ...trendingAll];
    const repairedCandidates = await repairTmdbPosters(allCandidates as any[]);
    const repairedById = new Map(repairedCandidates.map((show: any) => [show.id, show]));
    const playable = await filterShowsToMainPath(repairedCandidates as any[]);
    const playableIds = new Set(playable.map((show) => show.id));
    const visible = (items: any[]) => items
      .filter((show) => playableIds.has(show.id))
      .map((show) => repairedById.get(show.id) || show);
    const visibleHeroPicks = visible(topHeroPicks);
    const visibleAnime = visible(popularAnime);
    const visibleMovies = visible(topMoviesSeries);
    const visibleTrending = visible(trendingAll);
    const heroPick = visibleHeroPicks.length > 0
      ? visibleHeroPicks[Math.floor(Math.random() * Math.min(5, visibleHeroPicks.length))]
      : visibleTrending[0] || null;

    return {
      hero: heroPick,
      rails: dedupeRecommendationRails([
        {
          id: "trending-guest",
          title: "Tendencias",
          shows: visibleTrending,
        },
        {
          id: "anime-guest",
          title: "Anime Destacado",
          shows: visibleAnime,
        },
        {
          id: "movies-guest",
          title: "Películas y Series Populares",
          shows: visibleMovies,
        },
      ]),
    };
  } catch {
    return { hero: null, rails: [] };
  }
}

/**
 * Mezcla aleatoria leve para dar dinamismo a las recomendaciones
 */
function shuffle<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export { recommendationsRouter };
