import * as cheerio from "cheerio";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem, ScraperPreset } from "./types";
import { cleanQueryTitle, enrichUniversalMetadata } from "./metadataEngine";

export const PRESET_SOURCES: ScraperPreset[] = [
  {
    id: "anime-animeflv",
    name: "AnimeFLV / JKanime (Anime)",
    category: "anime",
    description: "Portales de anime en español con episodios, estrenos y servidores múltiples.",
    example_url: "https://animeflv.net/anime/sousou-no-frieren",
    icon: "Tv",
  },
  {
    id: "movies-cuevana",
    name: "Cuevana / Pelisplus (Películas & Series)",
    category: "movies",
    description: "Estrenos de cine, series populares y sagas completas en HD.",
    example_url: "https://cuevana.biz/pelicula/oppenheimer",
    icon: "Film",
  },
  {
    id: "series-tvmaze",
    name: "TV Shows & Series Internacionales",
    category: "series",
    description: "Series de TV mundiales, temporadas completas, fechas de emisión y reparto.",
    example_url: "https://www.tvmaze.com/shows/169/breaking-bad",
    icon: "Layers",
  },
  {
    id: "archive-org",
    name: "Internet Archive & Dominio Público",
    category: "archive",
    description: "Películas clásicas de libre distribución, cine mudo, documentales y animación abierta.",
    example_url: "https://archive.org/details/night_of_the_living_dead",
    icon: "Database",
  },
  {
    id: "open-hls",
    name: "Direct HLS Stream / M3U8 Master",
    category: "direct",
    description: "Streams directos HLS adaptativos con múltiples resoluciones y subtítulos.",
    example_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    icon: "Play",
  },
  {
    id: "open-blender",
    name: "Blender Open Movies (4K)",
    category: "movies",
    description: "Cortometrajes y películas de animación 3D de código abierto (Tears of Steel, Sintel, Big Buck Bunny).",
    example_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
    icon: "Sparkles",
  }
];

export async function analyzeUniversalUrl(input: string): Promise<UniversalAnalysisResult> {
  const urlOrQuery = input.trim();

  // 1. Direct stream check
  if (isDirectStreamUrl(urlOrQuery)) {
    return handleDirectStream(urlOrQuery);
  }

  // 2. If it's a search term rather than a full URL
  if (!urlOrQuery.startsWith("http://") && !urlOrQuery.startsWith("https://")) {
    return handleSearchTerm(urlOrQuery);
  }

  // 3. It is a Web URL: fetch HTML and scrape deeply
  try {
    const urlObj = new URL(urlOrQuery);
    const domain = urlObj.hostname.toLowerCase();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);

    const response = await fetch(urlOrQuery, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      },
    });
    clearTimeout(timer);

    if (!response.ok) {
      // If blocked or 404, fallback to search term
      return handleSearchTerm(urlOrQuery);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // --- Extract OpenGraph & Meta ---
    const ogTitle = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").text() || "";
    const ogDesc = $('meta[property="og:description"]').attr("content") || $('meta[name="twitter:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
    const ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
    const ogType = $('meta[property="og:type"]').attr("content") || "";
    const ogVideo = $('meta[property="og:video"]').attr("content") || $('meta[property="og:video:url"]').attr("content") || "";

    // --- Extract JSON-LD Schema ---
    const jsonLdData: any[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const text = $(el).html();
        if (text) {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) jsonLdData.push(...parsed);
          else jsonLdData.push(parsed);
        }
      } catch {
        // ignore malformed json-ld
      }
    });

    // Detect media schema inside JSON-LD
    let schemaMovieOrSeries = jsonLdData.find(
      (item) => item["@type"] === "Movie" || item["@type"] === "TVSeries" || item["@type"] === "TVEpisode" || item["@type"] === "VideoObject"
    );

    // --- Extract Video Embeds & Streams in page ---
    const detectedStreams: string[] = [];
    if (ogVideo) detectedStreams.push(ogVideo);

    // 1. Check <video> and <source>
    $("video source, video").each((_, el) => {
      const src = $(el).attr("src");
      if (src && !detectedStreams.includes(src)) detectedStreams.push(src);
    });

    // 2. Check iframes
    $("iframe").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src");
      if (src && !detectedStreams.includes(src)) {
        if (src.startsWith("//")) detectedStreams.push(`https:${src}`);
        else detectedStreams.push(src);
      }
    });

    // 3. Scan script contents for m3u8 or mp4 URLs
    $("script").each((_, el) => {
      const scriptContent = $(el).html() || "";
      const streamMatches = scriptContent.match(/https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*/gi);
      if (streamMatches) {
        streamMatches.forEach((m) => {
          if (!detectedStreams.includes(m)) detectedStreams.push(m);
        });
      }
    });

    // --- Determine Content Kind ---
    let detectedKind: ContentKind = "anime";
    const pathAndTitle = (urlOrQuery + " " + ogTitle + " " + ogDesc).toLowerCase();

    if (domain.includes("anime") || pathAndTitle.includes("anime") || pathAndTitle.includes("manga") || domain.includes("jkanime")) {
      detectedKind = "anime";
    } else if (domain.includes("cuevana") || domain.includes("pelis") || pathAndTitle.includes("pelicula") || pathAndTitle.includes("movie") || schemaMovieOrSeries?.["@type"] === "Movie") {
      detectedKind = "movie";
    } else if (pathAndTitle.includes("serie") || pathAndTitle.includes("temporada") || pathAndTitle.includes("season") || schemaMovieOrSeries?.["@type"] === "TVSeries") {
      detectedKind = "series";
    } else if (domain.includes("archive.org") || pathAndTitle.includes("dominio publico")) {
      detectedKind = "open_archive";
    }

    // --- Extract Episodes from DOM ---
    const extractedEpisodes: ExtractedEpisode[] = [];
    const episodeSelectors = [
      "ul.episodes-list li a",
      ".episodes-list a",
      "ul.ListCaps li a",
      ".ListCaps a",
      ".capitulos-list a",
      "table.episodes-table tr a",
      ".episode-item a",
      "a[href*='/ver/']",
      "a[href*='episodio']",
      "a[href*='capitulo']",
      "a[href*='watch']",
    ];

    for (const selector of episodeSelectors) {
      $(selector).each((idx, el) => {
        const text = $(el).text().trim() || $(el).attr("title") || `Episodio ${idx + 1}`;
        let href = $(el).attr("href") || "";
        if (href && !href.startsWith("http")) {
          try {
            href = new URL(href, urlOrQuery).toString();
          } catch {
            // keep
          }
        }
        if (href && !extractedEpisodes.some((e) => e.url === href)) {
          extractedEpisodes.push({
            number: idx + 1,
            title: text.replace(/\s+/g, " "),
            url: href,
          });
        }
      });
      if (extractedEpisodes.length > 0) break;
    }

    // --- Extract Catalog / Directory Items if this is a directory/catalog page ---
    const catalogItems: ExtractedCatalogItem[] = [];
    const cardSelectors = [
      "article.Anime a",
      ".anime-item a",
      ".poster-card a",
      ".movie-item a",
      ".catalog-card a",
      ".item-pelicula a",
      "ul.ListAnimes li a",
      ".items-list article a",
    ];

    for (const selector of cardSelectors) {
      $(selector).each((_, el) => {
        const cardTitle = $(el).find("h3, h2, .Title, .title").text().trim() || $(el).attr("title") || $(el).text().trim();
        let cardHref = $(el).attr("href") || "";
        const cardImg = $(el).find("img").attr("src") || $(el).find("img").attr("data-src") || null;

        if (cardHref && !cardHref.startsWith("http")) {
          try {
            cardHref = new URL(cardHref, urlOrQuery).toString();
          } catch {
            // keep
          }
        }

        if (cardTitle && cardHref && !catalogItems.some((c) => c.url === cardHref)) {
          catalogItems.push({
            title: cleanQueryTitle(cardTitle),
            url: cardHref,
            image_url: cardImg ? (cardImg.startsWith("//") ? `https:${cardImg}` : cardImg) : null,
            kind: detectedKind,
          });
        }
      });
      if (catalogItems.length > 0) break;
    }

    // Determine page type
    const isCatalog = catalogItems.length >= 3 && extractedEpisodes.length === 0;
    const pageType: UniversalAnalysisResult["page_type"] = isCatalog ? "catalog" : "detail";

    // Clean title & enrich metadata
    const rawCleanTitle = cleanQueryTitle(schemaMovieOrSeries?.name || ogTitle || urlObj.pathname.split("/").pop() || "Contenido");
    const enriched = await enrichUniversalMetadata(rawCleanTitle, detectedKind);

    // Combine extracted episodes with enriched suggestions if none found
    let finalEpisodes = extractedEpisodes;
    if (finalEpisodes.length === 0) {
      if (detectedKind === "movie" || detectedKind === "open_archive") {
        finalEpisodes = [
          {
            number: 1,
            title: "Película Completa",
            url: detectedStreams[0] || "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
          },
        ];
      } else if (enriched.suggested_episodes && enriched.suggested_episodes.length > 0) {
        finalEpisodes = enriched.suggested_episodes.map((s, idx) => ({
          number: s.number,
          title: s.title,
          url: detectedStreams[idx] || "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        }));
      } else {
        finalEpisodes = [
          {
            number: 1,
            title: "Episodio 1",
            url: detectedStreams[0] || "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
          },
        ];
      }
    }

    return {
      page_type: pageType,
      content_type: enriched.content_type || detectedKind,
      title: enriched.title || rawCleanTitle,
      original_title: enriched.original_title,
      japanese_title: enriched.japanese_title,
      english_title: enriched.english_title,
      description: enriched.description || ogDesc || "Contenido indexado en VoidStream.",
      poster_url: enriched.poster_url || (ogImage ? (ogImage.startsWith("//") ? `https:${ogImage}` : ogImage) : null),
      banner_url: enriched.banner_url || (ogImage ? (ogImage.startsWith("//") ? `https:${ogImage}` : ogImage) : null),
      rating: enriched.rating || 8.0,
      year: enriched.year || 2024,
      status: enriched.status || "Finalizado",
      genres: enriched.genres.length > 0 ? enriched.genres : ["Multimedia"],
      source_domain: domain,
      detected_streams: detectedStreams,
      episodes: finalEpisodes,
      catalog_items: catalogItems,
      raw_metadata: {
        og: { title: ogTitle, description: ogDesc, image: ogImage, type: ogType },
        embeds: detectedStreams,
      },
    };
  } catch (err: any) {
    // If fetching failed, fallback to smart search enricher
    return handleSearchTerm(urlOrQuery);
  }
}

function isDirectStreamUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes(".m3u8") ||
    lower.includes(".mp4") ||
    lower.includes(".webm") ||
    lower.includes(".mkv") ||
    lower.includes("commondatastorage.googleapis.com/gtv-videos-bucket") ||
    lower.includes("test-streams.mux.dev")
  );
}

function handleDirectStream(streamUrl: string): UniversalAnalysisResult {
  let title = "Stream Directo HLS / MP4";
  try {
    const urlObj = new URL(streamUrl);
    const filename = urlObj.pathname.split("/").pop() || "";
    if (filename) {
      title = filename.replace(/\.(m3u8|mp4|webm|mkv)$/i, "").replace(/[-_]/g, " ");
    }
  } catch {
    // keep default
  }

  return {
    page_type: "direct_stream",
    content_type: "movie",
    title: cleanQueryTitle(title) || "Stream Multimedia",
    description: "Fuente de video directa indexada con compatibilidad HLS adaptativa y selector de calidades.",
    poster_url: "https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=800&q=80",
    banner_url: "https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=1600&q=80",
    rating: 8.8,
    year: new Date().getFullYear(),
    status: "Directo",
    genres: ["Stream HLS", "Video HD"],
    detected_streams: [streamUrl],
    episodes: [
      {
        number: 1,
        title: "Reproducción Principal (Direct)",
        url: streamUrl,
      },
    ],
    catalog_items: [],
  };
}

async function handleSearchTerm(query: string): Promise<UniversalAnalysisResult> {
  const cleaned = cleanQueryTitle(query);
  const enriched = await enrichUniversalMetadata(cleaned);

  const defaultEpisodes: ExtractedEpisode[] = (enriched.suggested_episodes && enriched.suggested_episodes.length > 0)
    ? enriched.suggested_episodes.map((s) => ({
        number: s.number,
        title: s.title,
        url: s.url || "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      }))
    : [
        {
          number: 1,
          title: "Episodio 1: Estreno",
          url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        },
      ];

  return {
    page_type: "detail",
    content_type: enriched.content_type || "anime",
    title: enriched.title,
    original_title: enriched.original_title,
    japanese_title: enriched.japanese_title,
    english_title: enriched.english_title,
    description: enriched.description,
    poster_url: enriched.poster_url,
    banner_url: enriched.banner_url || enriched.poster_url,
    rating: enriched.rating,
    year: enriched.year,
    status: enriched.status,
    genres: enriched.genres,
    episodes: defaultEpisodes,
    catalog_items: [],
  };
}

export async function extractCatalogListing(pageUrl: string): Promise<ExtractedCatalogItem[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
    });
    clearTimeout(timeoutId);

    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);

    const catalogItems: ExtractedCatalogItem[] = [];
    const cardSelectors = [
      "article.Anime a",
      ".anime-item a",
      ".poster-card a",
      ".movie-item a",
      ".catalog-card a",
      ".item-pelicula a",
      "ul.ListAnimes li a",
      ".items-list article a",
      "div.card a",
      ".browse-item a",
    ];

    for (const selector of cardSelectors) {
      $(selector).each((_, el) => {
        const cardTitle = $(el).find("h3, h2, .Title, .title").text().trim() || $(el).attr("title") || $(el).text().trim();
        let cardHref = $(el).attr("href") || "";
        const cardImg = $(el).find("img").attr("src") || $(el).find("img").attr("data-src") || null;

        if (cardHref && !cardHref.startsWith("http")) {
          try {
            cardHref = new URL(cardHref, pageUrl).toString();
          } catch {
            // keep
          }
        }

        if (cardTitle && cardHref && !catalogItems.some((c) => c.url === cardHref)) {
          catalogItems.push({
            title: cleanQueryTitle(cardTitle),
            url: cardHref,
            image_url: cardImg ? (cardImg.startsWith("//") ? `https:${cardImg}` : cardImg) : null,
            kind: "anime",
          });
        }
      });
      if (catalogItems.length > 0) break;
    }
    return catalogItems;
  } catch {
    return [];
  }
}
