import * as cheerio from "cheerio";

export type PageType = "collection" | "detail" | "episode";

export class PageClassifier {
  /**
   * Clasifica semánticamente una página evaluando señales de DOM y URL por puntuación (scoring)
   */
  public static classify(url: string, $: cheerio.CheerioAPI): PageType {
    const scores = { collection: 0, detail: 0, episode: 0 };
    const urlLower = url.toLowerCase();

    let pathname = "";
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch {
      pathname = urlLower;
    }

    const isPaginationOrCatalogPath =
      ["/browse", "/animes", "/catalog", "/category", "/genre", "/search", "/simulcasts", "/directory"].some((p) => pathname.includes(p)) ||
      ["?page=", "?p=", "/page/"].some((p) => urlLower.includes(p));

    // --- 1. Señales de URL ---
    PageClassifier.evaluateUrlSignals(pathname, isPaginationOrCatalogPath, scores);

    // --- 2. Señales de DOM: Collection ---
    PageClassifier.evaluateCollectionSignals($, scores);

    // --- 3. Señales de DOM: Detail ---
    PageClassifier.evaluateDetailSignals($, isPaginationOrCatalogPath, scores);

    // --- 4. Señales de DOM: Episode ---
    PageClassifier.evaluateEpisodeSignals($, scores);

    // Determinar ganador por mayor puntaje (mínimo 2 puntos)
    let winner: PageType = "detail";
    let maxScore = -1;

    (Object.keys(scores) as PageType[]).forEach((key) => {
      if (scores[key] > maxScore) {
        maxScore = scores[key];
        winner = key;
      }
    });

    return maxScore >= 2 ? winner : "detail";
  }

  private static evaluateUrlSignals(pathname: string, isPaginationOrCatalogPath: boolean, scores: { collection: number; detail: number; episode: number }) {
    if (isPaginationOrCatalogPath) {
      scores.collection += 4;
    }

    if (
      ["/anime/", "/series/", "/movie/", "/title/", "/show/"].some((p) => pathname.includes(p)) &&
      !isPaginationOrCatalogPath &&
      !/(episodio|episode|watch|capitulo)/i.test(pathname)
    ) {
      scores.detail += 2;
    }

    if (/(episodio|episode|watch|video|play|\bep-\d+)/i.test(pathname)) {
      scores.episode += 3;
    }
  }

  private static evaluateCollectionSignals($: cheerio.CheerioAPI, scores: { collection: number }) {
    const cards = $("article, .item, .card, .film, .anime-card, li.anime, .post, .hentry, .ht_grid_1_4, .type-post, .browse-item");
    const images = $("img");
    const links = $("a[href]");

    if (cards.length >= 4) scores.collection += 4;
    if (images.length >= 10 && links.length >= 15) scores.collection += 2;
    if ($("ul.pagination, .nav-links, a[rel='next'], a.next, .pagination, .page-numbers").length > 0) {
      scores.collection += 3;
    }
  }

  private static evaluateDetailSignals($: cheerio.CheerioAPI, isPaginationOrCatalogPath: boolean, scores: { detail: number; episode: number }) {
    const h1Text = $("h1").text().trim();
    if (h1Text.length > 2 && !isPaginationOrCatalogPath) {
      scores.detail += 2;
    }

    const ogDesc = $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
    if (ogDesc.length > 60 && !isPaginationOrCatalogPath) {
      scores.detail += 2;
    }

    let episodeLinkCount = 0;
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (/(episodio|episode|capitulo)/i.test(href)) episodeLinkCount++;
    });

    if (episodeLinkCount >= 2 || $(".episodes, .episode-list, #episodes, .animeflv-episodes-data").length > 0) {
      scores.detail += 4;
    }

    $('script[type="application/ld+json"]').each((_, el) => {
      const text = $(el).html() || "";
      if (text.includes("TVSeries") || text.includes("Movie")) scores.detail += 3;
      if (text.includes("TVEpisode") || text.includes("VideoObject")) scores.episode += 3;
    });
  }

  private static evaluateEpisodeSignals($: cheerio.CheerioAPI, scores: { episode: number }) {
    if ($("iframe, video, .player, #player, .video-player").length > 0) {
      scores.episode += 3;
    }
  }
}
