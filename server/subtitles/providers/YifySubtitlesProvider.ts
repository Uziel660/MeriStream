import * as cheerio from "cheerio";
import type { SubtitleCandidate, SubtitleProvider, SubtitleSearchRequest } from "../types";
import { normalizeSubtitleLanguage, subtitleLanguageLabel } from "../SubtitleNormalizer";

const DEFAULT_BASES = ["https://www.yifysubtitles.ch", "https://yts-subs.com"];

export class YifySubtitlesProvider implements SubtitleProvider {
  readonly id = "yify";
  readonly kinds = ["movie"] as const;
  private readonly bases: string[];

  constructor(
    bases = String(process.env.YIFY_SUBTITLES_BASE_URL || DEFAULT_BASES.join(","))
      .split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean),
    private readonly timeoutMs = Math.max(1_000, Number(process.env.YIFY_SUBTITLES_TIMEOUT_MS || 8_000)),
  ) {
    this.bases = bases;
  }

  async search(request: SubtitleSearchRequest): Promise<SubtitleCandidate[]> {
    if (!request.imdbId || request.season != null || request.episode != null) return [];
    for (const base of this.bases) {
      const html = await this.fetchText(`${base}/movie-imdb/${request.imdbId}`);
      if (!html) continue;
      const results = this.parseMovie(html, base, request.preferredLanguages);
      if (results.length > 0) return results;
    }
    return [];
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { headers: { Accept: "text/html", "User-Agent": "MeriStream/1.0" }, signal: controller.signal });
      return response.ok ? response.text() : "";
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  private parseMovie(html: string, base: string, preferredLanguages?: string[]): SubtitleCandidate[] {
    const $ = cheerio.load(html);
    const results: SubtitleCandidate[] = [];
    const preferred = new Set((preferredLanguages || ["es-419", "es", "en"]).map((value) => normalizeSubtitleLanguage(value)).filter((value): value is string => Boolean(value)));
    $("table.other-subs tbody tr, table tbody tr").each((index, row) => {
      const link = $(row).find('a[href*="/subtitles/"]').first().attr("href");
      if (!link) return;
      const slug = link.split("/subtitles/")[1]?.split(/[?#]/)[0];
      if (!slug) return;
      const rawLanguage = $(row).find(".sub-lang").text().trim();
      const language = normalizeSubtitleLanguage(rawLanguage);
      if (!language || !preferred.has(language)) return;
      const release = slug.replace(/-[^-]+-yify-\d+$/i, "").replace(/-/g, " ").trim();
      results.push({
        id: `yify:${slug}`,
        provider: this.id,
        language,
        label: `${subtitleLanguageLabel(language)}${release ? ` · ${release}` : ""}`,
        sourceUrl: `${base}/subtitle/${slug}.zip`,
        format: "srt",
        fileName: `${slug}.zip`,
        release,
        sourceHeaders: { Referer: `${base}/subtitles/${slug}` },
      });
      if (results.length >= 40) return false;
      return undefined;
    });
    return results;
  }
}
