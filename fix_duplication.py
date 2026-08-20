import os

# 1. Fix metadataEngine.ts clones
with open('server/metadataEngine.ts', 'r') as f:
    content = f.read()

content = content.replace("""        return {
          title: attr.canonicalTitle || attr.titles?.en_jp || attr.titles?.en || query,
          original_title: attr.titles?.ja_jp || undefined,
          description: attr.synopsis ? sanitizeHtml(attr.synopsis, { allowedTags: [] }).trim() : "Sin descripción disponible.",
          poster_url: poster,
          banner_url: cover,
          rating: attr.averageRating ? Math.round((parseFloat(attr.averageRating) / 10) * 10) / 10 : 8.0,
          year: attr.startDate ? parseInt(attr.startDate.slice(0, 4), 10) : 2024,
          status: attr.status === "current" ? "En emisión" : "Finalizado",
          genres: ["Anime"],
          content_type: "anime",
        };
      }
    }
  } catch {
    // ignore
  }""", """        return {
          title: attr.canonicalTitle || attr.titles?.en_jp || attr.titles?.en || query,
          original_title: attr.titles?.ja_jp || undefined,
          description: attr.synopsis ? sanitizeHtml(attr.synopsis, { allowedTags: [] }).trim() : "Sin descripción disponible.",
          poster_url: poster,
          banner_url: cover,
          rating: attr.averageRating ? Math.round((parseFloat(attr.averageRating) / 10) * 10) / 10 : 8.0,
          year: attr.startDate ? parseInt(attr.startDate.slice(0, 4), 10) : 2024,
          status: attr.status === "current" ? "En emisión" : "Finalizado",
          genres: ["Anime"],
          content_type: "anime",
        };
      }
    }
  } catch {}""")

with open('server/metadataEngine.ts', 'w') as f:
    f.write(content)

# 2. Fix resolvers.ts clones
with open('server/resolvers.ts', 'r') as f:
    content = f.read()

new_resolve = """
  private static async fetchTextWithTimeout(url: string): Promise<string> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);

      const res = await fetch(url, { signal: controller.signal, headers: this.DEFAULT_HEADERS });
      clearTimeout(timer);

      if (!res.ok) return "";
      return await res.text();
    } catch {
      return "";
    }
  }

  private static async extractPattern(url: string, pattern: RegExp): Promise<string> {
    const text = await this.fetchTextWithTimeout(url);
    if (!text) return "";
    const match = text.match(pattern);
    return match ? match[1] : "";
  }

  private static async resolveGeneric(url: string): Promise<string> {
    const html = await this.fetchTextWithTimeout(url);
    if (!html) return "";
    const directUrlMatch = html.match(/source\s*src=["']([^"']+)["']/i) || html.match(/file\s*:\s*["']([^"']+)["']/i);
    return directUrlMatch ? directUrlMatch[1] : "";
  }
"""

content = content.replace("""  private static async extractPattern(url: string, pattern: RegExp): Promise<string> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);

      const res = await fetch(url, { signal: controller.signal, headers: this.DEFAULT_HEADERS });
      clearTimeout(timer);

      if (!res.ok) return "";
      const text = await res.text();
      const match = text.match(pattern);
      return match ? match[1] : "";
    } catch {
      return "";
    }
  }

  private static async resolveGeneric(url: string): Promise<string> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);

      const res = await fetch(url, { signal: controller.signal, headers: this.DEFAULT_HEADERS });
      clearTimeout(timer);

      if (!res.ok) return "";
      const html = await res.text();
      const directUrlMatch = html.match(/source\s*src=["']([^"']+)["']/i) || html.match(/file\s*:\s*["']([^"']+)["']/i);
      return directUrlMatch ? directUrlMatch[1] : "";
    } catch {
      return "";
    }
  }""", new_resolve)

with open('server/resolvers.ts', 'w') as f:
    f.write(content)

# 3. Fix taskWorker.ts clones
with open('server/taskWorker.ts', 'r') as f:
    content = f.read()

new_mapping = """
  private mapPrismaJobToCrawlJob(t: any): CrawlJob {
    return {
      id: t.id,
      name: t.name,
      target_url: t.target_url,
      status: t.status as CrawlJob["status"],
      scope: t.scope as CrawlJob["scope"],
      max_pages: t.max_pages,
      current_page: t.current_page,
      total_discovered: t.total_discovered,
      shows_imported: t.shows_imported,
      episodes_imported: t.episodes_imported,
      rate_limit_delay_ms: t.rate_limit_delay_ms,
      items_queue: (t.items_queue as any) || [],
      current_item_title: t.current_item_title || undefined,
      error_message: t.error_message,
      created_at: t.created_at.toISOString(),
      updated_at: t.updated_at.toISOString(),
      logs: (t.logs as any) || [],
    };
  }
"""

content = content.replace("  public async getJobs(): Promise<CrawlJob[]> {", new_mapping + "\n  public async getJobs(): Promise<CrawlJob[]> {")
content = content.replace("""      return tasks.map((t) => ({
        id: t.id,
        name: t.name,
        target_url: t.target_url,
        status: t.status as CrawlJob["status"],
        scope: t.scope as CrawlJob["scope"],
        max_pages: t.max_pages,
        current_page: t.current_page,
        total_discovered: t.total_discovered,
        shows_imported: t.shows_imported,
        episodes_imported: t.episodes_imported,
        rate_limit_delay_ms: t.rate_limit_delay_ms,
        items_queue: (t.items_queue as any) || [],
        current_item_title: t.current_item_title || undefined,
        error_message: t.error_message,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at.toISOString(),
        logs: (t.logs as any) || [],
      }));""", "      return tasks.map((t) => this.mapPrismaJobToCrawlJob(t));")

content = content.replace("""      return {
        id: t.id,
        name: t.name,
        target_url: t.target_url,
        status: t.status as CrawlJob["status"],
        scope: t.scope as CrawlJob["scope"],
        max_pages: t.max_pages,
        current_page: t.current_page,
        total_discovered: t.total_discovered,
        shows_imported: t.shows_imported,
        episodes_imported: t.episodes_imported,
        rate_limit_delay_ms: t.rate_limit_delay_ms,
        items_queue: (t.items_queue as any) || [],
        current_item_title: t.current_item_title || undefined,
        error_message: t.error_message,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at.toISOString(),
        logs: (t.logs as any) || [],
      };""", "      return this.mapPrismaJobToCrawlJob(t);")

with open('server/taskWorker.ts', 'w') as f:
    f.write(content)

# 4. Fix universalScraper.ts clones
with open('server/universalScraper.ts', 'r') as f:
    content = f.read()

new_card_title = """
  private static extractCardTitle(card: cheerio.Cheerio, img: cheerio.Cheerio): string {
    const heading = card.find("h1, h2, h3, h4, h5, strong, .Title, .title, .entry-title").first();
    if (heading.length > 0 && heading.text().trim().length > 1) {
      return heading.text().trim();
    }
    if (img.length > 0 && img.attr("alt")) {
      return img.attr("alt")!.trim();
    }
    return "";
  }
"""

content = content.replace("export async function extractCatalogListing(url: string): Promise<ExtractedCatalogItem[]> {", new_card_title + "\nexport async function extractCatalogListing(url: string): Promise<ExtractedCatalogItem[]> {")

content = content.replace("""      const heading = $(card).find("h1, h2, h3, h4, h5, strong, .title, .entry-title").first();
      if (heading.length > 0 && heading.text().trim().length > 1) {
        cardTitle = heading.text().trim();
      }

      if (!cardTitle && img.length > 0 && img.attr("alt")) {
        cardTitle = img.attr("alt")!.trim();
      }""", "      cardTitle = UniversalScraper.extractCardTitle($(card), img);")

content = content.replace("""        const heading = $(card).find("h1, h2, h3, h4, h5, strong, .Title, .title").first();
        if (heading.length > 0 && heading.text().trim().length > 1) {
          cardTitle = heading.text().trim();
        }
        if (!cardTitle && img.length > 0 && img.attr("alt")) {
          cardTitle = img.attr("alt")!.trim();
        }""", "        cardTitle = UniversalScraper.extractCardTitle($(card), img);")

with open('server/universalScraper.ts', 'w') as f:
    f.write(content)

print("done")
