import os

file_path = 'server/pageClassifier.ts'
with open(file_path, 'r') as f:
    content = f.read()

new_func = """
  private static scoreUrlSignals(urlLower: string, pathname: string, scores: { collection: number, detail: number, episode: number }) {
    const isPaginationOrCatalogPath =
      ["/browse", "/animes", "/catalog", "/category", "/genre", "/search", "/simulcasts", "/directory"].some((p) => pathname.includes(p)) ||
      ["?page=", "?p=", "/page/"].some((p) => urlLower.includes(p));

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

    if (/(episodio|episode|watch|video|play|\\bep-\\d+)/i.test(pathname)) {
      scores.episode += 3;
    }
  }

  private static scoreDomSignals($: cheerio.CheerioAPI, scores: { collection: number, detail: number, episode: number }) {
    const cards = $("article, .item, .card, .film, .anime-card, li.anime, .post, .hentry, .ht_grid_1_4, .type-post, .browse-item");
    if (cards.length >= 4) scores.collection += 4;
    if ($("img").length >= 10 && $("a[href]").length >= 15) scores.collection += 2;
    if ($("ul.pagination, .nav-links, a[rel='next'], a.next, .pagination, .page-numbers").length > 0) scores.collection += 3;

    if ($("h1, h2").text().toLowerCase().match(/sinopsis|descripción|reparto|géneros|temporadas|episodes|trailer/i)) scores.detail += 3;
    if ($("ul.episodes, .episode-list, .lista-episodios, .ep-list, table.episodes").length > 0) scores.detail += 4;
    if ($("img[src*='poster'], img[src*='cover']").length > 0) scores.detail += 1;

    if ($("video, iframe[src*='embed'], iframe[allowfullscreen], #player, .video-container, .player, #vplayer").length > 0) scores.episode += 6;
    if ($("h1, h2, title").text().toLowerCase().match(/(episodio \d+|capitulo \d+|ep \d+|episode \d+)/i)) scores.episode += 4;
    if ($("a:contains('Siguiente'), a:contains('Anterior'), a:contains('Next Ep')").length > 0) scores.episode += 2;
  }

  public static classify(url: string, $: cheerio.CheerioAPI): PageType {
    const scores = { collection: 0, detail: 0, episode: 0 };
    const urlLower = url.toLowerCase();
    let pathname = urlLower;
    try { pathname = new URL(url).pathname.toLowerCase(); } catch {}

    this.scoreUrlSignals(urlLower, pathname, scores);
    this.scoreDomSignals($, scores);

    let maxScore = 0;
    let result: PageType = "collection";

    for (const [type, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        result = type as PageType;
      }
    }
    return result;
  }
"""

content = content.replace("""  public static classify(url: string, $: cheerio.CheerioAPI): PageType {
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

    // --- 2. Señales de DOM: Collection ---
    const cards = $("article, .item, .card, .film, .anime-card, li.anime, .post, .hentry, .ht_grid_1_4, .type-post, .browse-item");
    const images = $("img");
    const links = $("a[href]");

    if (cards.length >= 4) scores.collection += 4;
    if (images.length >= 10 && links.length >= 15) scores.collection += 2;
    if ($("ul.pagination, .nav-links, a[rel='next'], a.next, .pagination, .page-numbers").length > 0) {
      scores.collection += 3;
    }

    // --- 3. Señales de DOM: Detail ---
    const headings = $("h1, h2, h3").text().toLowerCase();
    if (/(sinopsis|descripción|reparto|géneros|temporadas|episodes|trailer)/i.test(headings)) {
      scores.detail += 3;
    }
    if ($("ul.episodes, .episode-list, .lista-episodios, .ep-list, table.episodes, #episodes").length > 0) {
      scores.detail += 4;
    }
    if ($("img[src*='poster'], img[src*='cover']").length > 0) {
      scores.detail += 1;
    }

    // --- 4. Señales de DOM: Episode / Watch ---
    const hasPlayer = $("video, iframe[src*='embed'], iframe[allowfullscreen], #player, .video-container, .player, #vplayer").length > 0;
    if (hasPlayer) {
      scores.episode += 6;
    }

    if (/(episodio\s+\d+|capitulo\s+\d+|ep\s+\d+|episode\s+\d+)/i.test($("h1, h2, title").text())) {
      scores.episode += 4;
    }

    if ($("a:contains('Siguiente'), a:contains('Anterior'), a:contains('Next Ep')").length > 0) {
      scores.episode += 2;
    }

    // --- 5. Resolución ---
    let maxScore = -1;
    let finalType: PageType = "collection";

    for (const [type, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        finalType = type as PageType;
      }
    }

    return finalType;
  }""", new_func)

with open(file_path, 'w') as f:
    f.write(content)
print("done")
