import os

file_path = 'server/universalScraper.ts'
with open(file_path, 'r') as f:
    content = f.read()


new_func_778 = """
  private static parseGenericCatalogItems($: cheerio.CheerioAPI, baseUrl: string, results: ExtractedCatalogItem[]) {
    const cards = $("article, .item, .card, .film, .anime-card, li.anime, .post, .hentry, .ht_grid_1_4, .type-post, .browse-item, .flw-item");
    if (cards.length > 0) {
      cards.each((_, card) => {
        const el = $(card);
        const linkEl = el.find("a").first();
        const relativeUrl = linkEl.attr("href");

        let title = el.find("h2, h3, .title, .name, .film-name").text().trim();
        if (!title) title = linkEl.attr("title") || linkEl.text().trim();
        if (!title) title = el.find("img").attr("alt") || "";

        let poster = el.find("img").attr("src") || el.find("img").attr("data-src") || el.find("img").attr("data-lazy-src");

        if (relativeUrl && title && title.length > 1) {
          try {
            const fullUrl = new URL(relativeUrl, baseUrl).href;
            let finalPoster = poster;
            if (poster && !poster.startsWith("http")) {
              finalPoster = new URL(poster, baseUrl).href;
            }

            if (results.findIndex((r) => r.url === fullUrl) === -1) {
              results.push({
                title,
                url: fullUrl,
                poster_url: finalPoster || undefined,
              });
            }
          } catch (e) {}
        }
      });
    } else {
      // Fallback
      $("a[href]").each((_, a) => {
        const el = $(a);
        const relativeUrl = el.attr("href");
        const title = el.text().trim() || el.attr("title")?.trim();

        if (relativeUrl && title && title.length > 3 && !title.toLowerCase().includes("page")) {
          try {
            const fullUrl = new URL(relativeUrl, baseUrl).href;
            const pathname = new URL(fullUrl).pathname.toLowerCase();
            if (
              ["/anime/", "/series/", "/movie/", "/title/", "/show/", "/pelicula/"].some((p) => pathname.includes(p)) ||
              (pathname.split("/").length > 2 && !pathname.includes("category") && !pathname.includes("genre"))
            ) {
              if (results.findIndex((r) => r.url === fullUrl) === -1) {
                results.push({
                  title,
                  url: fullUrl,
                });
              }
            }
          } catch (e) {}
        }
      });
    }
  }
"""

content = content.replace("export async function analyzeUniversalUrl(targetUrl: string): Promise<UniversalAnalysisResult> {", new_func_778 + "\nexport async function analyzeUniversalUrl(targetUrl: string): Promise<UniversalAnalysisResult> {")

content = content.replace("""    const cards = $("article, .item, .card, .film, .anime-card, li.anime, .post, .hentry, .ht_grid_1_4, .type-post, .browse-item, .flw-item");
    if (cards.length > 0) {
      cards.each((_, card) => {
        const el = $(card);
        const linkEl = el.find("a").first();
        const relativeUrl = linkEl.attr("href");

        let title = el.find("h2, h3, .title, .name, .film-name").text().trim();
        if (!title) {
          title = linkEl.attr("title") || linkEl.text().trim();
        }
        if (!title) {
          title = el.find("img").attr("alt") || "";
        }

        let poster = el.find("img").attr("src") || el.find("img").attr("data-src") || el.find("img").attr("data-lazy-src");

        if (relativeUrl && title && title.length > 1) {
          try {
            const fullUrl = new URL(relativeUrl, baseUrl).href;
            let finalPoster = poster;
            if (poster && !poster.startsWith("http")) {
              finalPoster = new URL(poster, baseUrl).href;
            }

            if (results.findIndex((r) => r.url === fullUrl) === -1) {
              results.push({
                title,
                url: fullUrl,
                poster_url: finalPoster || undefined,
              });
            }
          } catch (e) {}
        }
      });
    } else {
      // Fallback a enlaces generales si no hay cards claras
      $("a[href]").each((_, a) => {
        const el = $(a);
        const relativeUrl = el.attr("href");
        const title = el.text().trim() || el.attr("title")?.trim();

        if (relativeUrl && title && title.length > 3 && !title.toLowerCase().includes("page")) {
          try {
            const fullUrl = new URL(relativeUrl, baseUrl).href;
            // Filtrar enlaces de UI (tags, genres, about)
            const pathname = new URL(fullUrl).pathname.toLowerCase();
            if (
              ["/anime/", "/series/", "/movie/", "/title/", "/show/", "/pelicula/"].some((p) => pathname.includes(p)) ||
              (pathname.split("/").length > 2 && !pathname.includes("category") && !pathname.includes("genre"))
            ) {
              if (results.findIndex((r) => r.url === fullUrl) === -1) {
                results.push({
                  title,
                  url: fullUrl,
                });
              }
            }
          } catch (e) {}
        }
      });
    }""", "UniversalScraper.parseGenericCatalogItems($, baseUrl, results);")

with open(file_path, 'w') as f:
    f.write(content)
print("done")
