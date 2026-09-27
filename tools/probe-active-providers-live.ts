import fs from "node:fs/promises";
import { ScraperManager } from "../server/scrapers/ScraperManager";
import { EmbedResolvers } from "../server/resolvers";
import { probeMedia } from "./providerMediaProbe";

type ProbeCase = { provider: string; adapter: string; title: string; url: string };

const CASES: ProbeCase[] = [
  { provider: "doramasflix", adapter: "doramasflix", title: "Mousetrap 1x1", url: "https://doramasflix.io/capitulos/mousetrap-1x1" },
  { provider: "doramasflix", adapter: "doramasflix", title: "Penthouse 1x1", url: "https://doramasflix.io/capitulos/penthouse-1x1" },
  { provider: "archive-org", adapter: "archive_org", title: "Big Buck Bunny", url: "https://archive.org/details/BigBuckBunny_328" },
  { provider: "archive-org", adapter: "archive_org", title: "His Girl Friday", url: "https://archive.org/details/his_girl_friday" },
  { provider: "tioanime", adapter: "tioanime", title: "Kaijuu 8-gou: Narumi no Heijitsu", url: "https://tioanime.com/ver/kaijuu-8gou-narumi-no-heijitsu-1" },
  { provider: "tioanime", adapter: "tioanime", title: "The Ribbon Hero", url: "https://tioanime.com/ver/the-ribbon-hero-1" },
];

function hostOf(value: string | null | undefined): string | null {
  try { return value ? new URL(value).hostname : null; } catch { return null; }
}

async function resolveCandidate(candidate: string) {
  if (EmbedResolvers.isDirectMediaUrl(candidate)) {
    return { url: candidate, requiredHeaders: {} as Record<string, string>, direct: true };
  }
  try {
    const meta: any = await EmbedResolvers.resolveWithMeta(candidate);
    const resolved = String(meta?.url || "");
    return {
      url: resolved,
      requiredHeaders: (meta?.requiredHeaders || {}) as Record<string, string>,
      direct: Boolean(resolved && EmbedResolvers.isDirectMediaUrl(resolved)),
    };
  } catch (error) {
    return { url: "", requiredHeaders: {} as Record<string, string>, direct: false, error: String((error as Error)?.message || error) };
  }
}

const manager = ScraperManager.getInstance();
const results = [];

for (const item of CASES) {
  const started = Date.now();
  try {
    const extraction = await manager.extractStream(item.url, item.adapter);
    const candidates = Array.from(new Set([
      extraction.stream_url,
      ...(extraction.all_available_streams || []),
    ].filter(Boolean))).slice(0, 5);

    const attempts = [];
    let passed = false;
    for (const candidate of candidates) {
      const resolved = await resolveCandidate(candidate);
      const media = resolved.direct && resolved.url
        ? await probeMedia(resolved.url, resolved.requiredHeaders)
        : { host: hostOf(resolved.url || candidate), error: resolved.error || "not_direct" };
      const ok = Boolean(
        resolved.direct
        && !media.error
        && (
          media.requiresBackendProxy === true
          || (
            (media.status === 200 || media.status === 206)
            && (media.segmentStatus === undefined || media.segmentStatus === 200 || media.segmentStatus === 206)
            && (media.bytesRead || 0) > 0
          )
        )
      );
      attempts.push({
        candidateHost: hostOf(candidate),
        resolvedHost: hostOf(resolved.url),
        direct: resolved.direct,
        media,
        ok,
      });
      if (ok) {
        passed = true;
        break;
      }
    }

    results.push({
      provider: item.provider,
      title: item.title,
      locatorHost: hostOf(item.url),
      candidates: candidates.length,
      passed,
      latencyMs: Date.now() - started,
      attempts,
    });
  } catch (error) {
    results.push({
      provider: item.provider,
      title: item.title,
      locatorHost: hostOf(item.url),
      candidates: 0,
      passed: false,
      latencyMs: Date.now() - started,
      error: String((error as Error)?.message || error),
      attempts: [],
    });
  }
}

const output = { generatedAt: new Date().toISOString(), results };
await fs.mkdir("provider-live-results", { recursive: true });
await fs.writeFile("provider-live-results/extra-active-providers.json", JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify(output, null, 2));
