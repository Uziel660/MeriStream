/**
 * Matriz de humo de reproducción/multiplexado sobre episodios ya almacenados.
 *
 * Es una prueba de solo lectura: no crea jobs ni actualiza SourceLink. Para
 * mantener baja la carga durante la verificación global usa como máximo dos
 * peticiones simultáneas al endpoint DB-only /api/v1/play/:episode_id.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../server/db";

const BASE_URL = process.env.MERISTREAM_BASE_URL?.trim() || "http://127.0.0.1:3010";
const REQUEST_CONCURRENCY = 2;
const MULTIPLEX_SAMPLE_LIMIT = 6;
const REQUEST_TIMEOUT_MS = 20_000;

const PLATFORMS: Array<{ id: string; pattern: string }> = [
  { id: "animeflv", pattern: "%animeflv%" },
  { id: "cinecalidad", pattern: "%cinecalidad%" },
  { id: "doramasflix", pattern: "%doramasflix%" },
  { id: "gnula", pattern: "%gnula%" },
  { id: "hianimes", pattern: "%hianimes%" },
  { id: "jkanime", pattern: "%jkanime%" },
  { id: "lamovie", pattern: "%lamovie%" },
  { id: "latanime", pattern: "%latanime%" },
  { id: "tioanime", pattern: "%tioanime%" },
  { id: "tioplus", pattern: "%tioplus%" },
  { id: "tubepelis", pattern: "%tubepelis%" },
  { id: "veranimes", pattern: "%veranimes%" },
];

type EpisodeSample = {
  episode_id: string;
  media_item_id: string;
  title: string;
  episode_number: number;
  season_number: number;
  source_site: string;
  stored_sites: number;
  stored_links: number;
};

type MatrixResult = {
  test: "platform" | "multiplex";
  platform?: string;
  episode_id: string;
  media_item_id: string;
  title: string;
  episode_number: number;
  season_number: number;
  source_site?: string;
  stored_sites: number;
  stored_links: number;
  http_status: number;
  latency_ms: number;
  ranked_streams: number;
  returned_sites: string[];
  direct_streams: number;
  embed_streams: number;
  error?: string;
};

async function queryPlatformSample(platform: { id: string; pattern: string }): Promise<EpisodeSample | null> {
  // Mantener la consulta index-friendly: no agregamos el millón de enlaces
  // mientras el crawler puede estar escribiendo. Primero tomamos un episodio
  // y después contamos únicamente sus enlaces.
  const links = await prisma.$queryRawUnsafe<Array<{ media_episode_id: string; source_site: string }>>(
    `SELECT sl.media_episode_id, sl.source_site
       FROM "SourceLink" sl
      WHERE sl.source_site ILIKE $1
        AND sl.url IS NOT NULL AND sl.url <> ''
        AND sl.url NOT ILIKE '%/page/%'
      ORDER BY CASE sl.link_type WHEN 'embed' THEN 0 WHEN 'direct' THEN 1 ELSE 2 END, sl.id
      LIMIT 1`,
    platform.pattern,
  );
  const link = links[0];
  if (!link) {
    // TubePelis tiene seis episodios históricos en el esquema legacy. Aunque
    // aún no estén puenteados a MediaEpisode/SourceLink, /play debe seguir
    // resolviéndolos JIT; incluir uno aquí evita confundir “sin persistencia”
    // con “proveedor caído”.
    const legacy = await prisma.episode.findFirst({
      where: { source_url: { contains: "tubepelis", mode: "insensitive" } },
      orderBy: { id: "asc" },
      select: { id: true, title: true, episode_number: true, source_url: true, show: { select: { id: true, title: true } } },
    });
    if (!legacy) return null;
    return {
      episode_id: legacy.id,
      media_item_id: legacy.show.id,
      title: legacy.show.title || legacy.title,
      episode_number: Number(legacy.episode_number),
      season_number: 1,
      source_site: "tubepelis.com",
      stored_sites: 1,
      stored_links: 1,
    };
  }
  const episode = await prisma.mediaEpisode.findUnique({
    where: { id: link.media_episode_id },
    select: { id: true, media_item_id: true, episode_number: true, season_number: true, media_item: { select: { title: true } } },
  });
  if (!episode) return null;
  const episodeLinks = await prisma.sourceLink.findMany({
    where: { media_episode_id: episode.id, url: { not: "" } },
    select: { source_site: true },
  });
  return {
    episode_id: episode.id,
    media_item_id: episode.media_item_id,
    title: episode.media_item.title,
    episode_number: Number(episode.episode_number),
    season_number: Number(episode.season_number),
    source_site: link.source_site,
    stored_sites: new Set(episodeLinks.map((row) => row.source_site)).size,
    stored_links: episodeLinks.length,
  };
}

async function queryMultiplexSamples(): Promise<EpisodeSample[]> {
  // Formamos un conjunto pequeño de candidatos desde cada plataforma. Así no
  // hacemos un GROUP BY global sobre SourceLink (el volumen supera el millón
  // de filas y el contenedor de PostgreSQL usa un /dev/shm deliberadamente
  // pequeño). Luego la diversidad se calcula sólo para esos candidatos.
  const candidateIds = new Set<string>();
  for (const platform of PLATFORMS) {
      const rows = await prisma.$queryRawUnsafe<Array<{ media_episode_id: string }>>(
      `SELECT DISTINCT sl.media_episode_id
         FROM "SourceLink" sl
        WHERE sl.source_site ILIKE $1
          AND sl.source_site NOT ILIKE 'test-index.local'
          AND sl.url IS NOT NULL AND sl.url <> ''
        LIMIT 16`,
      platform.pattern,
    );
    rows.forEach((row) => candidateIds.add(row.media_episode_id));
  }
  if (candidateIds.size === 0) return [];
  const links = await prisma.sourceLink.findMany({
    where: {
      media_episode_id: { in: Array.from(candidateIds) },
      url: { not: "" },
      NOT: { source_site: { contains: "test-index.local", mode: "insensitive" } },
    },
    select: { media_episode_id: true, source_site: true },
  });
  const byEpisode = new Map<string, string[]>();
  for (const link of links) byEpisode.set(link.media_episode_id, [...(byEpisode.get(link.media_episode_id) || []), link.source_site]);
  const chosen = Array.from(byEpisode.entries())
    .map(([episodeId, sites]) => ({ episodeId, sites: Array.from(new Set(sites)), links: sites.length }))
    .filter((entry) => entry.sites.length >= 3)
    .sort((a, b) => b.sites.length - a.sites.length || b.links - a.links)
    .slice(0, MULTIPLEX_SAMPLE_LIMIT);
  const episodes = await prisma.mediaEpisode.findMany({
    where: { id: { in: chosen.map((entry) => entry.episodeId) } },
    select: { id: true, media_item_id: true, episode_number: true, season_number: true, media_item: { select: { title: true } } },
  });
  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
  return chosen.flatMap((entry) => {
    const episode = episodeById.get(entry.episodeId);
    if (!episode) return [];
    return [{
      episode_id: episode.id,
      media_item_id: episode.media_item_id,
      title: episode.media_item.title,
      episode_number: Number(episode.episode_number),
      season_number: Number(episode.season_number),
      source_site: entry.sites[0],
      stored_sites: entry.sites.length,
      stored_links: entry.links,
    }];
  });
}

async function testEpisode(
  sample: EpisodeSample,
  test: "platform" | "multiplex",
  platform?: string,
): Promise<MatrixResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/api/v1/play/${encodeURIComponent(sample.episode_id)}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({})) as {
      ranked_streams?: Array<{ url?: string; type?: string; source_site?: string }>;
    };
    const streams = Array.isArray(payload.ranked_streams)
      ? payload.ranked_streams.filter((stream) => typeof stream?.url === "string")
      : [];
    const returnedSites = Array.from(new Set(
      streams.map((stream) => String(stream.source_site || "").trim()).filter(Boolean),
    ));
    const directStreams = streams.filter((stream) => /\.(?:m3u8|mp4|webm|mkv)(?:[?#]|$)/i.test(stream.url || ""));
    return {
      test,
      ...(platform ? { platform } : {}),
      episode_id: sample.episode_id,
      media_item_id: sample.media_item_id,
      title: sample.title,
      episode_number: Number(sample.episode_number),
      season_number: Number(sample.season_number),
      ...(sample.source_site ? { source_site: sample.source_site } : {}),
      stored_sites: Number(sample.stored_sites),
      stored_links: Number(sample.stored_links),
      http_status: response.status,
      latency_ms: Date.now() - started,
      ranked_streams: streams.length,
      returned_sites: returnedSites,
      direct_streams: directStreams.length,
      embed_streams: streams.length - directStreams.length,
    };
  } catch (error) {
    return {
      test,
      ...(platform ? { platform } : {}),
      episode_id: sample.episode_id,
      media_item_id: sample.media_item_id,
      title: sample.title,
      episode_number: Number(sample.episode_number),
      season_number: Number(sample.season_number),
      ...(sample.source_site ? { source_site: sample.source_site } : {}),
      stored_sites: Number(sample.stored_sites),
      stored_links: Number(sample.stored_links),
      http_status: 0,
      latency_ms: Date.now() - started,
      ranked_streams: 0,
      returned_sites: [],
      direct_streams: 0,
      embed_streams: 0,
      error: String(error).slice(0, 180),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runBatched<T>(items: T[], worker: (item: T) => Promise<MatrixResult>): Promise<MatrixResult[]> {
  const output: MatrixResult[] = [];
  for (let index = 0; index < items.length; index += REQUEST_CONCURRENCY) {
    const batch = items.slice(index, index + REQUEST_CONCURRENCY);
    output.push(...await Promise.all(batch.map(worker)));
  }
  return output;
}

function markdown(results: MatrixResult[], missingPlatforms: string[]): string {
  const platformRows = results.filter((row) => row.test === "platform").map((row) =>
    `| ${row.platform || "-"} | ${row.title} · E${row.episode_number} | ${row.source_site || "-"} | ${row.stored_sites} | ${row.http_status || "-"} | ${row.latency_ms} | ${row.ranked_streams} | ${row.returned_sites.join(", ") || "-"} |`,
  );
  const multiplexRows = results.filter((row) => row.test === "multiplex").map((row) =>
    `| ${row.title} · T${row.season_number}E${row.episode_number} | ${row.stored_sites} | ${row.stored_links} | ${row.http_status || "-"} | ${row.latency_ms} | ${row.ranked_streams} | ${row.returned_sites.join(", ") || "-"} |`,
  );
  return [
    `# Matriz de reproducción y multiplexado — ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Prueba DB-only contra \`${BASE_URL}\`; solo lectura, concurrencia máxima ${REQUEST_CONCURRENCY}. No se alteraron catálogos ni SourceLink.`,
    "",
    "## Una obra por plataforma",
    "",
    "| Plataforma | Obra/episodio | Fuente almacenada | Sitios guardados | HTTP | Latencia ms | Candidatos | Sitios devueltos |",
    "|---|---|---|---:|---:|---:|---:|---|",
    ...platformRows,
    ...(missingPlatforms.length ? ["", `Plataformas sin episodio almacenado con ese alias: ${missingPlatforms.join(", ")}.`] : []),
    "",
    "## Obras multiplexadas",
    "",
    "| Obra/episodio | Sitios guardados | Enlaces guardados | HTTP | Latencia ms | Candidatos | Sitios devueltos |",
    "|---|---:|---:|---:|---:|---:|---|",
    ...multiplexRows,
    "",
    "Los candidatos son enlaces canónicos ya almacenados. HTTP 200 y candidatos >0 prueban la cascada/ranking; no sustituyen una reproducción visual de cada embed ni una sonda de bytes.",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const platformSamples = await Promise.all(PLATFORMS.map(async (platform) => ({
    platform,
    sample: await queryPlatformSample(platform),
  })));
  const missingPlatforms = platformSamples.filter((entry) => !entry.sample).map((entry) => entry.platform.id);
  const platformItems = platformSamples.filter((entry): entry is { platform: { id: string; pattern: string }; sample: EpisodeSample } => Boolean(entry.sample));
  const multiplexSamples = await queryMultiplexSamples();
  const results = [
    ...await runBatched(platformItems, (entry) => testEpisode(entry.sample, "platform", entry.platform.id)),
    ...await runBatched(multiplexSamples, (sample) => testEpisode(sample, "multiplex")),
  ];
  const report = {
    generated_at: new Date().toISOString(),
    base_url: BASE_URL,
    request_concurrency: REQUEST_CONCURRENCY,
    platform_samples: platformItems.length,
    multiplex_samples: multiplexSamples.length,
    missing_platforms: missingPlatforms,
    results,
  };
  const date = new Date().toISOString().slice(0, 10);
  const jsonPath = path.resolve(`docs/workstreams/playback-platform-matrix-${date}.json`);
  const markdownPath = path.resolve(`docs/workstreams/playback-platform-matrix-${date}.md`);
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, markdown(results, missingPlatforms), "utf8");
  const ok = results.filter((row) => row.http_status === 200 && row.ranked_streams > 0).length;
  console.log(JSON.stringify({ jsonPath, markdownPath, platform_samples: platformItems.length, multiplex_samples: multiplexSamples.length, ok, total: results.length, missing_platforms: missingPlatforms }, null, 2));
}

main().catch((error) => {
  console.error(`[playback-platform-matrix] ${String(error)}`);
  process.exitCode = 2;
}).finally(async () => {
  await prisma.$disconnect();
});
