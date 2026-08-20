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
  title = title.replace(/^(?:Ver|Ver\s+Online|Pelicula|Película|Serie|Anime|Ova|Donghua|Watch|Full\s+Movie)\s+/i, "");
  title = title.replace(/\s*(?:Sub\s*Español|Audio\s*Latino|Latino|Castellano|Dual|1080p|720p|4K|HD|Full\s*HD|Online|Gratis|Free|Episodio\s*\d+|Capitulo\s*\d+|Cap\s*\d+|S\d+E\d+).*$/i, "");
  title = title.replace(/\s*\(TV\)/i, "");
  title = title.replace(/[\(\[\{].*?[\)\]\}]/g, "");
  title = title.split(/\s+[-|—]\s+/)[0].trim();
  return title.trim();
}

/**
 * Enriches metadata across multiple engines (TVMaze, Jikan MAL, Kitsu, Internet Archive, Wikipedia)
 */
export async function enrichUniversalMetadata(
  rawQuery: string,
  hintKind?: ContentKind
): Promise<EnrichedMetadata> {
  const cleaned = cleanQueryTitle(rawQuery);
  const lower = cleaned.toLowerCase();

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
  return {
    title: cleaned || rawQuery || "Contenido Multimedia",
    description: "Contenido indexado en VoidStream con reproductor Just-In-Time.",
    poster_url: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800&q=80",
    banner_url: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1600&q=80",
    rating: 8.0,
    year: new Date().getFullYear(),
    status: "Finalizado",
    genres: ["Acción", "Aventura"],
    content_type: hintKind || "anime",
  };
}

// --- Jikan MAL & Kitsu Anime Enricher ---
async function fetchAnimeMetadata(query: string): Promise<EnrichedMetadata | null> {
  // 1. Jikan API
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1`, {
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
        const epCount = item.episodes || 12;
        const suggested_episodes = [];
        for (let i = 1; i <= Math.min(epCount, 24); i++) {
          suggested_episodes.push({
            number: i,
            title: `Episodio ${i}`,
          });
        }

        return {
          title: item.title || query,
          original_title: item.title_japanese || item.title,
          japanese_title: item.title_japanese,
          english_title: item.title_english,
          description: item.synopsis || "Sin descripción disponible.",
          poster_url: poster,
          banner_url: poster,
          rating: item.score || 8.2,
          year: item.year || item.aired?.prop?.from?.year || 2023,
          status: item.status === "Currently Airing" ? "En emisión" : "Finalizado",
          genres,
          content_type: "anime",
          suggested_episodes,
          mal_id: item.mal_id,
        };
      }
    }
  } catch {
    // ignore
  }

  // 2. Kitsu API fallback
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=1`, {
      signal: controller.signal,
      headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" },
    });
    clearTimeout(timer);

    if (res.ok) {
      const json: any = await res.json();
      if (json?.data && json.data.length > 0) {
        const attr = json.data[0].attributes || {};
        const poster = attr.posterImage?.large || attr.posterImage?.original || attr.posterImage?.medium;
        const cover = attr.coverImage?.large || attr.coverImage?.original || poster;
        const epCount = attr.episodeCount || 12;
        const suggested_episodes = [];
        for (let i = 1; i <= Math.min(epCount, 24); i++) {
          suggested_episodes.push({
            number: i,
            title: `Episodio ${i}`,
          });
        }

        return {
          title: attr.canonicalTitle || query,
          original_title: attr.titles?.ja_jp,
          japanese_title: attr.titles?.ja_jp,
          english_title: attr.titles?.en,
          description: attr.synopsis || "Sin descripción disponible.",
          poster_url: poster,
          banner_url: cover,
          rating: attr.averageRating ? parseFloat(attr.averageRating) / 10 : 8.0,
          year: attr.startDate ? parseInt(attr.startDate.slice(0, 4), 10) : 2024,
          status: attr.status === "current" ? "En emisión" : "Finalizado",
          genres: ["Anime"],
          content_type: "anime",
          suggested_episodes,
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
        const cleanSummary = (show.summary || "").replace(/<[^>]+>/g, "").trim();
        const year = show.premiered ? parseInt(show.premiered.slice(0, 4), 10) : 2023;
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
          description: doc.description ? doc.description.replace(/<[^>]+>/g, "").slice(0, 400) : "Película u obra audiovisual de libre acceso en Internet Archive.",
          poster_url: poster,
          banner_url: poster,
          rating: 8.5,
          year: doc.year ? parseInt(doc.year, 10) : 1970,
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
          description: page.extract,
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
