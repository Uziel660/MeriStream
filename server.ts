import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { createServer as createViteServer } from "vite";
import { analyzeUniversalUrl, extractStreamFromUrl, PRESET_SOURCES } from "./server/universalScraper";
import { cleanQueryTitle } from "./server/metadataEngine";
import { taskWorker, CrawlJob } from "./server/taskWorker";

interface Episode {
  id: string;
  show_id: string;
  title: string;
  episode_number: number;
  source_url: string;
}

interface Show {
  id: string;
  mal_id?: number;
  title: string;
  japanese_title?: string;
  english_title?: string;
  description: string;
  poster_url: string;
  banner_url: string;
  category: string;
  rating: number;
  year: number;
  status: string;
  genres: string;
  episodes: Episode[];
}

interface CrawlTask {
  id: string;
  target_url: string;
  status: "pending" | "running" | "completed" | "failed";
  pages_crawled: number;
  shows_imported: number;
  episodes_imported: number;
  error_message: string | null;
  created_at: string;
  logs: string[];
}

// Initial Seed Data with reliable test streams and high-resolution posters
const initialShows: Show[] = [
  {
    id: "show-frieren",
    mal_id: 52991,
    title: "Sousou no Frieren",
    japanese_title: "葬送のフリーレン",
    english_title: "Frieren: Beyond Journey's End",
    description: "La maga elfa Frieren y sus valientes compañeros aventureros han derrotado al Rey Demonio y han traído la paz al reino. Pero cuando la misión termina, Frieren emprende un nuevo viaje de introspección para comprender los lazos humanos a través del tiempo.",
    poster_url: "https://cdn.myanimelist.net/images/anime/1015/138025l.jpg",
    banner_url: "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1600&q=80",
    category: "anime",
    rating: 9.35,
    year: 2023,
    status: "Finalizado",
    genres: "Aventura, Drama, Fantasía, Shounen",
    episodes: [
      {
        id: "ep-frieren-1",
        show_id: "show-frieren",
        title: "Episodio 1: El fin de la aventura",
        episode_number: 1,
        source_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      },
      {
        id: "ep-frieren-2",
        show_id: "show-frieren",
        title: "Episodio 2: No tenía por qué ser magia",
        episode_number: 2,
        source_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      },
      {
        id: "ep-frieren-3",
        show_id: "show-frieren",
        title: "Episodio 3: Magia para matar",
        episode_number: 3,
        source_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
      },
      {
        id: "ep-frieren-4",
        show_id: "show-frieren",
        title: "Episodio 4: La tierra donde descansan las almas",
        episode_number: 4,
        source_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
      }
    ],
  },
  {
    id: "show-aot",
    mal_id: 16498,
    title: "Shingeki no Kyojin",
    japanese_title: "進撃の巨人",
    english_title: "Attack on Titan",
    description: "Siglos atrás, la humanidad fue casi exterminada por monstruosas criaturas humanoides llamadas titanes. Los sobrevivientes se resguardaron tras gigantescas murallas, hasta que un titán colosal destruye la primera barrera y cambia el destino de Eren Jaeger.",
    poster_url: "https://cdn.myanimelist.net/images/anime/10/47347l.jpg",
    banner_url: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1600&q=80",
    category: "anime",
    rating: 8.85,
    year: 2013,
    status: "Finalizado",
    genres: "Acción, Drama, Misterio, Shounen",
    episodes: [
      {
        id: "ep-aot-1",
        show_id: "show-aot",
        title: "Episodio 1: A ti, dentro de 2000 años",
        episode_number: 1,
        source_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
      },
      {
        id: "ep-aot-2",
        show_id: "show-aot",
        title: "Episodio 2: Aquel día",
        episode_number: 2,
        source_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      },
      {
        id: "ep-aot-3",
        show_id: "show-aot",
        title: "Episodio 3: Una tenue luz en la desesperación",
        episode_number: 3,
        source_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
      }
    ],
  },
  {
    id: "show-jjk",
    mal_id: 40748,
    title: "Jujutsu Kaisen",
    japanese_title: "呪術廻戦",
    english_title: "Jujutsu Kaisen",
    description: "Yuuji Itadori es un estudiante de preparatoria que decide tragarse un talismán maldito —el dedo de Ryomen Sukuna— para salvar a sus amigos, adentrándose en el peligroso mundo de los hechiceros y las maldiciones.",
    poster_url: "https://cdn.myanimelist.net/images/anime/1171/109222l.jpg",
    banner_url: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=1600&q=80",
    category: "anime",
    rating: 8.62,
    year: 2020,
    status: "Finalizado",
    genres: "Acción, Fantasía, Sobrenatural, Shounen",
    episodes: [
      {
        id: "ep-jjk-1",
        show_id: "show-jjk",
        title: "Episodio 1: Ryomen Sukuna",
        episode_number: 1,
        source_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      },
      {
        id: "ep-jjk-2",
        show_id: "show-jjk",
        title: "Episodio 2: Por mí mismo",
        episode_number: 2,
        source_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      }
    ],
  },
  {
    id: "show-cyberpunk",
    mal_id: 42310,
    title: "Cyberpunk: Edgerunners",
    japanese_title: "サイバーパンク エッジランナーズ",
    english_title: "Cyberpunk: Edgerunners",
    description: "En una distopía plagada de corrupción y cibernética llamada Night City, un talentoso pero impulsivo chico de la calle decide convertirse en un mercenario fuera de la ley.",
    poster_url: "https://cdn.myanimelist.net/images/anime/1844/125076l.jpg",
    banner_url: "https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=1600&q=80",
    category: "anime",
    rating: 8.60,
    year: 2022,
    status: "Finalizado",
    genres: "Acción, Ciencia Ficción, Cyberpunk",
    episodes: [
      {
        id: "ep-cyber-1",
        show_id: "show-cyberpunk",
        title: "Episodio 1: Let You Down",
        episode_number: 1,
        source_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
      },
      {
        id: "ep-cyber-2",
        show_id: "show-cyberpunk",
        title: "Episodio 2: Like a Boy",
        episode_number: 2,
        source_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      }
    ],
  },
  {
    id: "show-demon-slayer",
    mal_id: 38000,
    title: "Kimetsu no Yaiba",
    japanese_title: "鬼滅の刃",
    english_title: "Demon Slayer: Kimetsu no Yaiba",
    description: "Tras una masacre brutal que acaba con casi toda su familia y convierte a su hermana menor Nezuko en demonio, Tanjiro Kamado emprende el duro camino para convertirse en cazador de demonios y devolverle la humanidad a su hermana.",
    poster_url: "https://cdn.myanimelist.net/images/anime/1286/99889l.jpg",
    banner_url: "https://images.unsplash.com/photo-1563089145-599997674d42?w=1600&q=80",
    category: "anime",
    rating: 8.48,
    year: 2019,
    status: "Finalizado",
    genres: "Acción, Fantasía, Histórico, Shounen",
    episodes: [
      {
        id: "ep-kny-1",
        show_id: "show-demon-slayer",
        title: "Episodio 1: Crueldad",
        episode_number: 1,
        source_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
      },
      {
        id: "ep-kny-2",
        show_id: "show-demon-slayer",
        title: "Episodio 2: El instructor Sakonji Urokodaki",
        episode_number: 2,
        source_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      }
    ],
  },
  {
    id: "show-solo-leveling",
    mal_id: 52299,
    title: "Solo Leveling",
    japanese_title: "俺だけレベルアップな件",
    english_title: "Solo Leveling",
    description: "En un mundo donde los cazadores con habilidades mágicas luchan contra mortales monstruos en mazmorras, Sung Jinwoo, conocido como el cazador más débil de toda la humanidad, adquiere un sistema de misiones secreto que solo él puede ver.",
    poster_url: "https://cdn.myanimelist.net/images/anime/1844/141014l.jpg",
    banner_url: "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=1600&q=80",
    category: "anime",
    rating: 8.35,
    year: 2024,
    status: "En emisión",
    genres: "Acción, Aventura, Fantasía",
    episodes: [
      {
        id: "ep-solo-1",
        show_id: "show-solo-leveling",
        title: "Episodio 1: Acostumbrado a ello",
        episode_number: 1,
        source_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      },
      {
        id: "ep-solo-2",
        show_id: "show-solo-leveling",
        title: "Episodio 2: Si tuviera una oportunidad más",
        episode_number: 2,
        source_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      }
    ],
  },
  {
    id: "show-another",
    mal_id: 11111,
    title: "Another",
    japanese_title: "アナザー",
    english_title: "Another",
    description: "En 1972, una popular estudiante llamada Misaki falleció repentinamente en la clase 3-3. Años después, Kouichi Sakakibara es transferido a esa misma clase y nota una atmósfera siniestra y a una misteriosa chica con un parche en el ojo.",
    poster_url: "https://cdn.myanimelist.net/images/anime/1005/119932l.jpg",
    banner_url: "https://images.unsplash.com/photo-1509248961158-e54f6934749c?w=1600&q=80",
    category: "anime",
    rating: 7.48,
    year: 2012,
    status: "Finalizado",
    genres: "Terror, Misterio, Suspenso, Sobrenatural",
    episodes: [
      {
        id: "ep-another-1",
        show_id: "show-another",
        title: "Episodio 1: Bosquejo",
        episode_number: 1,
        source_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      },
      {
        id: "ep-another-2",
        show_id: "show-another",
        title: "Episodio 2: Blueprint",
        episode_number: 2,
        source_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
      }
    ],
  },
  {
    id: "show-stranger-things",
    title: "Stranger Things",
    description: "Cuando un niño desaparece en el pequeño pueblo de Hawkins, un grupo de amigos desvela una serie de misterios que involucran experimentos secretos del gobierno, fuerzas sobrenaturales aterradoras y una extraña niña.",
    poster_url: "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=800&q=80",
    banner_url: "https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=1600&q=80",
    category: "series",
    rating: 8.7,
    year: 2016,
    status: "En emisión",
    genres: "Terror, Ciencia Ficción, Drama, Suspenso, Misterio",
    episodes: [
      {
        id: "ep-st-1",
        show_id: "show-stranger-things",
        title: "Capítulo 1: La desaparición de Will Byers",
        episode_number: 1,
        source_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      },
      {
        id: "ep-st-2",
        show_id: "show-stranger-things",
        title: "Capítulo 2: La loca de Maple Street",
        episode_number: 2,
        source_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
      }
    ],
  }
];

// In-Memory Database Store
const showsStore = new Map<string, Show>();
initialShows.forEach((show) => showsStore.set(show.id, show));

// Hook task worker auto-importer to store shows safely
taskWorker.setImportCallback((showObj: Show) => {
  showsStore.set(showObj.id, showObj);
});

const tasksStore = new Map<string, CrawlTask>();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // ==========================================
  // API Routes
  // ==========================================

  // Health
  app.get(["/health", "/api/v1/health"], (req: Request, res: Response) => {
    res.json({ status: "ok", service: "VoidStream Core API" });
  });

  // GET /api/v1/genres - Fetch all distinct genres across anime, movies, and series APIs
  app.get("/api/v1/genres", async (req: Request, res: Response) => {
    try {
      const allGenres = new Set<string>();

      // 1. Gather all local genres from catalog
      for (const show of showsStore.values()) {
        if (show.genres) {
          show.genres.split(",").forEach((g) => {
            const trimmed = g.trim();
            if (trimmed) allGenres.add(trimmed);
          });
        }
      }

      // 2. Comprehensive base genre catalog covering Jikan (Anime), TVMaze (Series/Movies)
      const baseGenres = [
        "Acción",
        "Animación",
        "Aventura",
        "Ciencia Ficción",
        "Comedia",
        "Crimen",
        "Drama",
        "Fantasía",
        "Histórico",
        "Misterio",
        "Psicológico",
        "Romance",
        "Seinen",
        "Shounen",
        "Sobrenatural",
        "Suspenso",
        "Terror",
        "Thriller",
        "Isekai",
        "Cyberpunk",
        "Mecha",
        "Slice of Life"
      ];
      baseGenres.forEach((g) => allGenres.add(g));

      // 3. Dynamic genre fetch from Jikan Anime API
      try {
        const jikanController = new AbortController();
        const jTimer = setTimeout(() => jikanController.abort(), 2500);
        const jikanRes = await fetch("https://api.jikan.moe/v4/genres/anime", {
          signal: jikanController.signal,
          headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" }
        });
        clearTimeout(jTimer);
        if (jikanRes.ok) {
          const jData: any = await jikanRes.json();
          if (Array.isArray(jData?.data)) {
            jData.data.slice(0, 40).forEach((item: any) => {
              if (item?.name) {
                const name = item.name.trim();
                if (name.toLowerCase() === "horror") allGenres.add("Terror");
                else if (name.toLowerCase() === "action") allGenres.add("Acción");
                else if (name.toLowerCase() === "adventure") allGenres.add("Aventura");
                else if (name.toLowerCase() === "fantasy") allGenres.add("Fantasía");
                else if (name.toLowerCase() === "sci-fi") allGenres.add("Ciencia Ficción");
                else if (name.toLowerCase() === "mystery") allGenres.add("Misterio");
                else if (name.toLowerCase() === "suspense") allGenres.add("Suspenso");
                else if (name.toLowerCase() === "supernatural") allGenres.add("Sobrenatural");
                else allGenres.add(name);
              }
            });
          }
        }
      } catch {}

      const sorted = Array.from(allGenres).sort((a, b) => a.localeCompare(b, "es"));
      res.json({
        status: "ok",
        total: sorted.length,
        genres: sorted,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/shows
  app.get("/api/v1/shows", (req: Request, res: Response) => {
    const search = typeof req.query.search === "string" ? req.query.search.toLowerCase().trim() : "";
    const category = typeof req.query.category === "string" ? req.query.category.toLowerCase().trim() : "";

    let showsList = Array.from(showsStore.values());

    if (search) {
      showsList = showsList.filter((s) => {
        const t = (s.title || "").toLowerCase();
        const eng = (s.english_title || "").toLowerCase();
        const jap = (s.japanese_title || "").toLowerCase();
        const gen = (s.genres || "").toLowerCase();
        return t.includes(search) || eng.includes(search) || jap.includes(search) || gen.includes(search);
      });
    }

    if (category) {
      showsList = showsList.filter((s) => (s.category || "").toLowerCase() === category);
    }

    res.json(showsList);
  });

  // GET /api/v1/shows/:show_id
  app.get("/api/v1/shows/:show_id", (req: Request, res: Response) => {
    const showId = req.params.show_id;
    const show = showsStore.get(showId);
    if (!show) {
      return res.status(404).json({ detail: "Serie no encontrada" });
    }
    res.json(show);
  });

  // DELETE /api/v1/shows/:show_id
  app.delete("/api/v1/shows/:show_id", (req: Request, res: Response) => {
    const showId = req.params.show_id;
    const show = showsStore.get(showId);
    if (!show) {
      return res.status(404).json({ detail: "Serie no encontrada" });
    }
    showsStore.delete(showId);
    res.json({ status: "ok", message: `Serie '${show.title}' eliminada exitosamente.` });
  });

  // GET /api/v1/media (Legacy compatibility)
  app.get("/api/v1/media", (req: Request, res: Response) => {
    const showsList = Array.from(showsStore.values());
    const mapped = showsList.map((s) => ({
      id: s.id,
      title: s.title,
      original_title: s.japanese_title || s.title,
      synopsis: s.description || "",
      poster_url: s.poster_url || "",
      backdrop_url: s.banner_url || s.poster_url || "",
      category: s.category || "anime",
      rating: s.rating || 8.0,
      year: s.year || 2024,
      sources: {
        master_m3u8: `/api/v1/media/${s.id}/stream`,
        fallback_mp4: null,
        qualities: [],
        subtitles: [],
      },
    }));
    res.json(mapped);
  });

  // GET /api/v1/play/:episode_id - Just-In-Time Live Stream Resolver
  app.get("/api/v1/play/:episode_id", async (req: Request, res: Response) => {
    const episodeId = req.params.episode_id;
    let foundEpisode: Episode | null = null;
    let foundShow: Show | null = null;

    for (const show of showsStore.values()) {
      const ep = show.episodes.find((e) => e.id === episodeId);
      if (ep) {
        foundEpisode = ep;
        foundShow = show;
        break;
      }
    }

    if (!foundEpisode) {
      return res.status(404).json({ detail: "Episodio no encontrado en la base de datos." });
    }

    try {
      // Just-in-time extraction: if the source_url is a web page, resolve actual video servers in real time
      const extracted = await extractStreamFromUrl(foundEpisode.source_url);
      const allStreams = Array.from(
        new Set([extracted.stream_url, ...(extracted.all_available_streams || []), foundEpisode.source_url].filter(Boolean))
      );

      res.json({
        episode_id: foundEpisode.id,
        stream_url: allStreams[0] || foundEpisode.source_url,
        title: `${foundShow?.title || ""} - ${foundEpisode.title}`,
        all_available_streams: allStreams,
      });
    } catch {
      res.json({
        episode_id: foundEpisode.id,
        stream_url: foundEpisode.source_url,
        title: `${foundShow?.title || ""} - ${foundEpisode.title}`,
        all_available_streams: [foundEpisode.source_url],
      });
    }
  });

  // GET /api/v1/media/:media_id/stream
  app.get("/api/v1/media/:media_id/stream", async (req: Request, res: Response) => {
    const mediaId = req.params.media_id;
    const show = showsStore.get(mediaId);
    if (!show || !show.episodes.length) {
      return res.status(404).json({ detail: "Contenido no encontrado." });
    }

    const firstEp = show.episodes[0];
    try {
      const extracted = await extractStreamFromUrl(firstEp.source_url);
      const primaryUrl = extracted.stream_url || firstEp.source_url;

      res.json({
        master_m3u8: primaryUrl,
        fallback_mp4: primaryUrl.endsWith(".mp4") ? primaryUrl : null,
        qualities: [
          { label: "1080p Full HD", resolution: "1080p", bitrate: "Auto", url: primaryUrl },
          { label: "720p HD", resolution: "720p", bitrate: "Auto", url: primaryUrl },
        ],
        subtitles: [
          { id: "sub-es", label: "Español", language: "es", src: "", is_default: true },
          { id: "sub-en", label: "English", language: "en", src: "", is_default: false },
        ],
      });
    } catch {
      const primaryUrl = firstEp.source_url;
      res.json({
        master_m3u8: primaryUrl,
        fallback_mp4: primaryUrl.endsWith(".mp4") ? primaryUrl : null,
        qualities: [
          { label: "1080p Full HD", resolution: "1080p", bitrate: "Auto", url: primaryUrl },
          { label: "720p HD", resolution: "720p", bitrate: "Auto", url: primaryUrl },
        ],
        subtitles: [
          { id: "sub-es", label: "Español", language: "es", src: "", is_default: true },
          { id: "sub-en", label: "English", language: "en", src: "", is_default: false },
        ],
      });
    }
  });

  // GET /api/v1/proxy/stream - Anti-CORS Proxy
  app.get("/api/v1/proxy/stream", async (req: Request, res: Response) => {
    const targetUrl = typeof req.query.url === "string" ? req.query.url : "";
    const referer = typeof req.query.referer === "string" ? req.query.referer : "https://animeflv.or.at/";

    if (!targetUrl) {
      return res.status(400).json({ detail: "URL requerida" });
    }

    try {
      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: referer,
        },
      });

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");

      const contentType = response.headers.get("content-type") || "application/vnd.apple.mpegurl";
      res.setHeader("Content-Type", contentType);

      if (!response.body) {
        return res.end();
      }

      // @ts-ignore
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      };
      await pump();
    } catch (e: any) {
      res.status(500).json({ error: `Error en proxy: ${e.message}` });
    }
  });

// Scraper Presets Endpoint
app.get("/api/v1/scraper/presets", (req: Request, res: Response) => {
  res.json(PRESET_SOURCES);
});

// POST /api/v1/catalog/analyze - Universal Scraper & Metadata Enricher
app.post("/api/v1/catalog/analyze", async (req: Request, res: Response) => {
  const url = req.body?.url;
  if (!url) {
    return res.status(400).json({ detail: "La URL o término de búsqueda es requerido." });
  }

  try {
    const analysis = await analyzeUniversalUrl(url);
    res.json(analysis);
  } catch (e: any) {
    res.status(500).json({ detail: `Error analizando: ${e.message}` });
  }
});

// POST /api/v1/catalog/import-show - Save single or analyzed media item
app.post("/api/v1/catalog/import-show", (req: Request, res: Response) => {
  const showData = req.body?.show_data;
  if (!showData || !showData.title) {
    return res.status(400).json({ detail: "show_data con title es requerido" });
  }

  const title = showData.title.trim();
  const showId = `show-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const episodes: Episode[] = (showData.episodes || []).map((ep: any, idx: number) => ({
    id: `ep-${showId}-${idx + 1}`,
    show_id: showId,
    title: ep.title || `Episodio ${ep.number || idx + 1}`,
    episode_number: parseFloat(ep.number) || idx + 1,
    source_url: ep.url || (showData.detected_streams && showData.detected_streams[0]) || "",
  }));

  if (episodes.length === 0) {
    episodes.push({
      id: `ep-${showId}-1`,
      show_id: showId,
      title: showData.content_type === "movie" ? "Película Completa" : "Episodio 1: Estreno",
      episode_number: 1,
      source_url: (showData.detected_streams && showData.detected_streams[0]) || "",
    });
  }

  const newShow: Show = {
    id: showId,
    mal_id: showData.mal_id || undefined,
    title: title,
    japanese_title: showData.japanese_title,
    english_title: showData.english_title,
    description: showData.description || "Obra multimedia importada al catálogo.",
    poster_url: showData.poster_url || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800",
    banner_url: showData.banner_url || showData.poster_url || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1600",
    category: showData.content_type || "anime",
    rating: typeof showData.rating === "number" ? showData.rating : 8.5,
    year: showData.year || new Date().getFullYear(),
    status: showData.status || "Finalizado",
    genres: Array.isArray(showData.genres) ? showData.genres.join(", ") : (showData.genres || "Multimedia"),
    episodes,
  };

  showsStore.set(showId, newShow);

  res.json({
    status: "ok",
    message: `'${newShow.title}' guardado exitosamente con ${episodes.length} episodio(s)/fuentes.`,
    show_id: showId,
    show: newShow,
  });
});

// POST /api/v1/catalog/batch-import - Multi-URL Batch Ingestion
app.post("/api/v1/catalog/batch-import", async (req: Request, res: Response) => {
  const urls: string[] = req.body?.urls || [];
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ detail: "Se requiere un array de URLs o títulos ('urls')" });
  }

  const results: any[] = [];
  const processedUrls = urls.slice(0, 15).map(u => u.trim()).filter(Boolean);

  const importPromises = processedUrls.map(async (cleanUrl) => {
    try {
      const analysis = await analyzeUniversalUrl(cleanUrl);
      const showId = `show-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      const episodes: Episode[] = (analysis.episodes || []).map((ep, idx) => ({
        id: `ep-${showId}-${idx + 1}`,
        show_id: showId,
        title: ep.title || `Episodio ${idx + 1}`,
        episode_number: ep.number || idx + 1,
        source_url: ep.url || cleanUrl,
      }));

      const newShow: Show = {
        id: showId,
        mal_id: (analysis as any).mal_id,
        title: analysis.title,
        japanese_title: analysis.japanese_title || undefined,
        english_title: analysis.english_title || undefined,
        description: analysis.description,
        poster_url: analysis.poster_url || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800",
        banner_url: analysis.banner_url || analysis.poster_url || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1600",
        category: analysis.content_type,
        rating: analysis.rating || 8.2,
        year: analysis.year || 2024,
        status: analysis.status || "Finalizado",
        genres: analysis.genres.join(", "),
        episodes,
      };

      showsStore.set(showId, newShow);
      return { url: cleanUrl, status: "success", title: newShow.title, show_id: showId };
    } catch (e: any) {
      return { url: cleanUrl, status: "failed", error: e.message };
    }
  });

  const settledResults = await Promise.all(importPromises);
  results.push(...settledResults);

  res.json({
    status: "ok",
    imported_count: results.filter((r) => r.status === "success").length,
    results,
  });
});

// POST /api/v1/catalog/crawl & /api/v1/discover - Deep Crawler Engine with Task Worker
app.post(["/api/v1/catalog/crawl", "/api/v1/discover"], (req: Request, res: Response) => {
  const targetUrl = req.body?.url || "https://animeflv.net";
  const maxPages = Number(req.body?.max_pages) || 1;
  const delayMs = Number(req.body?.delay_ms) || 1500;
  const scope = req.body?.scope || (maxPages >= 10 ? "full_catalog" : "catalog_pages");

  const job = taskWorker.createJob({
    target_url: targetUrl,
    scope: scope,
    max_pages: maxPages,
    delay_ms: delayMs,
  });

  res.json({
    task_id: job.id,
    job: job,
    status: "pending",
    message: `Tarea creada y asignada al worker con rate limit de ${delayMs}ms.`,
  });
});

// GET /api/v1/worker/jobs - List all background crawler jobs
app.get("/api/v1/worker/jobs", (req: Request, res: Response) => {
  res.json(taskWorker.getAllJobs());
});

// GET /api/v1/worker/settings - Get rate limit and anti-blocking configs
app.get("/api/v1/worker/settings", (req: Request, res: Response) => {
  res.json(taskWorker.getSettings());
});

// POST /api/v1/worker/settings - Update worker settings
app.post("/api/v1/worker/settings", (req: Request, res: Response) => {
  const newSettings = req.body || {};
  taskWorker.updateSettings(newSettings);
  res.json({ status: "ok", settings: taskWorker.getSettings() });
});

// POST /api/v1/worker/jobs/:job_id/pause
app.post("/api/v1/worker/jobs/:job_id/pause", (req: Request, res: Response) => {
  const success = taskWorker.pauseJob(req.params.job_id);
  if (!success) return res.status(400).json({ detail: "No se pudo pausar la tarea" });
  res.json({ status: "ok", message: "Tarea pausada" });
});

// POST /api/v1/worker/jobs/:job_id/resume
app.post("/api/v1/worker/jobs/:job_id/resume", (req: Request, res: Response) => {
  const success = taskWorker.resumeJob(req.params.job_id);
  if (!success) return res.status(400).json({ detail: "No se pudo reanudar la tarea" });
  res.json({ status: "ok", message: "Tarea reanudada" });
});

// POST /api/v1/worker/jobs/:job_id/cancel
app.post("/api/v1/worker/jobs/:job_id/cancel", (req: Request, res: Response) => {
  const success = taskWorker.cancelJob(req.params.job_id);
  if (!success) return res.status(400).json({ detail: "No se pudo cancelar la tarea" });
  res.json({ status: "ok", message: "Tarea cancelada" });
});

// DELETE /api/v1/worker/jobs/:job_id
app.delete("/api/v1/worker/jobs/:job_id", (req: Request, res: Response) => {
  const success = taskWorker.deleteJob(req.params.job_id);
  if (!success) return res.status(404).json({ detail: "Tarea no encontrada" });
  res.json({ status: "ok", message: "Tarea eliminada" });
});

// POST /api/v1/worker/clear-finished
app.post("/api/v1/worker/clear-finished", (req: Request, res: Response) => {
  taskWorker.clearFinishedJobs();
  res.json({ status: "ok", message: "Tareas completadas limpiadas" });
});

// GET /api/v1/tasks/:task_id - Live Task & Log Monitor (Backward compatible + worker job support)
app.get("/api/v1/tasks/:task_id", (req: Request, res: Response) => {
  const taskId = req.params.task_id;
  const job = taskWorker.getJob(taskId);
  if (job) {
    return res.json({
      task_id: job.id,
      name: job.name,
      status: job.status,
      pages_crawled: job.current_page,
      shows_imported: job.shows_imported,
      episodes_imported: job.episodes_imported,
      total_discovered: job.total_discovered,
      current_item_title: job.current_item_title,
      items_queue: job.items_queue,
      rate_limit_delay_ms: job.rate_limit_delay_ms,
      error_message: job.error_message,
      created_at: job.created_at,
      updated_at: job.updated_at,
      logs: job.logs.map((l) => `[${l.level.toUpperCase()}] ${l.message}`),
      detailed_logs: job.logs,
    });
  }

  const legacyTask = tasksStore.get(taskId);
  if (!legacyTask) {
    return res.status(404).json({ detail: "Tarea no encontrada" });
  }
  res.json({
    task_id: legacyTask.id,
    status: legacyTask.status,
    pages_crawled: legacyTask.pages_crawled,
    shows_imported: legacyTask.shows_imported,
    episodes_imported: legacyTask.episodes_imported,
    error_message: legacyTask.error_message,
    created_at: legacyTask.created_at,
    logs: legacyTask.logs || [],
  });
});

// POST /api/v1/extract - Universal Stream & Video Extractor
app.post("/api/v1/extract", async (req: Request, res: Response) => {
  const url = req.body?.url || "";
  if (!url) {
    return res.status(400).json({ detail: "URL requerida para extracción" });
  }

  try {
    const extracted = await extractStreamFromUrl(url);
    const analysis = await analyzeUniversalUrl(url).catch(() => null);

    const streams = Array.from(
      new Set(
        [
          extracted.stream_url,
          ...(extracted.all_available_streams || []),
          ...(analysis?.detected_streams || []),
          ...(analysis?.episodes || []).map((e) => e.url),
          url,
        ].filter(Boolean)
      )
    );

    res.json({
      title: extracted.title || analysis?.title || "Stream Extraído",
      description: `Estrategia: Universal Live Extractor (${(analysis?.content_type || "video").toUpperCase()})`,
      detected_type: analysis?.content_type || "video",
      stream_url: streams[0] || url,
      all_streams: streams,
      poster_url: analysis?.poster_url || "https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=800",
      subtitles: [],
    });
  } catch (e: any) {
    res.status(500).json({ detail: `Error extrayendo stream: ${e.message}` });
  }
});

// POST /api/v1/catalog/reset-sample - Reset to initial seed catalog
app.post("/api/v1/catalog/reset-sample", (req: Request, res: Response) => {
  showsStore.clear();
  initialShows.forEach((s) => showsStore.set(s.id, s));
  res.json({ status: "ok", message: "Catálogo restaurado a las series iniciales." });
});

  // ==========================================
  // Vite Middleware & Static Frontend Serving
  // ==========================================
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: "0.0.0.0", port: PORT },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[VoidStream] Servidor ejecutándose en http://0.0.0.0:${PORT}`);
  });
}

startServer();
