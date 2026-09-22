import { Router, Response } from "express";
import { prisma } from "./db";
import { optionalAuth, AuthRequest } from "./auth";
import { getPublicCatalog } from "./publicCatalog";
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

const GENRE_MAP: Record<string, number> = {
  accion: 28,
  action: 28,
  aventura: 12,
  adventure: 12,
  animacion: 16,
  animation: 16,
  anime: 16,
  comedia: 35,
  comedy: 35,
  crimen: 80,
  crime: 80,
  documental: 99,
  documentary: 99,
  drama: 18,
  familia: 10751,
  familiar: 10751,
  family: 10751,
  fantasia: 14,
  fantasy: 14,
  historia: 36,
  history: 36,
  terror: 27,
  horror: 27,
  musica: 10402,
  music: 10402,
  misterio: 9648,
  mystery: 9648,
  romance: 10749,
  "ciencia ficcion": 878,
  "sci-fi": 878,
  "science fiction": 878,
  suspenso: 53,
  thriller: 53,
  belica: 10752,
  guerra: 10752,
  war: 10752,
  western: 37,
};

function normalizeGenre(g: string): string {
  return g
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function genreNameToTmdbId(genreName: string): number | null {
  const norm = normalizeGenre(genreName);
  return GENRE_MAP[norm] || null;
}

/**
 * GET /api/recommendations
 * Devuelve rieles de recomendaciones personalizadas basadas en el historial del usuario o tendencias TMDB.
 */
recommendationsRouter.get("/", optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
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

      const recencyWeight = Math.max(0.2, 1.0 - index * 0.03);
      const progressWeight = Math.max(0.5, (item.progress_percent || 50) / 100);
      const itemWeight = recencyWeight * progressWeight;

      if (show.category) {
        const cat = show.category.toLowerCase();
        categoryScores[cat] = (categoryScores[cat] || 0) + itemWeight * 2;
      }

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

    const topGenres = Object.entries(genreScores)
      .sort((a, b) => b[1] - a[1])
      .map(([genre]) => genre);

    const lastWatchedItem = watchHistory[0];
    const lastWatchedShow = lastWatchedItem ? watchedShowMap.get(lastWatchedItem.show_id) : null;

    const primaryGenre = topGenres[0] || "Acción";
    const secondaryGenre = topGenres[1] || "Aventura";
    const thirdGenre = topGenres[2] || "Comedia";

    const primaryGenreId = genreNameToTmdbId(primaryGenre);
    const secondaryGenreId = genreNameToTmdbId(secondaryGenre);
    const thirdGenreId = genreNameToTmdbId(thirdGenre);

    // Fetch rich recommendations from canonical TMDB
    const [tmdbForYouRes, tmdbTopGenreRes, tmdbDiscoveryRes, tmdbAnimeRes] = await Promise.all([
      getPublicCatalog({
        kind: "all",
        genre: primaryGenreId || undefined,
        mode: primaryGenreId ? "discover" : "trending",
        limit: 24,
      }),
      getPublicCatalog({
        kind: "movie",
        genre: secondaryGenreId || primaryGenreId || undefined,
        mode: "discover",
        limit: 24,
      }),
      getPublicCatalog({
        kind: "series",
        genre: thirdGenreId || secondaryGenreId || undefined,
        mode: "discover",
        limit: 24,
      }),
      getPublicCatalog({
        kind: "anime",
        mode: "discover",
        limit: 24,
      }),
    ]);

    const forYouShows = tmdbForYouRes.shows || [];
    const topGenreShows = tmdbTopGenreRes.shows || [];
    const discoveryShows = tmdbDiscoveryRes.shows || [];
    const animeShows = tmdbAnimeRes.shows || [];

    const rails: RecommendedRail[] = [];

    if (forYouShows.length > 0) {
      rails.push({
        id: "for-you",
        title: "Recomendados para ti",
        subtitle: `Basado en tu interés en ${primaryGenre}`,
        reason: "top_affinity",
        shows: forYouShows.slice(0, 20),
      });
    }

    if (lastWatchedShow) {
      rails.push({
        id: `because-${lastWatchedShow.id}`,
        title: `Porque viste ${lastWatchedShow.title}`,
        reason: "because_watched",
        shows: topGenreShows.slice(0, 20),
      });
    } else if (topGenreShows.length > 0) {
      rails.push({
        id: "top-genre-rail",
        title: `Lo mejor de ${secondaryGenre || primaryGenre}`,
        shows: topGenreShows.slice(0, 20),
      });
    }

    if (discoveryShows.length > 0) {
      rails.push({
        id: "discovery",
        title: "Descubre algo nuevo",
        subtitle: `Historias y series de ${thirdGenre || "gran audiencia"}`,
        reason: "discovery",
        shows: discoveryShows.slice(0, 20),
      });
    }

    if (animeShows.length > 0) {
      rails.push({
        id: "anime-destacado",
        title: "Anime Destacado",
        subtitle: "Animación recomendada",
        shows: animeShows.slice(0, 20),
      });
    }

    const heroCandidate = forYouShows.find(
      (s: any) => (s.backdrop_path || s.backdrop_url) && Number(s.rating || 0) >= 7.0
    ) || forYouShows[0] || null;

    return res.json({
      hero: heroCandidate,
      rails: dedupeRecommendationRails(rails),
    });
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
    const [trendingRes, moviesRes, seriesRes, animeRes] = await Promise.all([
      getPublicCatalog({ kind: "all", mode: "trending", limit: 24 }),
      getPublicCatalog({ kind: "movie", mode: "trending", limit: 24 }),
      getPublicCatalog({ kind: "series", mode: "trending", limit: 24 }),
      getPublicCatalog({ kind: "anime", mode: "discover", limit: 24 }),
    ]);

    const trendingShows = trendingRes.shows || [];
    const movieShows = moviesRes.shows || [];
    const seriesShows = seriesRes.shows || [];
    const animeShows = animeRes.shows || [];

    const heroCandidate = trendingShows.find(
      (s: any) => (s.backdrop_path || s.backdrop_url) && Number(s.rating || 0) >= 7.0
    ) || trendingShows[0] || null;

    const rails: RecommendedRail[] = [
      {
        id: "trending-guest",
        title: "Tendencias Globales",
        subtitle: "Lo más popular de la semana",
        shows: trendingShows,
      },
      {
        id: "movies-guest",
        title: "Películas Populares",
        subtitle: "Los mejores estrenos y éxitos de taquilla",
        shows: movieShows,
      },
      {
        id: "series-guest",
        title: "Series Aclamadas",
        subtitle: "Maratones recomendadas",
        shows: seriesShows,
      },
      {
        id: "anime-guest",
        title: "Anime Destacado",
        subtitle: "Grandes producciones de animación",
        shows: animeShows,
      },
    ];

    return {
      hero: heroCandidate,
      rails: dedupeRecommendationRails(rails),
    };
  } catch (error) {
    console.error("Error al obtener recomendaciones de invitado:", error);
    return { hero: null, rails: [] };
  }
}

export { recommendationsRouter };
