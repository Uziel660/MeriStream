import * as cheerio from "cheerio";
import type { DirectStreamProvider, PlayableSource, ProviderRequest } from "./types";
import { playableUrl } from "./types";

const DEFAULT_DOMAINS = [
  "https://vidsrc.ir",
  "https://vidsrc2.ru",
  "https://vidsrcme.ru",
  "https://vidsrcme.su",
  "https://vidsrc-me.ru",
  "https://vidsrc-me.su",
  "https://vidsrc-embed.ru",
  "https://vidsrc-embed.su",
  "https://vsrc.su",
];

const DEFAULT_TIMEOUT_MS = 6500;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type FetchLike = typeof fetch;

export type VidSrcResolutionStatus =
  | "direct"
  | "embed_only"
  | "unavailable"
  | "blocked"
  | "error";

export interface VidSrcProbeResult {
  status: VidSrcResolutionStatus;
  embedUrl: string;
  playerOrigin?: string;
  hlsUrl?: string;
  requiredHeaders?: Record<string, string>;
  reason?: string;
}

function normalizeOrigins(raw: string | undefined): string[] {
  const configured = String(raw || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter((value) => /^https?:\/\//i.test(value));
  return configured.length > 0 ? configured : DEFAULT_DOMAINS;
}

function buildEmbedUrl(origin: string, req: ProviderRequest): string {
  if (req.kind === "movie") return `${origin}/embed/movie/${req.tmdbId}`;
  return `${origin}/embed/tv/${req.tmdbId}/${req.season || 1}/${req.episode || 1}`;
}

function toAbsolute(value: string, base: string): string | null {
  const cleaned = String(value || "").trim().replace(/&amp;/g, "&");
  if (!cleaned) return null;
  try {
    if (cleaned.startsWith("//")) return `https:${cleaned}`;
    return new URL(cleaned, base).toString();
  } catch {
    return null;
  }
}

function extractQuotedPath(html: string, key: "src" | "file"): string | null {
  const patterns = [
    new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`, "i"),
    new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern)?.[1];
    if (match) return match.replace(/\\\//g, "/");
  }
  return null;
}

async function fetchText(
  fetcher: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; text: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
      finalUrl: response.url || url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves the public VidSrc embed chain only. It never returns an iframe as
 * playable media: the successful terminal state must be a native HLS URL.
 */
export async function resolveVidSrcEmbed(
  embedUrl: string,
  fetcher: FetchLike = fetch,
): Promise<VidSrcProbeResult> {
  const baseHeaders: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "User-Agent": DEFAULT_UA,
  };

  try {
    const landing = await fetchText(fetcher, embedUrl, baseHeaders);
    if (landing.status === 401 || landing.status === 403 || landing.status === 429) {
      return { status: "blocked", embedUrl, reason: `embed_http_${landing.status}` };
    }
    if (!landing.ok) {
      return { status: landing.status === 404 ? "unavailable" : "error", embedUrl, reason: `embed_http_${landing.status}` };
    }

    const $ = cheerio.load(landing.text);
    const iframeSrc = $("iframe[src]").first().attr("src") || "";
    const playerUrl = toAbsolute(iframeSrc, landing.finalUrl);
    if (!playerUrl) {
      return { status: "embed_only", embedUrl, reason: "player_iframe_not_found" };
    }

    const playerOrigin = new URL(playerUrl).origin;
    const playerHeaders: Record<string, string> = {
      ...baseHeaders,
      Referer: `${playerOrigin}/`,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "iframe",
    };
    const player = await fetchText(fetcher, playerUrl, playerHeaders);
    if (!player.ok) {
      return {
        status: player.status === 401 || player.status === 403 || player.status === 429 ? "blocked" : "embed_only",
        embedUrl,
        playerOrigin,
        reason: `player_http_${player.status}`,
      };
    }

    const player$ = cheerio.load(player.text);
    const serverHashes = player$(".serversList .server[data-hash], .server[data-hash]")
      .map((_, element) => player$(element).attr("data-hash") || "")
      .get()
      .map((value) => value.trim())
      .filter(Boolean);

    // Some layouts expose a terminal source directly in the player HTML.
    const immediate = extractQuotedPath(player.text, "file");
    const immediateUrl = immediate ? toAbsolute(immediate, player.finalUrl) : null;
    const immediatePlayable = immediateUrl ? playableUrl(immediateUrl, "hls") : null;
    if (immediatePlayable) {
      return {
        status: "direct",
        embedUrl,
        playerOrigin,
        hlsUrl: immediatePlayable.url,
        requiredHeaders: {
          Referer: `${playerOrigin}/`,
          "User-Agent": DEFAULT_UA,
          "Sec-Fetch-Dest": "iframe",
        },
      };
    }

    if (serverHashes.length === 0) {
      return { status: "embed_only", embedUrl, playerOrigin, reason: "server_hashes_not_found" };
    }

    const serverResults = await Promise.allSettled(serverHashes.map(async (hash) => {
      const rcpUrl = new URL(`/rcp/${encodeURIComponent(hash)}`, playerOrigin).toString();
      const rcp = await fetchText(fetcher, rcpUrl, {
        ...playerHeaders,
        "Sec-Fetch-Dest": "empty",
      });
      if (!rcp.ok) return null;

      const sourcePath = extractQuotedPath(rcp.text, "src");
      if (!sourcePath) return null;
      const sourceUrl = toAbsolute(sourcePath, playerOrigin);
      if (!sourceUrl) return null;

      let terminalUrl = sourceUrl;
      if (new URL(sourceUrl).pathname.startsWith("/prorcp/")) {
        const terminal = await fetchText(fetcher, sourceUrl, {
          ...playerHeaders,
          "Sec-Fetch-Dest": "empty",
        });
        if (!terminal.ok) return null;
        const file = extractQuotedPath(terminal.text, "file");
        const absoluteFile = file ? toAbsolute(file, terminal.finalUrl) : null;
        if (!absoluteFile) return null;
        terminalUrl = absoluteFile;
      }

      const playable = playableUrl(terminalUrl, "hls");
      return playable?.streamType === "hls" ? playable.url : null;
    }));

    const hlsUrl = serverResults.find(
      (result): result is PromiseFulfilledResult<string | null> => result.status === "fulfilled" && Boolean(result.value),
    );
    if (!hlsUrl?.value) {
      return { status: "embed_only", embedUrl, playerOrigin, reason: "no_native_hls_from_servers" };
    }

    return {
      status: "direct",
      embedUrl,
      playerOrigin,
      hlsUrl: hlsUrl.value,
      requiredHeaders: {
        Referer: `${playerOrigin}/`,
        "User-Agent": DEFAULT_UA,
        "Sec-Fetch-Dest": "iframe",
      },
    };
  } catch (error) {
    return {
      status: "error",
      embedUrl,
      reason: error instanceof Error ? error.message : "unknown_error",
    };
  }
}

export class VidSrcClient implements DirectStreamProvider {
  readonly id = "vidsrc";
  readonly kinds = ["movie", "series"] as const;

  private readonly origins: string[];
  private readonly fetcher: FetchLike;

  constructor(
    origins = normalizeOrigins(process.env.VIDSRC_ORIGINS),
    fetcher: FetchLike = fetch,
  ) {
    this.origins = origins;
    this.fetcher = fetcher;
  }

  async resolve(req: ProviderRequest): Promise<PlayableSource[]> {
    if (!this.kinds.includes(req.kind as any)) return [];

    const attempts = await Promise.allSettled(
      this.origins.map((origin) => resolveVidSrcEmbed(buildEmbedUrl(origin, req), this.fetcher)),
    );

    const sources: PlayableSource[] = [];
    for (const attempt of attempts) {
      if (attempt.status !== "fulfilled") continue;
      const result = attempt.value;
      if (result.status !== "direct" || !result.hlsUrl) continue;
      const playable = playableUrl(result.hlsUrl, "hls");
      if (!playable) continue;
      sources.push({
        provider: this.id,
        providerGroup: "api",
        url: playable.url,
        streamType: playable.streamType,
        audioLanguage: "en",
        subtitleLanguage: null,
        subtitles: [],
        requiredHeaders: result.requiredHeaders,
        canonicalLocator: result.embedUrl,
        sourceStatus: "resolved",
        score: 85,
      });
    }

    const deduped = new Map<string, PlayableSource>();
    for (const source of sources) {
      if (!deduped.has(source.url)) deduped.set(source.url, source);
    }
    return [...deduped.values()];
  }
}
