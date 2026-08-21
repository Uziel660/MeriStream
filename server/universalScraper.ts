import * as cheerio from "cheerio";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem, ScraperPreset } from "./types";
import { cleanQueryTitle, enrichUniversalMetadata } from "./metadataEngine";
import { PageClassifier } from "./pageClassifier";
import { EmbedResolvers } from "./resolvers";
import { MediaValidator } from "./validator";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export const PRESET_SOURCES: ScraperPreset[] = [
  {
    id: "anime-animeflv",
    name: "AnimeFLV / JKanime (Anime en Español)",
    category: "anime",
    description: "Portales de anime con temporadas completas, lista de episodios y servidores multi-fuente.",
    example_url: "https://www3.animeflv.net/anime/sousou-no-frieren",
    icon: "Tv",
  },
  {
    id: "movies-cuevana",
    name: "Películas & Series Web (Streaming)",
    category: "movies",
    description: "Directorio de películas y series con reproductores en línea y opciones de calidad.",
    example_url: "https://cuevana.biz/pelicula/oppenheimer",
    icon: "Film",
  },
  {
    id: "series-tvmaze",
    name: "TV Shows Internacionales (TVMaze)",
    category: "series",
    description: "Series de televisión mundiales con temporadas, sinopsis, reparto y fechas oficiales.",
    example_url: "https://www.tvmaze.com/shows/169/breaking-bad",
    icon: "Layers",
  },
  {
    id: "archive-org",
    name: "Internet Archive (Cine y Multimedia Libre)",
    category: "archive",
    description: "Películas clásicas de dominio público, animación y documentales con streams directos MP4/HLS.",
    example_url: "https://archive.org/details/night_of_the_living_dead",
    icon: "Database",
  },
  {
    id: "open-hls",
    name: "Direct HLS Stream (.m3u8)",
    category: "direct",
    description: "Enlace directo de manifiesto HLS adaptativo con soporte de múltiples resoluciones.",
    example_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    icon: "Play",
  },
  {
    id: "open-mp4",
    name: "Direct Video File (.mp4 / .webm)",
    category: "direct",
    description: "Enlace directo a archivo de video accesible por HTTP/HTTPS.",
    example_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
    icon: "Sparkles",
  }
];

const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
};

/**
 * Universal Scraper: Analyzes any URL (Anime, Movie, Series, Archive.org, Direct Video)
 * and extracts clean real metadata, episode list, and playable video streams/embeds.
 */
export async function analyzeUniversalUrl(input: string): Promise<UniversalAnalysisResult> {
  const urlOrQuery = input.trim();

  // 1. Direct Stream (.m3u8, .mp4, .webm, etc.)
  if (isDirectStreamUrl(urlOrQuery)) {
    return handleDirectStream(urlOrQuery);
  }

  // 2. Search query instead of full URL
  if (!urlOrQuery.startsWith("http://") && !urlOrQuery.startsWith("https://")) {
    return handleSearchTerm(urlOrQuery);
  }

  // 3. Special handler for Archive.org
  if (urlOrQuery.includes("archive.org/details/")) {
    return handleArchiveOrg(urlOrQuery);
  }

  // 4. Fetch HTML and perform deep multi-server extraction
  try {
    const urlObj = new URL(urlOrQuery);
    const domain = urlObj.hostname.toLowerCase();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7500);

    const response = await fetch(urlOrQuery, {
      signal: controller.signal,
      headers: COMMON_HEADERS,
    });
    clearTimeout(timer);

    if (!response.ok) {
      return handleSearchTerm(urlOrQuery);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // --- Extract OpenGraph & Meta Tags ---
    const ogTitle = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").text() || "";
    const ogDesc = $('meta[property="og:description"]').attr("content") || $('meta[name="twitter:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
    const ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
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
      } catch {}
    });

    const schemaMedia = jsonLdData.find(
      (item) => item["@type"] === "Movie" || item["@type"] === "TVSeries" || item["@type"] === "TVEpisode" || item["@type"] === "VideoObject"
    );

    // --- Determine Content Kind ---
    let detectedKind: ContentKind = "anime";
    const pathAndTitle = (urlOrQuery + " " + ogTitle + " " + ogDesc).toLowerCase();

    if (domain.includes("anime") || pathAndTitle.includes("anime") || pathAndTitle.includes("manga") || domain.includes("jkanime")) {
      detectedKind = "anime";
    } else if (domain.includes("cuevana") || domain.includes("pelis") || pathAndTitle.includes("pelicula") || pathAndTitle.includes("movie") || schemaMedia?.["@type"] === "Movie") {
      detectedKind = "movie";
    } else if (pathAndTitle.includes("serie") || pathAndTitle.includes("temporada") || pathAndTitle.includes("season") || schemaMedia?.["@type"] === "TVSeries") {
      detectedKind = "series";
    } else if (domain.includes("archive.org")) {
      detectedKind = "open_archive";
    }

    // --- Extract Real Streams / Embeds from HTML ---
    const detectedStreams = extractEmbedsAndStreamsFromHtml($, html, urlOrQuery);
    if (ogVideo && !detectedStreams.includes(ogVideo)) {
      detectedStreams.unshift(ogVideo);
    }

    // --- Extract Episodes (DOM + JavaScript Objects like AnimeFLV / JKanime) ---
    const extractedEpisodes: ExtractedEpisode[] = [];

    // 1. AnimeFLV JavaScript Parser (var anime_info = [...], var episodes = [...])
    const epDataElement = $(".animeflv-episodes-data");
    if (epDataElement.length > 0) {
      try {
        const epData = JSON.parse(epDataElement.text().trim() || "[]");
        if (Array.isArray(epData)) {
          const sorted = [...epData].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
          sorted.forEach((ep) => {
            if (ep.permalink) {
              extractedEpisodes.push({
                number: Number(ep.number) || 1,
                title: `Episodio ${ep.number || 1}`,
                url: ep.permalink,
              });
            }
          });
        }
      } catch {}
    }

    const scriptTexts: string[] = [];
    $("script").each((_, el) => {
      const content = $(el).html() || "";
      if (content) scriptTexts.push(content);
    });
    const allScripts = scriptTexts.join("\n");

    const animeInfoMatch = allScripts.match(/var\s+anime_info\s*=\s*(\[[^;]+\]);/);
    const episodesMatch = allScripts.match(/var\s+episodes\s*=\s*(\[[^;]+\]);/);

    if (episodesMatch) {
      try {
        const epData = JSON.parse(episodesMatch[1]);
        let animeSlug = "";
        if (animeInfoMatch) {
          try {
            const info = JSON.parse(animeInfoMatch[1]);
            animeSlug = info[1] || "";
          } catch {}
        }
        if (!animeSlug) {
          const parts = urlObj.pathname.split("/").filter(Boolean);
          animeSlug = parts[parts.length - 1] || "anime";
        }

        if (Array.isArray(epData)) {
          // Sort episodes in ascending order: [1, 2, 3, ...]
          const sorted = [...epData].sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0));
          sorted.forEach((ep) => {
            const epNum = ep[0];
            const epUrl = `https://${urlObj.host}/ver/${animeSlug}-${epNum}`;
            extractedEpisodes.push({
              number: Number(epNum) || 1,
              title: `Episodio ${epNum}`,
              url: epUrl,
            });
          });
        }
      } catch {}
    }

    // 2. Standard DOM Selectors for Episodes (JKanime, Cuevana, Pelisplus, TVMaze, etc.)
    if (extractedEpisodes.length === 0) {
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
          const rawText = $(el).text().trim() || $(el).attr("title") || `Episodio ${idx + 1}`;
          let href = $(el).attr("href") || "";
          if (href && !href.startsWith("http")) {
            try {
              href = new URL(href, urlOrQuery).toString();
            } catch {}
          }
          if (href && !extractedEpisodes.some((e) => e.url === href)) {
            // Extract episode number from text or url if possible
            const numMatch = rawText.match(/\b(?:episodio|capitulo|ep|cap)?\s*(\d+(?:\.\d+)?)\b/i) || href.match(/[-_](\d+(?:\.\d+)?)(?:\/|$|\.html)/i);
            const num = numMatch ? parseFloat(numMatch[1]) : idx + 1;

            extractedEpisodes.push({
              number: num,
              title: rawText.replace(/\s+/g, " "),
              url: href,
            });
          }
        });
        if (extractedEpisodes.length > 0) break;
      }
    }

    // --- Extract Catalog / Directory Items if this is a directory/browse page ---
    const catalogItems: ExtractedCatalogItem[] = [];
    const seenCatalogUrls = new Set<string>();

    const cardSelectors = [
      "ul.ListAnimes > li", "article.anime", "article", ".anime-card", ".item", ".film", ".card",
      "li.anime", "ul.animes > li", ".list-animes > li", ".grid > div",
      ".catalog-grid > div", ".row > div", ".post", ".hentry", ".ht_grid_1_4",
      ".type-post", ".browse-item", ".catalog-card"
    ];

    let cards = $([]);
    for (const selector of cardSelectors) {
      const found = $(selector);
      if (found.length >= 3) {
        cards = found;
        break;
      }
    }

    if (cards.length === 0) {
      const fallback: cheerio.Element[] = [];
      $("article, li, div").each((_, el) => {
        if ($(el).find("a[href]").length > 0 && $(el).find("img").length > 0) {
          fallback.push(el);
        }
      });
      if (fallback.length >= 3) {
        cards = $(fallback);
      }
    }

    cards.each((_, card) => {
      const anchors = $(card).find("a[href]");
      if (anchors.length === 0) return;

      const showUrl = extractShowUrlFromAnchors($, anchors, urlOrQuery, domain);
      if (!showUrl || seenCatalogUrls.has(showUrl)) return;

      const imgUrl = extractCardImgUrl($, card, urlOrQuery);
      const cardTitle = extractCatalogCardTitle($, card, anchors, showUrl);

      if (["inicio", "home", "directorio anime", "dmca", "contacto", "login"].some((b) => cardTitle.toLowerCase().includes(b))) {
        return;
      }

      seenCatalogUrls.add(showUrl);
      catalogItems.push({
        title: cleanQueryTitle(cardTitle),
        url: showUrl,
        image_url: imgUrl,
        kind: detectedKind,
      });
    });

    const classifiedType = PageClassifier.classify(urlOrQuery, $);
    const isCatalog = classifiedType === "collection" || (catalogItems.length >= 3 && extractedEpisodes.length === 0);
    const pageType: UniversalAnalysisResult["page_type"] = isCatalog ? "catalog" : "detail";

    // Validate extracted streams
    const validatedStreams = await MediaValidator.validateUrls(detectedStreams);
    const finalStreams = validatedStreams.length > 0 ? validatedStreams : detectedStreams;

    // --- CASE A: CATALOG / DIRECTORY PAGE ---
    if (isCatalog) {
      const catalogTitle = ogTitle || `Catálogo de Medios (${domain})`;
      const firstImage = catalogItems.find((c) => c.image_url)?.image_url || null;
      let catalogPoster = firstImage;
      if (ogImage) {
        catalogPoster = ogImage.startsWith("//") ? `https:${ogImage}` : ogImage;
      }

      return {
        page_type: "catalog",
        content_type: detectedKind,
        title: catalogTitle,
        description: ogDesc || `Directorio de ${catalogItems.length} obras multimedia detectadas en ${domain}.`,
        poster_url: catalogPoster,
        banner_url: catalogPoster,
        rating: 8.5,
        year: new Date().getFullYear(),
        status: "Catálogo",
        genres: ["Directorio", "Catálogo"],
        source_domain: domain,
        detected_streams: [],
        episodes: [],
        catalog_items: catalogItems,
        raw_metadata: {
          og: { title: ogTitle, description: ogDesc, image: ogImage },
          embeds: [],
        },
      };
    }

    // --- CASE B: SINGLE DETAIL / SHOW PAGE ---
    const rawCleanTitle = cleanQueryTitle(schemaMedia?.name || ogTitle || urlObj.pathname.split("/").pop() || "Contenido");
    const enriched = await enrichUniversalMetadata(rawCleanTitle, detectedKind);

    // If detail page has no episodes extracted, build from detected stream or source URL
    let finalEpisodes = extractedEpisodes;
    if (finalEpisodes.length === 0) {
      if (detectedKind === "movie" || detectedKind === "open_archive") {
        finalEpisodes = [
          {
            number: 1,
            title: "Película Completa",
            url: detectedStreams[0] || urlOrQuery,
          },
        ];
      } else if (detectedStreams.length > 0) {
        finalEpisodes = detectedStreams.map((st, idx) => ({
          number: idx + 1,
          title: `Episodio / Opción ${idx + 1}`,
          url: st,
        }));
      } else {
        // Use the current page URL as Episode 1 so just-in-time extraction resolves it when played
        finalEpisodes = [
          {
            number: 1,
            title: "Episodio 1",
            url: urlOrQuery,
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
      detected_streams: finalStreams,
      episodes: finalEpisodes,
      catalog_items: catalogItems,
      raw_metadata: {
        og: { title: ogTitle, description: ogDesc, image: ogImage },
        embeds: finalStreams,
      },
    };
  } catch (err: any) {
    return handleSearchTerm(urlOrQuery);
  }
}

/**
 * Extracts live playable stream URLs, iframes, and server embeds from HTML and scripts.
 */
function extractEmbedsAndStreamsFromHtml($: cheerio.CheerioAPI, html: string, baseUrl: string): string[] {
  const streams: string[] = [];

  // 1. AnimeFLV var videos = { "SUB": [ ... ] }
  const videoObjectMatch = html.match(/var\s+videos\s*=\s*(\{.+?\});/s);
  if (videoObjectMatch) {
    try {
      const parsed = JSON.parse(videoObjectMatch[1]);
      const servers = parsed.SUB || parsed.LAT || parsed.ENG || Object.values(parsed)[0] || [];
      if (Array.isArray(servers)) {
        servers.forEach((srv: any) => {
          if (srv.code && typeof srv.code === "string") {
            const cleanCode = srv.code.replace(/\\/g, "");
            if (!streams.includes(cleanCode)) streams.push(cleanCode);
          } else if (srv.url && typeof srv.url === "string") {
            if (!streams.includes(srv.url)) streams.push(srv.url);
          }
        });
      }
    } catch {}
  }

  // 2. <video> & <source> tags
  $("video source, video").each((_, el) => {
    const src = $(el).attr("src");
    if (src && !streams.includes(src)) {
      streams.push(resolveRelativeUrl(src, baseUrl));
    }
  });

  // 3. <iframe> tags (embed players)
  $("iframe").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-player");
    if (src && !streams.includes(src)) {
      streams.push(resolveRelativeUrl(src, baseUrl));
    }
  });

  // 4. Data attributes on elements (e.g. data-video, data-server, data-url, data-iframe)
  $("[data-video], [data-server], [data-url], [data-src], [data-player], [data-embed]").each((_, el) => {
    const val = $(el).attr("data-video") || $(el).attr("data-url") || $(el).attr("data-src") || $(el).attr("data-player") || $(el).attr("data-embed") || "";
    if (val) {
      if (val.startsWith("http://") || val.startsWith("https://") || val.startsWith("//")) {
        const resolved = resolveRelativeUrl(val, baseUrl);
        if (!streams.includes(resolved)) streams.push(resolved);
      } else if (isBase64(val)) {
        try {
          const decoded = Buffer.from(val, "base64").toString("utf-8");
          if (decoded.startsWith("http")) {
            if (!streams.includes(decoded)) streams.push(decoded);
          }
        } catch {}
      }
    }
  });

  // 5. Scan regex for known streaming hosts in scripts
  const hostRegex = /https?:\/\/(?:www\.)?(?:mega\.nz|streamtape\.com|mp4upload\.com|yourupload\.com|streamwish\.[a-z]+|filemoon\.[a-z]+|voe\.[a-z]+|dood\.[a-z]+|ok\.ru|vidstream\.[a-z]+|fembed\.[a-z]+|mixdrop\.[a-z]+|uqload\.[a-z]+|upstream\.[a-z]+|embedsito\.[a-z]+|streamlare\.[a-z]+|fastre\.[a-z]+)\/[^\s"'<>]+/gi;
  const hostMatches = html.match(hostRegex);
  if (hostMatches) {
    hostMatches.forEach((m) => {
      const clean = m.replace(/\\/g, "");
      if (!streams.includes(clean)) streams.push(clean);
    });
  }

  // 6. Scan for direct .m3u8 or .mp4 files inside scripts
  const mediaFileRegex = /https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4|webm)[^\s"'<>]*/gi;
  const mediaMatches = html.match(mediaFileRegex);
  if (mediaMatches) {
    mediaMatches.forEach((m) => {
      const clean = m.replace(/\\/g, "");
      if (!streams.includes(clean)) streams.push(clean);
    });
  }

  return streams;
}

function resolveRelativeUrl(url: string, base: string): string {
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function isBase64(str: string): boolean {
  if (str.length < 8 || str.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(str);
}

/**
 * Extracts live playable stream URLs in real time (Just-In-Time) from any URL
 */
export async function extractStreamFromUrl(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
  const cleanUrl = targetUrl.trim();

  // If already direct stream
  if (isDirectStreamUrl(cleanUrl)) {
    return {
      stream_url: cleanUrl,
      all_available_streams: [cleanUrl],
    };
  }

  // If Archive.org
  if (cleanUrl.includes("archive.org/details/")) {
    const res = await handleArchiveOrg(cleanUrl);
    const streams = res.detected_streams || [];
    return {
      stream_url: streams[0] || cleanUrl,
      all_available_streams: streams.length > 0 ? streams : [cleanUrl],
      title: res.title,
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(cleanUrl, {
      signal: controller.signal,
      headers: COMMON_HEADERS,
    });
    clearTimeout(timer);

    if (!response.ok) {
      return {
        stream_url: cleanUrl,
        all_available_streams: [cleanUrl],
      };
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const rawStreams = extractEmbedsAndStreamsFromHtml($, html, cleanUrl);

    // Resolve iframe & embed URLs using EmbedResolvers
    const resolvedStreams: string[] = [];
    for (const stream of rawStreams) {
      const resolved = await EmbedResolvers.resolve(stream);
      resolvedStreams.push(resolved || stream);
    }

    // Validate URLs with MediaValidator
    const validStreams = await MediaValidator.validateUrls(resolvedStreams);
    let finalStreams = validStreams;
    if (finalStreams.length === 0) {
      finalStreams = resolvedStreams.length > 0 ? resolvedStreams : [cleanUrl];
    }

    return {
      stream_url: finalStreams[0],
      all_available_streams: finalStreams,
      title: $("title").text() || undefined,
    };
  } catch {
    return {
      stream_url: cleanUrl,
      all_available_streams: [cleanUrl],
    };
  }
}

function isDirectStreamUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes(".m3u8") ||
    lower.includes(".mp4") ||
    lower.includes(".webm") ||
    lower.includes(".mkv") ||
    lower.includes("archive.org/download/")
  );
}

function handleDirectStream(streamUrl: string): UniversalAnalysisResult {
  let title = "Stream de Video";
  try {
    const urlObj = new URL(streamUrl);
    const filename = urlObj.pathname.split("/").pop() || "";
    if (filename) {
      title = filename.replace(/\.(m3u8|mp4|webm|mkv)$/i, "").replace(/[-_]/g, " ");
    }
  } catch {}

  return {
    page_type: "direct_stream",
    content_type: "movie",
    title: cleanQueryTitle(title) || "Stream Multimedia",
    description: "Fuente de video directa indexada con compatibilidad HLS / MP4 nativa.",
    poster_url: null,
    banner_url: null,
    rating: 8.5,
    year: new Date().getFullYear(),
    status: "Directo",
    genres: ["Stream HLS", "Video HD"],
    detected_streams: [streamUrl],
    episodes: [
      {
        number: 1,
        title: "Reproducción Principal",
        url: streamUrl,
      },
    ],
    catalog_items: [],
  };
}

async function handleArchiveOrg(archiveUrl: string): Promise<UniversalAnalysisResult> {
  const match = archiveUrl.match(/archive\.org\/details\/([^\/\?#]+)/);
  const identifier = match ? match[1] : "";

  let title = identifier.replace(/[-_]/g, " ");
  let desc = "Película o archivo de libre distribución en Internet Archive.";
  let poster = `https://archive.org/services/img/${identifier}`;
  const detectedStreams: string[] = [];

  if (identifier) {
    try {
      const metaRes = await fetch(`https://archive.org/metadata/${identifier}`, { headers: COMMON_HEADERS });
      if (metaRes.ok) {
        const metaData: any = await metaRes.json();
        if (metaData.metadata) {
          title = metaData.metadata.title || title;
          desc = metaData.metadata.description || desc;
        }
        if (Array.isArray(metaData.files)) {
          metaData.files.forEach((f: any) => {
            const name: string = f.name || "";
            if (name.endsWith(".mp4") || name.endsWith(".m3u8") || name.endsWith(".ogv")) {
              detectedStreams.push(`https://archive.org/download/${identifier}/${encodeURIComponent(name)}`);
            }
          });
        }
      }
    } catch {}
  }

  if (detectedStreams.length === 0 && identifier) {
    detectedStreams.push(`https://archive.org/download/${identifier}/${identifier}.mp4`);
  }

  return {
    page_type: "detail",
    content_type: "open_archive",
    title: cleanQueryTitle(title),
    description: desc,
    poster_url: poster,
    banner_url: poster,
    rating: 8.2,
    year: 1968,
    status: "Dominio Público",
    genres: ["Cine Clásico", "Dominio Público", "Película"],
    detected_streams: detectedStreams,
    episodes: [
      {
        number: 1,
        title: "Película Completa",
        url: detectedStreams[0] || archiveUrl,
      },
    ],
    catalog_items: [],
  };
}

async function handleSearchTerm(query: string): Promise<UniversalAnalysisResult> {
  const cleaned = cleanQueryTitle(query);

  // Try searching AnimeFLV to return real catalog items with their cover images
  const animeflvItems: ExtractedCatalogItem[] = [];
  try {
    const searchUrl = `https://www3.animeflv.net/browse?q=${encodeURIComponent(cleaned)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(searchUrl, {
      signal: controller.signal,
      headers: COMMON_HEADERS,
    });
    clearTimeout(timer);

    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);
      const cardSelectors = [
        "ul.ListAnimes > li", "article.anime", "article", ".anime-card", ".item", ".film", ".card",
        "li.anime", "ul.animes > li", ".list-animes > li", ".grid > div"
      ];
      let cards = $([]);
      for (const selector of cardSelectors) {
        const found = $(selector);
        if (found.length > 0) {
          cards = found;
          break;
        }
      }

      cards.each((_, card) => {
        const item = extractAnimeflvCard($, card);
        if (item && !animeflvItems.some((i) => i.url === item.url)) {
          animeflvItems.push(item);
        }
      });
    }
  } catch (e) {
    console.error("Error al buscar en AnimeFLV:", e);
  }

  const enriched = await enrichUniversalMetadata(cleaned);

  const primaryUrl = animeflvItems[0]?.url || `https://www3.animeflv.net/anime/${cleaned.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  const defaultEpisodes: ExtractedEpisode[] = (enriched.suggested_episodes && enriched.suggested_episodes.length > 0)
    ? enriched.suggested_episodes.map((s) => ({
        number: s.number,
        title: s.title,
        url: s.url || primaryUrl,
      }))
    : [
        {
          number: 1,
          title: "Episodio 1",
          url: primaryUrl,
        },
      ];

  const posterUrl = enriched.poster_url || (animeflvItems[0]?.image_url || null);

  return {
    page_type: animeflvItems.length > 0 ? "catalog" : "detail",
    content_type: enriched.content_type || "anime",
    title: animeflvItems[0]?.title || enriched.title,
    original_title: enriched.original_title,
    japanese_title: enriched.japanese_title,
    english_title: enriched.english_title,
    description: enriched.description || `Resultados de búsqueda para '${query}'`,
    poster_url: posterUrl,
    banner_url: enriched.banner_url || posterUrl,
    rating: enriched.rating,
    year: enriched.year,
    status: enriched.status,
    genres: enriched.genres,
    episodes: defaultEpisodes,
    catalog_items: animeflvItems,
  };
}

/**
 * Extracts catalog items from a given page URL (used by background task worker for pagination)
 */
export async function extractCatalogListing(catalogUrl: string): Promise<ExtractedCatalogItem[]> {
  const result = await analyzeUniversalUrl(catalogUrl);
  return result.catalog_items || [];
}

function extractShowUrlFromAnchors($: cheerio.CheerioAPI, anchors: cheerio.Cheerio<cheerio.Element>, urlOrQuery: string, domain: string): string | null {
  let showUrl: string | null = null;
  anchors.each((_, a) => {
    const href = ($(a).attr("href") || "").trim();
    if (!href) return;

    let fullUrl = href;
    if (!fullUrl.startsWith("http")) {
      try {
        fullUrl = new URL(href, urlOrQuery).toString();
      } catch {
        return;
      }
    }

    try {
      const parsed = new URL(fullUrl);
      if (parsed.hostname.toLowerCase() === domain) {
        const pathLower = parsed.pathname.toLowerCase();
        if (
          pathLower !== "" &&
          pathLower !== "/" &&
          pathLower !== "/home" &&
          pathLower !== "/inicio" &&
          !["/category/", "/genre/", "/tag/", "/page/", "/browse", "#", "javascript:"].some((b) => pathLower.includes(b))
        ) {
          showUrl = fullUrl;
          return false;
        }
      }
    } catch {}
  });
  return showUrl;
}

function extractCardImgUrl($: cheerio.CheerioAPI, card: cheerio.Element, urlOrQuery: string): string | null {
  const img = $(card).find("img").first();
  if (img.length === 0) return null;
  const imgSrc = img.attr("data-src") || img.attr("data-lazy-src") || img.attr("data-original") || img.attr("srcset") || img.attr("src") || "";
  if (!imgSrc) return null;
  const firstSrc = imgSrc.split(/\s+/)[0];
  try {
    return new URL(firstSrc, urlOrQuery).toString();
  } catch {
    return firstSrc.startsWith("//") ? `https:${firstSrc}` : firstSrc;
  }
}

function extractCatalogCardTitle($: cheerio.CheerioAPI, card: cheerio.Element, anchors: cheerio.Cheerio<cheerio.Element>, showUrl: string): string {
  const heading = $(card).find("h1, h2, h3, h4, h5, strong, .title, .entry-title").first();
  if (heading.length > 0 && heading.text().trim().length > 1) {
    return heading.text().trim();
  }

  const img = $(card).find("img").first();
  if (img.length > 0 && img.attr("alt")) {
    return img.attr("alt")!.trim();
  }

  let anchorTitle = "";
  anchors.each((_, a) => {
    const t = $(a).text().trim() || $(a).attr("title") || "";
    if (t.length > 1 && !["ver", "anime", "leer"].some((b) => t.toLowerCase().includes(b))) {
      anchorTitle = t;
      return false;
    }
  });
  if (anchorTitle) return anchorTitle;

  if (showUrl) {
    const parts = showUrl.replace(/\/$/, "").split("/");
    return parts[parts.length - 1].replace(/[-_]/g, " ");
  }

  return "";
}

function extractAnimeflvCard($: cheerio.CheerioAPI, card: cheerio.Element): ExtractedCatalogItem | null {
  const animeAnchor = $(card).find("a[href*='/anime/']").first();
  const anchor = animeAnchor.length > 0 ? animeAnchor : $(card).find("a[href]").first();

  if (anchor.length === 0) return null;
  const href = (anchor.attr("href") || "").trim();
  if (!href) return null;

  let fullUrl = href;
  if (!fullUrl.startsWith("http")) {
    try {
      fullUrl = new URL(href, "https://www3.animeflv.net").toString();
    } catch {
      return null;
    }
  }

  const img = $(card).find("img").first();
  let imgUrl: string | null = null;
  if (img.length > 0) {
    const imgSrc =
      img.attr("data-src") ||
      img.attr("data-cfsrc") ||
      img.attr("data-lazy-src") ||
      img.attr("data-original") ||
      img.attr("srcset") ||
      img.attr("src") ||
      "";
    if (imgSrc) {
      const firstSrc = imgSrc.split(/\s+/)[0];
      try {
        imgUrl = new URL(firstSrc, "https://www3.animeflv.net").toString();
      } catch {
        imgUrl = firstSrc.startsWith("//") ? `https:${firstSrc}` : firstSrc;
      }
    }
  }

  let cardTitle = "";
  const heading = $(card).find("h1, h2, h3, h4, h5, strong, .Title, .title").first();
  if (heading.length > 0 && heading.text().trim().length > 1) {
    cardTitle = heading.text().trim();
  }
  if (!cardTitle && img.length > 0 && img.attr("alt")) {
    cardTitle = img.attr("alt")!.trim();
  }
  if (!cardTitle) {
    cardTitle = anchor.text().trim() || anchor.attr("title") || "";
  }

  if (!cardTitle || !fullUrl) return null;

  return {
    title: cleanQueryTitle(cardTitle),
    url: fullUrl,
    image_url: imgUrl,
    kind: "anime",
  };
}

