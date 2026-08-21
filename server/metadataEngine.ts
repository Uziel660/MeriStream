import sanitizeHtml from 'sanitize-html';
import { ContentKind } from "./types";

export interface EnrichedMetadata {
  title: string;
  original_title?: string | null;
  japanese_title?: string | null;
  english_title?: string | null;
  description: string;
  poster_url: string | null;
  banner_url: string | null;
  rating: number;
  year: number;
  status: string;
  genres: string[];
  content_type: ContentKind;
  suggested_episodes?: Array<{ number: number; title: string; url?: string }>;
  mal_id?: number | null;
}

export function cleanQueryTitle(raw: string): string {
  let title = raw.trim();
  title = title.replace(/^(?:Ver\s+Online|Ver|Pelicula|Película|Serie|Anime|Ova|Donghua|Watch|Full\s+Movie)\s+/i, "");
  title = title.replace(/\s*\(TV\)/i, "");
  title = title.replace(/\s*\([^)]*\)|\s*\[[^\]]*\]|\s*\{[^}]*\}/g, "");
  title = title.replace(/\s*(?:Sub\s*Español|Audio\s*Latino|Latino|Castellano|Dual|1080p|720p|4K|HD|Full\s*HD|Online|Gratis|Free|Episodio\s*\d+|Capitulo\s*\d+|Cap\s*\d+|S\d+E\d+).*$/i, "");
  title = title.replace(/\s+[-|—]\s*$/, "");
  title = title.split(/\s+[-|—]\s+/)[0].trim();
  return title.trim();
}

const GENERIC_TITLES = new Set([
  "anime", "anime online", "ver anime", "ver anime online", "contenido", "catalogo", "catálogo",
  "directorio", "pagina", "página", "movies", "series", "inicio", "home",
  "lista", "list", "animes", "pelicula", "películas", "movie", "tv", "show", "watch", "online",
]);

function isGenericQuery(lower: string): boolean {
  return (
    GENERIC_TITLES.has(lower) ||
    lower.length < 3 ||
    /^page\s*\d+$/i.test(lower) ||
    lower.startsWith("page ") ||
    lower.includes("pagina ")
  );
}

function buildDefaultMetadata(cleaned: string, rawQuery: string, hintKind?: ContentKind, genres: string[] = ["Multimedia"]): EnrichedMetadata {
  return {
    title: cleaned || rawQuery || "Contenido Multimedia",
    description: "Contenido indexado en VoidStream con reproductor Just-In-Time.",
    poster_url: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800&q=80",
    banner_url: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1600&q=80",
    rating: 8.0,
    year: new Date().getFullYear(),
    status: "Finalizado",
    genres,
    content_type: hintKind || "anime",
  };
}

/**
 * Enriches metadata across multiple engines (TVMaze, Jikan MAL, Kitsu, Internet Archive, Wikipedia)
 */

  const createAnimeResponse = (title: string, poster: string, cover: string, status: string, attr: any) => {
    return {
      title: attr.canonicalTitle || attr.titles?.en_jp || attr.titles?.en || title,
      original_title: attr.titles?.ja_jp || undefined,
      description: attr.synopsis ? sanitizeHtml(attr.synopsis, { allowedTags: [] }).replace(/<[^>]*>?/gm, "").trim() : "Sin descripción disponible.",
      poster_url: poster,
      banner_url: cover,
      rating: attr.averageRating ? Math.round((Number.parseFloat(attr.averageRating) / 10) * 10) / 10 : 8.0,
      year: attr.startDate ? Number.parseInt(attr.startDate.slice(0, 4), 10) : 2024,
      status: status === "current" ? "En emisión" : "Finalizado",
      genres: ["Anime"],
      content_type: "anime" as ContentKind,
    };
  };


// --- TMDB API (Movies, TV Series, Anime fallback) ---
async function fetchTMDBMetadata(query: string, kind?: ContentKind): Promise<EnrichedMetadata | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    // Use multi search to get movies or tv shows
    const res = await fetch(`https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&language=es-MX&api_key=${apiKey}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      const data: any = await res.json();
      if (data && data.results && data.results.length > 0) {
        // Filter out people, prefer what matches the kind if provided
        let bestResult = data.results.find((r: any) => r.media_type !== 'person');
        if (kind === 'movie') {
            bestResult = data.results.find((r: any) => r.media_type === 'movie') || bestResult;
        } else if (kind === 'series' || kind === 'anime') {
            bestResult = data.results.find((r: any) => r.media_type === 'tv') || bestResult;
        }

        if (bestResult) {
            const isTV = bestResult.media_type === 'tv';
            const title = bestResult.title || bestResult.name || query;
            const originalTitle = bestResult.original_title || bestResult.original_name || title;
            const overview = (bestResult.overview || "").replace(/<[^>]*>?/gm, "").trim() || "Sin descripción disponible.";

            const poster = bestResult.poster_path ? `https://image.tmdb.org/t/p/w780${bestResult.poster_path}` : null;
            const banner = bestResult.backdrop_path ? `https://image.tmdb.org/t/p/w1280${bestResult.backdrop_path}` : poster;

            const yearStr = bestResult.release_date || bestResult.first_air_date || "";
            const year = yearStr ? parseInt(yearStr.substring(0, 4), 10) : new Date().getFullYear();

            const rating = bestResult.vote_average ? Math.round(bestResult.vote_average * 10) / 10 : 8.0;

            let contentType: ContentKind = kind || (isTV ? "series" : "movie");
            // If it's TV and originating from Japan (usually anime)
            if (isTV && bestResult.origin_country && bestResult.origin_country.includes('JP')) {
                contentType = "anime";
            }

            return {
                title,
                original_title: originalTitle,
                description: overview,
                poster_url: poster,
                banner_url: banner,
                rating,
                year,
                status: "Finalizado", // TMDB search doesn't give status directly without another fetch
                genres: [isTV ? "Serie de TV" : "Película"], // Basic fallback, getting real genres requires fetching genre list or details
                content_type: contentType
            };
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function enrichUniversalMetadata(
  rawQuery: string,
  hintKind?: ContentKind
): Promise<EnrichedMetadata> {
  const cleaned = cleanQueryTitle(rawQuery);
  const lower = cleaned.toLowerCase();

  // 1. TMDB (Primary source, enforcing es-MX)
  const tmdbData = await fetchTMDBMetadata(cleaned, hintKind);
  if (tmdbData) return tmdbData;


  // If query is a generic placeholder or page number, do NOT query external APIs to prevent false matches (e.g. Little Witch Academia)
  if (isGenericQuery(lower)) {
    return buildDefaultMetadata(cleaned, rawQuery, hintKind, ["Multimedia"]);
  }

  // If hint is archive or query mentions archive/classic/dominio publico
  if (hintKind === "open_archive" || lower.includes("archive.org") || lower.includes("dominio publico")) {
    const archiveMeta = await fetchArchiveOrgMetadata(cleaned);
    if (archiveMeta) return archiveMeta;
  }

  // 1. If hint is anime or general query, try Anime engines first (Jikan MAL / Kitsu)
  if (hintKind === "anime" || !hintKind) {
    const animeMeta = await fetchAnimeMetadata(cleaned);
    if (animeMeta && (animeMeta.rating > 0 || hintKind === "anime")) {
      return animeMeta;
    }
  }

  // 2. Try TVMaze API (Series, Dramas, Cartoons, TV shows)
  if (hintKind === "series" || hintKind === "movie" || !hintKind) {
    const tvMeta = await fetchTVMazeMetadata(cleaned);
    if (tvMeta) {
      if (hintKind) tvMeta.content_type = hintKind;
      return tvMeta;
    }
  }

  // 3. Try Internet Archive open database
  const archiveMeta = await fetchArchiveOrgMetadata(cleaned);
  if (archiveMeta) return archiveMeta;

  // 4. Try Wikipedia summary API
  const wikiMeta = await fetchWikipediaMetadata(cleaned);
  if (wikiMeta) return wikiMeta;

  // Fallback defaults
  return buildDefaultMetadata(cleaned, rawQuery, hintKind, ["Acción", "Aventura"]);
}

// --- AniList, Kitsu & Jikan MAL Anime Enricher ---
async function fetchAnimeMetadata(query: string): Promise<EnrichedMetadata | null> {
  // Strip season suffixes (e.g., "3rd Season", "Season 2", "Part 2", "II") for better search accuracy
  const simplifiedQuery = query
    .replace(/\s*(?:\d+(?:st|nd|rd|th)\s+Season|Season\s+\d+|Part\s+\d+|\b[IVXLCDM]+\b)/gi, "")
    .replace(/\s*\([^)]*\)|\s*\[[^\]]*\]|\s*\{[^}]*\}/g, "")
    .replace(/[-_]/g, " ")
    .trim();

  const searchQuery = simplifiedQuery.length >= 3 ? simplifiedQuery : query;

  // 1. AniList GraphQL API (Primary & Fast <200ms)
  try {
    const graphqlQuery = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          id
          title {
            romaji
            english
            native
          }
          description(asHtml: false)
          coverImage {
            extraLarge
            large
          }
          bannerImage
          averageScore
          startDate {
            year
          }
          status
          genres
          episodes
        }
      }
    `;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: graphqlQuery, variables: { search: searchQuery } }),
    });
    clearTimeout(timer);

    if (res.ok) {
      const data: any = await res.json();
      const media = data?.data?.Media;
      if (media) {
        const poster = media.coverImage?.extraLarge || media.coverImage?.large || null;
        const banner = media.bannerImage || poster;
        const cleanDesc = (media.description || "")
          .replace(/<[^>]*>?/gm, "")
          .replace(/\n\s*\n/g, "\n")
          .trim();

        return {
          title: media.title?.romaji || media.title?.english || query,
          original_title: media.title?.native || media.title?.romaji,
          japanese_title: media.title?.native || undefined,
          english_title: media.title?.english || undefined,
          description: cleanDesc || "Sin descripción disponible.",
          poster_url: poster,
          banner_url: banner,
          rating: media.averageScore ? Math.round((media.averageScore / 10) * 10) / 10 : 8.2,
          year: media.startDate?.year || 2024,
          status: media.status === "RELEASING" ? "En emisión" : "Finalizado",
          genres: Array.isArray(media.genres) && media.genres.length > 0 ? media.genres : ["Anime"],
          content_type: "anime",
        };
      }
    }
  } catch {
    // ignore, try fallbacks
  }

  // 2. Kitsu API fallback
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchQuery)}&page[limit]=1`, {
      signal: controller.signal,
      headers: {
        "User-Agent": "VoidStream-Universal-Scraper/2.5",
        Accept: "application/vnd.api+json",
      },
    });
    clearTimeout(timer);

    if (res.ok) {
      const json: any = await res.json();
      if (json?.data && json.data.length > 0) {
        const attr = json.data[0].attributes || {};
        const poster = attr.posterImage?.large || attr.posterImage?.original || attr.posterImage?.medium;
        const cover = attr.coverImage?.large || attr.coverImage?.original || poster;

        return {
          title: attr.canonicalTitle || query,
          original_title: attr.titles?.ja_jp,
          japanese_title: attr.titles?.ja_jp || undefined,
          english_title: attr.titles?.en || undefined,
          description: attr.synopsis ? sanitizeHtml(attr.synopsis, { allowedTags: [] }).trim() : "Sin descripción disponible.",
          poster_url: poster,
          banner_url: cover,
          rating: attr.averageRating ? Math.round((Number.parseFloat(attr.averageRating) / 10) * 10) / 10 : 8.0,
          year: attr.startDate ? Number.parseInt(attr.startDate.slice(0, 4), 10) : 2024,
          status: attr.status === "current" ? "En emisión" : "Finalizado",
          genres: ["Anime"],
          content_type: "anime",
        };
      }
    }
  } catch {
    // ignore
  }

  // 3. Jikan MAL API fallback
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(searchQuery)}&limit=1`, {
      signal: controller.signal,
      headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" },
    });
    clearTimeout(timer);

    if (res.ok) {
      const json: any = await res.json();
      if (json?.data && json.data.length > 0) {
        const item = json.data[0];
        const poster = item.images?.webp?.large_image_url || item.images?.jpg?.large_image_url || item.images?.jpg?.image_url;
        const genres = Array.isArray(item.genres) ? item.genres.map((g: any) => g.name) : ["Anime"];

        return {
          title: item.title || query,
          original_title: item.title_japanese || item.title,
          japanese_title: item.title_japanese || undefined,
          english_title: item.title_english || undefined,
          description: item.synopsis ? sanitizeHtml(item.synopsis, { allowedTags: [] }).replace(/<[^>]*>?/gm, "").trim() : "Sin descripción disponible.",
          poster_url: poster,
          banner_url: poster,
          rating: item.score || 8.2,
          year: item.year || item.aired?.prop?.from?.year || 2024,
          status: item.status === "Currently Airing" ? "En emisión" : "Finalizado",
          genres,
          content_type: "anime",
          mal_id: item.mal_id,
        };
      }
    }
  } catch {
    // ignore
  }

  return null;
}

// --- TVMaze API (Movies, TV Series, Shows with full episode trees) ---
async function fetchTVMazeMetadata(query: string): Promise<EnrichedMetadata | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}&embed=episodes`, {
      signal: controller.signal,
      headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" },
    });
    clearTimeout(timer);

    if (res.ok) {
      const show: any = await res.json();
      if (show && show.name) {
        const poster = show.image?.original || show.image?.medium || null;
        const cleanSummary = sanitizeHtml((show.summary || ""), { allowedTags: [] }).replace(/<[^>]*>?/gm, "").trim();
        const year = show.premiered ? Number.parseInt(show.premiered.slice(0, 4), 10) : 2023;
        const isAnime = (show.type || "").toLowerCase() === "animation" && (show.genres || []).includes("Anime");

        const suggested_episodes = (show._embedded?.episodes || []).map((ep: any) => ({
          number: ep.number || 1,
          title: `T${ep.season || 1}E${ep.number || 1}: ${ep.name || "Episodio"}`,
          url: ep.url || undefined,
        }));

        return {
          title: show.name,
          original_title: show.name,
          description: cleanSummary || "Serie de televisión indexada con éxito.",
          poster_url: poster,
          banner_url: poster,
          rating: show.rating?.average || 8.2,
          year,
          status: show.status === "Running" ? "En emisión" : "Finalizado",
          genres: show.genres?.length > 0 ? show.genres : ["Serie de TV", "Drama"],
          content_type: isAnime ? "anime" : (show.type === "Scripted" || show.type === "Reality" ? "series" : "movie"),
          suggested_episodes: suggested_episodes.length > 0 ? suggested_episodes.slice(0, 30) : undefined,
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- Internet Archive (Archive.org) Open Domain & Classic Cinema API ---
async function fetchArchiveOrgMetadata(query: string): Promise<EnrichedMetadata | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:(movies)&fl[]=identifier,title,description,year,publicdate&sort[]=&rows=1&page=1&output=json`;
    const res = await fetch(searchUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      const data: any = await res.json();
      const doc = data?.response?.docs?.[0];
      if (doc && doc.identifier) {
        const id = doc.identifier;
        const poster = `https://archive.org/services/img/${id}`;
        const streamMp4 = `https://archive.org/download/${id}/${id}.mp4`;

        return {
          title: doc.title || query,
          original_title: doc.title,
          description: doc.description ? sanitizeHtml(doc.description, { allowedTags: [] }).replace(/<[^>]*>?/gm, "").slice(0, 400) : "Película u obra audiovisual de libre acceso en Internet Archive.",
          poster_url: poster,
          banner_url: poster,
          rating: 8.5,
          year: doc.year ? Number.parseInt(doc.year, 10) : 1970,
          status: "Dominio Público",
          genres: ["Clásico", "Dominio Público", "Cine de Culto"],
          content_type: "open_archive",
          suggested_episodes: [
            {
              number: 1,
              title: `${doc.title || "Película Completa"} [Archive.org HD]`,
              url: streamMp4,
            },
          ],
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- Wikipedia Metadata API ---
async function fetchWikipediaMetadata(query: string): Promise<EnrichedMetadata | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" },
    });
    clearTimeout(timer);

    if (res.ok) {
      const page: any = await res.json();
      if (page && page.title && page.extract) {
        return {
          title: page.title,
          description: typeof page.extract === "string" ? page.extract.replace(/<[^>]*>?/gm, "") : page.extract,
          poster_url: page.thumbnail?.source || page.originalimage?.source || null,
          banner_url: page.originalimage?.source || page.thumbnail?.source || null,
          rating: 8.0,
          year: new Date().getFullYear(),
          status: "Finalizado",
          genres: ["Película / Obra"],
          content_type: "movie",
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}
