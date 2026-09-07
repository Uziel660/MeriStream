// server/resolvers/megaplayResolver.ts
const MEGAPLAY_HOST = "megaplay.buzz";
const DEFAULT_TIMEOUT_MS = 8_000;
const MEGAPLAY_REFERER = "https://anipulse.to/";
const MEGAPLAY_FETCH_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.8",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
} as const;

export const MEGAPLAY_REQUIRED_HEADERS = {
  Referer: "https://megaplay.buzz/",
} as const;

export interface MegaplayResolution {
  url: string;
  subtitles: Array<{ src: string; lang?: string; label?: string; default?: boolean }>;
  requiredHeaders: Record<string, string>;
}

export function isMegaplayUrl(rawUrl: string): boolean {
  try {
    const lower = String(rawUrl || "").toLowerCase();
    return lower.includes("megaplay.buzz") || lower.includes("megaplay.top") || lower.includes("megaplay");
  } catch {
    return false;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseSubtitleLang(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes("spanish") || lower.includes("español") || lower.includes("esp")) return "es";
  if (lower.includes("english") || lower.includes("inglés") || lower.includes("eng")) return "en";
  if (lower.includes("french") || lower.includes("francés") || lower.includes("fre") || lower.includes("fra")) return "fr";
  if (lower.includes("german") || lower.includes("alemán") || lower.includes("ger") || lower.includes("deu")) return "de";
  if (lower.includes("italian") || lower.includes("italiano") || lower.includes("ita")) return "it";
  if (lower.includes("portuguese") || lower.includes("portugués") || lower.includes("por")) return "pt";
  if (lower.includes("arabic") || lower.includes("árabe") || lower.includes("ara")) return "ar";
  if (lower.includes("russian") || lower.includes("ruso") || lower.includes("rus")) return "ru";
  return "es";
}

export async function resolveMegaplay(
  embedUrl: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MegaplayResolution> {
  const fail = (): MegaplayResolution => ({
    url: "",
    subtitles: [],
    requiredHeaders: { ...MEGAPLAY_REQUIRED_HEADERS },
  });
  const cleanUrl = typeof embedUrl === "string" ? embedUrl.trim() : "";
  if (!cleanUrl || !isMegaplayUrl(cleanUrl)) return fail();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(cleanUrl, {
      signal: controller.signal,
      headers: {
        ...MEGAPLAY_FETCH_HEADERS,
        Referer: "https://anipulse.to/",
      },
    });
    if (!response.ok) return fail();
    const html = await response.text();

    const match = html.match(/id="megaplay-player"\s+data-id="(\d+)"/i) || html.match(/data-id="(\d+)"/i);
    const dataId = match ? match[1] : null;
    if (!dataId) return fail();

    const sourcesUrl = `https://megaplay.buzz/stream/getSources?id=${dataId}`;
    const sourcesRes = await fetch(sourcesUrl, {
      signal: controller.signal,
      headers: {
        ...MEGAPLAY_FETCH_HEADERS,
        "X-Requested-With": "XMLHttpRequest",
        Referer: cleanUrl,
      },
    });
    if (!sourcesRes.ok) return fail();
    const json = (await sourcesRes.json()) as Record<string, unknown>;

    const sourcesObj = json.sources;
    const file =
      asString(typeof sourcesObj === "object" && sourcesObj ? (sourcesObj as any).file : undefined) ||
      asString(Array.isArray(sourcesObj) ? (sourcesObj[0] as any)?.file : undefined);

    if (!file || !/^https?:\/\//i.test(file)) return fail();

    const rawTracks = Array.isArray(json.tracks) ? json.tracks : [];
    const subtitles = rawTracks.flatMap((entry: any) => {
      const src = asString(entry.file);
      if (!src || entry.kind !== "captions") return [];
      const label = asString(entry.label) || "Subtítulos";
      const lang = parseSubtitleLang(label);
      return [
        {
          src,
          lang,
          label,
          default: entry.default === true,
        },
      ];
    });

    return {
      url: file,
      subtitles,
      requiredHeaders: { ...MEGAPLAY_REQUIRED_HEADERS },
    };
  } catch {
    return fail();
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
