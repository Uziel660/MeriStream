/**
 * Auditoría ligera, de solo lectura, de resolución de fuentes canónicas.
 *
 * No cambia SourceLink ni crea jobs. Selecciona hasta tres páginas reales por
 * plataforma, las pasa por el endpoint JIT local y, cuando hay un medio
 * directo, lee únicamente el primer bloque para distinguir HLS/MP4 de HTML.
 * Se niega a ejecutarse mientras la verificación global está activa para no
 * competir por el presupuesto de resolución.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../server/db";

const BASE_URL = process.env.MERISTREAM_BASE_URL?.trim() || "http://127.0.0.1:3010";
const SAMPLE_LIMIT = Math.max(1, Math.min(5, Number(process.env.SOURCE_HEALTH_SAMPLES || 3)));
const TIMEOUT_MS = 18_000;

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

type Sample = { platform: string; url: string };

async function adminCookie(): Promise<string> {
  const user = process.env.ADMIN_USER?.trim() || "";
  const password = process.env.ADMIN_PASS || "";
  if (!user || !password) throw new Error("ADMIN_USER/ADMIN_PASS no configurados");
  const response = await fetch(`${BASE_URL}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, password }),
  });
  if (!response.ok) throw new Error(`login administrativo HTTP ${response.status}`);
  const raw = typeof (response.headers as any).getSetCookie === "function"
    ? (response.headers as any).getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const cookie = raw.find((value: string) => value.includes("meristream_admin_session="));
  if (!cookie) throw new Error("la API no devolvió cookie administrativa");
  return cookie.split(";", 1)[0];
}

async function assertVerificationIdle(cookie: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/v1/verification`, { headers: { Cookie: cookie } });
  if (!response.ok) throw new Error(`consulta de verificación HTTP ${response.status}`);
  const status = await response.json() as { running?: boolean; phase?: string };
  if (status.running || status.phase !== "idle") {
    throw new Error(`verificación activa (${status.phase || "desconocida"}); auditoría aplazada`);
  }
}

async function samplesFor(platform: { id: string; pattern: string }): Promise<Sample[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ url: string }>>(
    `SELECT DISTINCT ON (sl.url) sl.url
       FROM "SourceLink" sl
      WHERE sl.source_site ILIKE $1
        AND sl.link_type = 'page'
        AND sl.url IS NOT NULL AND sl.url <> ''
      ORDER BY sl.url, sl.id
      LIMIT $2`,
    platform.pattern,
    SAMPLE_LIMIT,
  );
  return rows.map((row) => ({ platform: platform.id, url: row.url }));
}

function looksDirect(url: string): boolean {
  return /\.(?:m3u8|mp4|webm|mkv)(?:[?#]|$)/i.test(url);
}

async function readFirstBytes(url: string): Promise<{ ok: boolean; status: number; kind: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      headers: { Range: "bytes=0-4095", Accept: "*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    const reader = response.body?.getReader();
    const chunk = reader ? await reader.read() : { value: undefined };
    await reader?.cancel();
    const bytes = chunk.value ? Buffer.from(chunk.value) : Buffer.alloc(0);
    const text = bytes.toString("utf8", 0, Math.min(bytes.length, 256));
    const contentType = response.headers.get("content-type") || "";
    const hls = /#EXTM3U/i.test(text) || /mpegurl/i.test(contentType);
    const media = /^(video|audio)\//i.test(contentType) || /octet-stream/i.test(contentType);
    return { ok: response.ok && (hls || media || bytes.length > 0), status: response.status, kind: hls ? "hls" : media ? "media" : "bytes" };
  } catch {
    return { ok: false, status: 0, kind: "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

async function auditSample(sample: Sample, cookie: string): Promise<Record<string, unknown>> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/api/v1/catalog/episode-servers`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ url: sample.url }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as {
      resolved?: boolean;
      ranked_streams?: Array<{ url?: string; type?: string }>;
    };
    const streams = Array.isArray(payload.ranked_streams) ? payload.ranked_streams.filter((item) => typeof item?.url === "string") : [];
    const direct = streams.filter((item) => looksDirect(item.url || ""));
    const probe = direct[0]?.url ? await readFirstBytes(direct[0].url) : null;
    return {
      platform: sample.platform,
      http_status: response.status,
      resolved: Boolean(payload.resolved),
      ranked_streams: streams.length,
      direct_streams: direct.length,
      embed_streams: streams.length - direct.length,
      first_byte_probe: probe ? { ok: probe.ok, status: probe.status, kind: probe.kind } : null,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      platform: sample.platform,
      http_status: 0,
      resolved: false,
      ranked_streams: 0,
      direct_streams: 0,
      embed_streams: 0,
      first_byte_probe: null,
      latency_ms: Date.now() - started,
      error: String(error).slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const cookie = await adminCookie();
  await assertVerificationIdle(cookie);
  const samples = (await Promise.all(PLATFORMS.map(samplesFor))).flat();
  const results: Record<string, unknown>[] = [];
  // Dos solicitudes como máximo: la auditoría no debe parecer otro crawler.
  for (let index = 0; index < samples.length; index += 2) {
    const batch = samples.slice(index, index + 2);
    results.push(...await Promise.all(batch.map((sample) => auditSample(sample, cookie))));
  }
  const byPlatform = Object.fromEntries(PLATFORMS.map((platform) => {
    const rows = results.filter((row) => row.platform === platform.id);
    const playable = rows.filter((row) => Number(row.ranked_streams) > 0).length;
    return [platform.id, { samples: rows.length, playable, results: rows }];
  }));
  const report = {
    generated_at: new Date().toISOString(),
    samples_per_platform: SAMPLE_LIMIT,
    request_concurrency: 2,
    note: "Solo lectura; no actualiza SourceLink. Las páginas embed requieren prueba visual posterior.",
    platforms: byPlatform,
  };
  const output = path.resolve(`docs/workstreams/source-health-audit-${new Date().toISOString().slice(0, 10)}.json`);
  const markdown = path.resolve(`docs/workstreams/source-health-audit-${new Date().toISOString().slice(0, 10)}.md`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2), "utf8");
  const mdRows = PLATFORMS.map((platform) => {
    const entry = byPlatform[platform.id] as { samples: number; playable: number; results: Array<Record<string, unknown>> };
    const direct = entry.results.reduce((total, row) => total + Number(row.direct_streams || 0), 0);
    const probes = entry.results.filter((row) => (row.first_byte_probe as { ok?: boolean } | null)?.ok).length;
    return `| ${platform.id} | ${entry.samples} | ${entry.playable} | ${direct} | ${probes} |`;
  });
  await writeFile(markdown, [
    `# Salud de fuentes — ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Muestras: hasta ${SAMPLE_LIMIT} páginas por plataforma; concurrencia 2. Solo lectura y ejecutada con la verificación global inactiva.`,
    "",
    "| Plataforma | Muestras | Con candidatos | Streams directos | Sonda de primer bloque OK |",
    "|---|---:|---:|---:|---:|",
    ...mdRows,
    "",
    "Los candidatos embed requieren validación visual del navegador; una sonda fallida no modifica ni elimina el enlace canónico.",
  ].join("\n"), "utf8");
  console.log(JSON.stringify({ output, markdown, samples: samples.length, results: results.length }, null, 2));
}

main().catch((error) => {
  console.error(`[source-health-audit] ${String(error)}`);
  process.exitCode = 2;
}).finally(async () => {
  await prisma.$disconnect();
});
