import os

file_path = 'server/universalScraper.ts'
with open(file_path, 'r') as f:
    content = f.read()

# Extraccion de lineas 291 para bajar complejidad (cards.each)
new_func_291 = """
  private static parseArchiveOrgItems($: cheerio.CheerioAPI, baseUrl: string, results: ExtractedCatalogItem[]) {
    const cards = $(".item-ia, .result-item, article");
    cards.each((_, card) => {
      const el = $(card);
      const relativeUrl = el.find("a.title-link, a.stealth").attr("href") || el.find("a").attr("href");
      let title = el.find(".title, .item-title, h2, h3").text().trim();
      const poster = el.find("img.item-img, img").attr("src");

      if (relativeUrl && title) {
        if (!title) title = "Contenido sin título";
        const fullUrl = new URL(relativeUrl, baseUrl).href;
        let finalPoster = poster;
        if (poster && poster.startsWith("/")) {
          finalPoster = new URL(poster, baseUrl).href;
        }

        results.push({
          title,
          url: fullUrl,
          poster_url: finalPoster || undefined,
        });
      }
    });
  }
"""

content = content.replace("export async function extractCatalogListing(url: string): Promise<ExtractedCatalogItem[]> {", new_func_291 + "\nexport async function extractCatalogListing(url: string): Promise<ExtractedCatalogItem[]> {")

content = content.replace("""    const cards = $(".item-ia, .result-item, article");
    cards.each((_, card) => {
      const el = $(card);
      const relativeUrl = el.find("a.title-link, a.stealth").attr("href") || el.find("a").attr("href");
      let title = el.find(".title, .item-title, h2, h3").text().trim();
      const poster = el.find("img.item-img, img").attr("src");

      if (relativeUrl && title) {
        if (!title) title = "Contenido sin título";
        const fullUrl = new URL(relativeUrl, baseUrl).href;
        let finalPoster = poster;
        if (poster && poster.startsWith("/")) {
          finalPoster = new URL(poster, baseUrl).href;
        }

        results.push({
          title,
          url: fullUrl,
          poster_url: finalPoster || undefined,
        });
      }
    });""", "this.parseArchiveOrgItems($, baseUrl, results);")


with open(file_path, 'w') as f:
    f.write(content)
print("done")
