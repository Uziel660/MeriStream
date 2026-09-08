import * as cheerio from "cheerio";
import type { SubtitleCandidate, SubtitleProvider, SubtitleSearchRequest } from "../types";
import { normalizeSubtitleLanguage, subtitleLanguageLabel } from "../SubtitleNormalizer";

const BASE_URL = "https://www.tvsubtitles.net";
const CINEMETA_URL = "https://v3-cinemeta.strem.io/meta";

function uniqueTitles(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const title = String(value || "").replace(/\s+/g, " ").trim();
    const key = title.toLowerCase();
    if (!title || key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    result.push(title);
  }
  return result;
}

export class TvSubtitlesProvider implements SubtitleProvider {
  readonly id = "tvsubtitles";
  readonly kinds = ["series"] as const;

  constructor(private readonly timeoutMs = Math.max(1_000, Number(process.env.TVSUBTITLES_TIMEOUT_MS || 10_000))) {}

  async search(request: SubtitleSearchRequest): Promise<SubtitleCandidate[]> {
    if (!request.imdbId || request.season == null || request.episode == null) return [];

    // TVSubtitles indexa muchas series únicamente por su título inglés/original.
    // Probar el título visible, aliases canónicos y Cinemeta evita perder una
    // serie solo porque MeriStream la muestra localizada. La búsqueda sigue
    // validando similitud antes de aceptar un showId, por lo que un alias no
    // puede fabricar una identidad distinta por sí solo.
    const cinemetaTitle = await this.seriesTitle(request.imdbId);
    const titles = uniqueTitles([
      request.title,
      ...(request.titleAliases || []),
      cinemetaTitle,
    ]).slice(0, 6);

    for (const title of titles) {
      const showId = await this.findShowId(title);
      if (!showId) continue;
      const html = await this.fetchText(`${BASE_URL}/tvshow-${showId}-${request.season}.html`);
      if (!html) continue;
      const candidates = await this.parseEpisode(html, showId, request.season, request.episode, request.preferredLanguages);
      if (candidates.length > 0) return candidates.slice(0, 20);
    }
    return [];
  }

  private async seriesTitle(imdbId: string): Promise<string> {
    const body = await this.fetchJson(`${CINEMETA_URL}/series/${imdbId}.json`) as { meta?: { name?: string } } | null;
    return String(body?.meta?.name || "").trim();
  }

  private async findShowId(title: string): Promise<string | null> {
    const body = await this.fetchText(`${BASE_URL}/search1.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `qs=${encodeURIComponent(title)}`,
    });
    if (!body) return null;
    const $ = cheerio.load(body);
    let best: { id: string; score: number } | null = null;
    $("a[href^='/tvshow-']").each((_index, element) => {
      const href = $(element).attr("href") || "";
      const id = href.match(/tvshow-(\d+)/)?.[1];
      if (!id) return;
      const name = $(element).text().replace(/\s*\(\d{4}-\d{4}\)\s*$/, "").trim();
      const score = similarity(title, name);
      if (!best || score > best.score) best = { id, score };
    });
    return best && best.score >= 0.5 ? best.id : null;
  }

  private async parseEpisode(
    html: string,
    showId: string,
    season: number,
    episode: number,
    preferredLanguages?: string[],
  ): Promise<SubtitleCandidate[]> {
    const $ = cheerio.load(html);
    const episodePattern = `${season}x${String(episode).padStart(2, "0")}`;
    const jobs: Promise<SubtitleCandidate | null>[] = [];
    $("tr").each((_index, row) => {
      const rowElement = $(row);
      if (rowElement.find("td").first().text().trim() !== episodePattern) return;
      rowElement.find("img[src*='flags/']").each((_imgIndex, image) => {
        const flag = $(image).attr("src") || "";
        const rawLanguage = flag.match(/flags\/([a-z]+)\.gif/i)?.[1] || "";
        const language = normalizeSubtitleLanguage(rawLanguage);
        if (!language || (preferredLanguages?.length && !preferredLanguages.some((value) => normalizeSubtitleLanguage(value) === language))) return;
        const href = $(image).parent("a").attr("href") || "";
        const subtitleId = href.match(/subtitle-(\d+)/)?.[1];
        const episodeId = href.match(/episode-(\d+)-/)?.[1];
        if (!subtitleId && !episodeId) return;
        jobs.push(this.resolveCandidate(language, subtitleId || episodeId || "", Boolean(episodeId), showId, season, episode));
      });
    });
    const results = await Promise.all(jobs);
    return results.filter((value): value is SubtitleCandidate => Boolean(value));
  }

  private async resolveCandidate(language: string, id: string, episodePage: boolean, showId: string, season: number, episode: number): Promise<SubtitleCandidate | null> {
    try {
      let subtitleId = id;
      if (episodePage) {
        const episodeHtml = await this.fetchText(`${BASE_URL}/episode-${id}-${language}.html`);
        subtitleId = cheerio.load(episodeHtml)("a[href*='/subtitle-']").first().attr("href")?.match(/subtitle-(\d+)/)?.[1] || "";
      }
      if (!subtitleId) return null;
      const downloadHtml = await this.fetchText(`${BASE_URL}/download-${subtitleId}.html`);
      const match = downloadHtml.match(/var\s+s1\s*=\s*['"]([^'"]+)['"][\s\S]*?var\s+s2\s*=\s*['"]([^'"]+)['"][\s\S]*?var\s+s3\s*=\s*['"]([^'"]+)['"][\s\S]*?var\s+s4\s*=\s*['"]([^'"]+)['"]/i);
      if (!match) return null;
      const fileName = `${match[1]}${match[2]}${match[3]}${match[4]}`;
      return {
        id: `tvsubtitles:${subtitleId}:${language}`,
        provider: this.id,
        language,
        label: `${subtitleLanguageLabel(language)} · S${season}E${String(episode).padStart(2, "0")}`,
        sourceUrl: `${BASE_URL}/${fileName}`,
        format: "srt",
        fileName,
        release: `S${season}E${String(episode).padStart(2, "0")}`,
      };
    } catch {
      return null;
    }
  }

  private async fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const text = await this.fetchText(url, init);
    return text ? JSON.parse(text) : null;
  }

  private async fetchText(url: string, init: RequestInit = {}): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "User-Agent": "MeriStream/1.0", Accept: "text/html,application/json", ...(init.headers || {}) },
        signal: controller.signal,
      });
      return response.ok ? response.text() : "";
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }
}

function similarity(a: string, b: string): number {
  const left = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const right = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}
