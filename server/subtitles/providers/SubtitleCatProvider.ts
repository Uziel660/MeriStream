import * as cheerio from "cheerio";
import type { SubtitleCandidate, SubtitleProvider, SubtitleSearchRequest } from "../types";
import { normalizeSubtitleLanguage, subtitleLanguageLabel } from "../SubtitleNormalizer";
import { parseCandidateSeasonEpisode } from "../SubtitleGateway";

const BASE_URL = "https://subtitlecat.com";

function clean(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleMatches(query: string, value: string): boolean {
  const left = clean(query);
  const right = clean(value.replace(/^\s*(?:\[[^\]]*\]\s*)+/, ""));
  if (!left || !right) return false;
  // A one-word search is especially prone to synopsis matches (for example
  // "Overflow" appearing at the end of an unrelated movie title). Accept it
  // only when it starts the indexed title after optional release-group tags.
  if (left.split(" ").length === 1) return right === left || right.startsWith(`${left} `);
  if (right.includes(left) || left.includes(right)) return true;
  const leftTokens = new Set(left.split(" ").filter((token) => token.length > 2));
  const rightTokens = new Set(right.split(" ").filter((token) => token.length > 2));
  const common = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return common >= Math.max(1, Math.ceil(Math.min(leftTokens.size, rightTokens.size) * 0.6));
}

/**
 * SubtitleCat's search page mixes films, episodes and release groups. When a
 * requested year is known, a visible conflicting year is stronger evidence
 * than the loose token match above and must reject the result. Pages without
 * a year stay eligible because the provider often omits it from the label.
 */
function compatibleYear(value: string, requestedYear?: number | null): boolean {
  const year = Number(requestedYear || 0);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return true;
  const found = [...String(value || "").matchAll(/\b(?:19|20)\d{2}\b/g)]
    .map((match) => Number(match[0]))
    .filter((candidate) => candidate >= 1900 && candidate <= 2100);
  return found.length === 0 || found.includes(year);
}

function wantedLanguages(values?: string[]): Set<string> {
  return new Set((values || ["es-419", "es", "en"])
    .map((value) => normalizeSubtitleLanguage(value))
    .filter((value): value is string => Boolean(value)));
}

export class SubtitleCatProvider implements SubtitleProvider {
  readonly id = "subtitlecat";
  readonly kinds = ["movie", "series", "anime"] as const;

  constructor(private readonly timeoutMs = Math.max(1_000, Number(process.env.SUBTITLECAT_TIMEOUT_MS || 8_000))) {}

  async search(request: SubtitleSearchRequest): Promise<SubtitleCandidate[]> {
    const aliases = [...new Set([request.title, ...(request.titleAliases || [])]
      .map((value) => String(value || "").trim()).filter(Boolean))];
    if (!aliases.length) return [];
    const preferred = wantedLanguages(request.preferredLanguages);
    for (const alias of aliases) {
      const query = request.year ? `${alias} ${request.year}` : alias;
      const searchHtml = await this.fetchText(`${BASE_URL}/index.php?search=${encodeURIComponent(query)}`);
      if (!searchHtml) continue;
      const $ = cheerio.load(searchHtml);
      const pages: string[] = [];
      $("a[href^='subs/']").each((_index, element) => {
        const href = $(element).attr("href") || "";
        const label = $(element).text().trim();
        if (!href || !titleMatches(alias, label)) return;
        if (!compatibleYear(`${label} ${href}`, request.year)) return;
        if (request.season != null && request.episode != null) {
          const parsed = parseCandidateSeasonEpisode(`${label} ${href}`);
          if (parsed) {
            if (parsed.season !== undefined && parsed.season !== request.season) return;
            if (parsed.episode !== undefined && parsed.episode !== request.episode) return;
          }
        }
        const pageUrl = new URL(href, BASE_URL).toString();
        if (!pages.includes(pageUrl)) pages.push(pageUrl);
      });
      const pageResults = await Promise.all(pages.slice(0, 8).map(async (pageUrl) => ({ pageUrl, pageHtml: await this.fetchText(pageUrl) })));
      for (const { pageUrl, pageHtml } of pageResults) {
        if (!pageHtml) continue;
        if (!compatibleYear(pageUrl, request.year)) continue;
        const pageDom = cheerio.load(pageHtml);
        const candidates: SubtitleCandidate[] = [];
        pageDom("a[href]").each((_index, element) => {
          const href = pageDom(element).attr("href") || "";
          const match = href.match(/(?:^|\/)([^/]+)-([a-z]{2}(?:-[A-Z]{2}|-\d{3})?)\.(srt|vtt|ass|ssa)$/i);
          if (!match) return;
          const language = normalizeSubtitleLanguage(match[2]);
          if (!language || !preferred.has(language)) return;
          const sourceUrl = new URL(href, BASE_URL).toString();
          if (!compatibleYear(`${sourceUrl} ${match[1]}`, request.year)) return;
          if (request.season != null && request.episode != null) {
            const parsed = parseCandidateSeasonEpisode(`${sourceUrl} ${match[1]}`);
            if (parsed) {
              if (parsed.season !== undefined && parsed.season !== request.season) return;
              if (parsed.episode !== undefined && parsed.episode !== request.episode) return;
            }
          }
          candidates.push({
            id: `subtitlecat:${sourceUrl}`,
            provider: this.id,
            language,
            label: `${subtitleLanguageLabel(language)} · ${decodeURIComponent(match[1]).replace(/\+/g, " ")}`,
            sourceUrl,
            format: match[3].toLowerCase() as SubtitleCandidate["format"],
            fileName: decodeURIComponent(match[1]),
            release: decodeURIComponent(match[1]),
            sourceHeaders: { Referer: pageUrl },
          });
        });
        if (candidates.length) return candidates.slice(0, 20);
      }
    }
    return [];
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "User-Agent": "MeriStream/1.0" },
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
