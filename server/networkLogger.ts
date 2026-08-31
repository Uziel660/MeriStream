// server/networkLogger.ts
//
// Logger centralizado de red, experiencia de reproducción (telemetría E2E),
// resolución de scrapers y detección de buffering/pantallas negras.
//
// Persiste en dos archivos JSONL en ./logs/:
//   1. proxy-network.jsonl  → peticiones de red directas, proxy y MEGA
//   2. player-events.jsonl   → eventos del reproductor y scrapers

import fs from "fs";
import path from "path";

// ── Mapeo Inteligente de CDNs a Proveedores Registrados ──

export interface ResolvedProviderInfo {
  providerName: string;
  category: "HLS Nativo" | "MP4 Directo" | "MEGA" | "Embed con Anuncios" | "Scraper Web" | "CDN Video";
  isEmbed: boolean;
}

export function resolveRegisteredProvider(targetUrl: string, referer?: string): ResolvedProviderInfo {
  const u = (targetUrl || "").toLowerCase();
  const ref = (referer || "").toLowerCase();

  // MEGA
  if (u.includes("mega.nz") || u.includes("mega.co") || u.includes("/stream/mega")) {
    return { providerName: "MEGA Cloud", category: "MEGA", isEmbed: false };
  }

  // AnimeFLV / TioAnime CDNs (ducvomes, playmudos, animeflv)
  if (u.includes("ducvomes.com") || u.includes("playmudos.com") || u.includes("animeflv.net") || ref.includes("animeflv")) {
    return { providerName: "AnimeFLV (HLS)", category: "HLS Nativo", isEmbed: false };
  }

  // Streamwish y sus CDNs dinámicos (dramiyos, premilky, wishembed, streamwish)
  if (u.includes("streamwish") || u.includes("dramiyos.com") || u.includes("premilky.com") || u.includes("wishembed") || u.includes("strwish") || u.includes("streamwis")) {
    return { providerName: "Streamwish", category: "CDN Video", isEmbed: u.includes("/e/") || u.includes("/embed") };
  }

  // VOE y sus dominios de entrega (voe.sx, byselapuix, yodabox, tuktukbox, etc.)
  if (u.includes("voe.sx") || u.includes("voe.") || u.includes("byselapuix") || u.includes("yodabox") || u.includes("tuktukbox") || u.includes("launchprotective")) {
    return { providerName: "VOE (HighSpeed)", category: "Embed con Anuncios", isEmbed: true };
  }

  // Goodstream
  if (u.includes("goodstream.one") || u.includes("goodstream")) {
    return { providerName: "Goodstream HD", category: "HLS Nativo", isEmbed: false };
  }

  // Zilla Networks
  if (u.includes("zilla-networks.com") || u.includes("player.zilla-networks")) {
    return { providerName: "Zilla Networks", category: "HLS Nativo", isEmbed: false };
  }

  // MP4Upload
  if (u.includes("mp4upload.com")) {
    return { providerName: "MP4Upload", category: "MP4 Directo", isEmbed: u.includes("/embed") };
  }

  // Filemoon
  if (u.includes("filemoon") || u.includes("moonplayer") || u.includes("filemooon")) {
    return { providerName: "Filemoon HD", category: "Embed con Anuncios", isEmbed: true };
  }

  // Mixdrop
  if (u.includes("mixdrop.co") || u.includes("mixdrop.to") || u.includes("mixdrop")) {
    return { providerName: "Mixdrop", category: "Embed con Anuncios", isEmbed: true };
  }

  // DoodStream
  if (u.includes("dood") || u.includes("ds2play") || u.includes("doodstream")) {
    return { providerName: "Doodstream", category: "Embed con Anuncios", isEmbed: true };
  }

  // TurboViPlay / TurboSPlayer (TioPlus)
  if (u.includes("turboviplay.com") || u.includes("turbosplayer.com") || ref.includes("tioplus")) {
    return { providerName: "TurboViPlay (TioPlus)", category: "HLS Nativo", isEmbed: false };
  }

  // YourUpload
  if (u.includes("yourupload.com")) {
    return { providerName: "YourUpload", category: "Embed con Anuncios", isEmbed: true };
  }

  // Vidmoly
  if (u.includes("vidmoly.to") || u.includes("vidmoly.me") || u.includes("vidmoly")) {
    return { providerName: "Vidmoly", category: "Embed con Anuncios", isEmbed: true };
  }

  // Archive.org
  if (u.includes("archive.org")) {
    return { providerName: "Archive.org", category: "MP4 Directo", isEmbed: false };
  }

  // Google / Mux
  if (u.includes("googleapis.com") || u.includes("mux.dev")) {
    return { providerName: "Google Fast Direct", category: "MP4 Directo", isEmbed: false };
  }

  // Si es un .m3u8 genérico
  if (u.includes(".m3u8") || u.includes("mpegurl")) {
    const host = extractHost(targetUrl);
    return { providerName: `HLS (${host})`, category: "HLS Nativo", isEmbed: false };
  }

  const host = extractHost(targetUrl);
  return { providerName: host, category: "CDN Video", isEmbed: false };
}

// ── Tipos de Red / Proxy / MEGA ──

export interface ProxyLogEntry {
  id: number;
  ts: string;
  targetUrl: string;
  host: string;
  providerName: string;
  category: string;
  mediaTitle?: string;
  resourceType: "m3u8" | "segment" | "mp4" | "mega" | "other";
  upstreamStatus: number;
  ok: boolean;
  durationMs: number;
  bytesReceived: number;
  error?: string;
  errorType: "timeout" | "dns" | "connection" | "http_4xx" | "http_5xx" | "quota_429" | "stream_corrupt" | "none";
  referer?: string;
  client: "undici" | "stealth" | "mega";
}

// ── Sanitización de Tokens en URLs ──

export function maskSignedTokens(rawUrl: string): string {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (
        [
          "t", "token", "jwt", "s", "e", "st", "sig", "signature", "auth",
          "hash", "key", "secret", "hdnts", "access_token", "authorization"
        ].includes(lower)
      ) {
        parsed.searchParams.set(key, "***");
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl.replace(/([?&](?:token|t|jwt|s|e|st|sig|signature|auth|hash)=)[^&]+/gi, "$1***");
  }
}

// ── Tipos de Eventos del Reproductor y Scraper ──

export type PlayerEventType =
  | "play_requested"
  | "source_selected"
  | "resolution_started"
  | "resolution_succeeded"
  | "resolution_failed"
  | "direct_started"
  | "direct_failed"
  | "proxy_session_created"
  | "proxy_upstream_rejected"
  | "session_refreshed"
  | "embed_selected"
  | "manual_failover"
  | "playback_confirmed"
  | "scraper_resolution"      // El backend extrajo los servidores de un episodio
  | "scraper_failed"          // El backend no pudo encontrar servidores para un episodio
  | "embed_opened"            // Se abrió un servidor Embed (iframe con posibles anuncios/captchas)
  | "playback_started"        // El video comenzó a reproducir frames reales (OK)
  | "playback_buffering"      // El video se pausó a mitad por falta de buffer (CDN lenta)
  | "black_screen_stalled"    // El reproductor esperó >6s y nunca mostró imagen ni avanzó
  | "playback_error"          // Error fatal de HTML5 <video> o Hls.js
  | "failover_auto"           // El reproductor saltó automáticamente al siguiente server
  | "quota_fallback"          // MEGA o host devolvió cuota agotada -> fallback a embed
  | "embed_unresolvable";

export interface PlayerEventEntry {
  id: number;
  ts: string;
  eventType: PlayerEventType;
  provider: string;           // Nombre real del servidor (e.g. "AnimeFLV (HLS)", "Streamwish", "VOE", "MEGA")
  serverUrl: string;          // URL del stream o embed (con tokens enmascarados)
  host: string;               // Hostname real
  playback_attempt_id?: string | number;
  mediaTitle?: string;        // Título del anime/película
  episodeTitle?: string;      // Episodio
  durationBeforeErrorMs?: number; // Cuánto tardó en arrancar / fallar
  bufferPauseCount?: number;  // Cuántas veces se ha pausado por buffer
  status?: number;            // Código de estado HTTP o error code
  reason?: string;            // Motivo estructurado de fallo o transición
  details?: string;           // Mensaje descriptivo
}

export interface HostStats {
  host: string;
  providerName: string;
  category: string;
  totalRequests: number;
  successes: number;
  failures: number;
  successRate: number;
  avgDurationMs: number;
  totalBytes: number;
  errorBreakdown: Record<string, number>;
  resourceBreakdown: Record<string, { total: number; ok: number; fail: number }>;
  firstSeen: string;
  lastSeen: string;
}

export interface ProviderHealthReport {
  provider: string;
  category: string;
  totalAttempts: number;
  successfulPlays: number;
  blackScreens: number;
  bufferingStalls: number;
  fatalErrors: number;
  failovers: number;
  avgTimeToPlayMs: number;
  status: "EXCELENTE" | "ACEPTABLE (LENTO/ANUNCIOS)" | "INESTABLE (PAUSAS/STALLS)" | "MUERTO (PANTALLA NEGRA)";
  recentEvents: PlayerEventEntry[];
}

// ── Configuración de Archivos y Sesiones Timestamped ──

const LOG_DIR = path.resolve("logs");
const SESSIONS_DIR = path.join(LOG_DIR, "sessions");
const PROXY_LOG_FILE = path.join(LOG_DIR, "proxy-network.jsonl");
const PLAYER_LOG_FILE = path.join(LOG_DIR, "player-events.jsonl");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function formatTimestampForFile(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`;
}

let currentSessionId = formatTimestampForFile();
let currentSessionFile = path.join(SESSIONS_DIR, `session_${currentSessionId}.jsonl`);

let proxyWriteStream = fs.createWriteStream(PROXY_LOG_FILE, { flags: "a" });
let playerWriteStream = fs.createWriteStream(PLAYER_LOG_FILE, { flags: "a" });
let sessionWriteStream = fs.createWriteStream(currentSessionFile, { flags: "a" });

let nextProxyId = 1;
let nextPlayerId = 1;

export function startNewSession(customLabel?: string): string {
  const ts = formatTimestampForFile();
  currentSessionId = customLabel ? `${ts}_${customLabel.replace(/[^a-zA-Z0-9_-]/g, "_")}` : ts;
  currentSessionFile = path.join(SESSIONS_DIR, `session_${currentSessionId}.jsonl`);
  
  if (sessionWriteStream) sessionWriteStream.end();
  sessionWriteStream = fs.createWriteStream(currentSessionFile, { flags: "a" });
  
  console.log(`[networkLogger] 📁 Nueva sesión de prueba iniciada: ${currentSessionFile}`);
  return currentSessionId;
}

export function getCurrentSessionInfo() {
  return {
    sessionId: currentSessionId,
    sessionFile: currentSessionFile,
  };
}

// ── Helpers ──

function extractHost(url: string): string {
  try {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return new URL(url).hostname;
    }
    return url.split("/")[0] || "unknown";
  } catch {
    return "unknown";
  }
}

function classifyResource(url: string): ProxyLogEntry["resourceType"] {
  const lower = url.toLowerCase();
  if (lower.includes("mega.nz") || lower.includes("/stream/mega")) return "mega";
  if (lower.includes(".m3u8") || lower.includes("mpegurl")) return "m3u8";
  if (
    lower.includes(".ts") ||
    lower.includes(".m4s") ||
    lower.includes("/segs/") ||
    lower.includes("/m3u8/")
  )
    return "segment";
  if (lower.includes(".mp4")) return "mp4";
  return "other";
}

function classifyError(
  status: number,
  errorMsg?: string
): ProxyLogEntry["errorType"] {
  if (!errorMsg && status >= 200 && status < 400) return "none";
  if (status === 429 || errorMsg?.includes("429") || /cuota|quota|etempunavail/i.test(errorMsg || ""))
    return "quota_429";
  if (errorMsg?.includes("TIMEOUT") || errorMsg?.includes("timeout"))
    return "timeout";
  if (errorMsg?.includes("ENOTFOUND") || errorMsg?.includes("no resoluble"))
    return "dns";
  if (
    errorMsg?.includes("ECONNREFUSED") ||
    errorMsg?.includes("ECONNRESET") ||
    errorMsg?.includes("UND_ERR")
  )
    return "connection";
  if (status >= 400 && status < 500) return "http_4xx";
  if (status >= 500) return "http_5xx";
  if (errorMsg?.includes("incompleto") || errorMsg?.includes("corrupt"))
    return "stream_corrupt";
  return "connection";
}

// ── API Pública: Registro de Peticiones de Red ──

export function logProxyRequest(data: {
  targetUrl: string;
  upstreamStatus: number;
  durationMs: number;
  bytesReceived: number;
  mediaTitle?: string;
  provider?: string;
  error?: string;
  referer?: string;
  client: "undici" | "stealth" | "mega";
}): ProxyLogEntry {
  const sanitizedUrl = maskSignedTokens(data.targetUrl);
  const info = resolveRegisteredProvider(data.targetUrl, data.referer);

  const entry: ProxyLogEntry = {
    id: nextProxyId++,
    ts: new Date().toISOString(),
    targetUrl: sanitizedUrl,
    host: extractHost(data.targetUrl),
    providerName: data.provider || info.providerName,
    category: info.category,
    mediaTitle: data.mediaTitle,
    resourceType: classifyResource(data.targetUrl),
    upstreamStatus: data.upstreamStatus,
    ok: data.upstreamStatus >= 200 && data.upstreamStatus < 400 && !data.error,
    durationMs: data.durationMs,
    bytesReceived: data.bytesReceived,
    error: data.error,
    errorType: classifyError(data.upstreamStatus, data.error),
    referer: data.referer,
    client: data.client,
  };

  const line = JSON.stringify(entry) + "\n";
  proxyWriteStream.write(line);
  if (sessionWriteStream && !sessionWriteStream.destroyed) {
    sessionWriteStream.write(JSON.stringify({ type: "network", ...entry }) + "\n");
  }
  return entry;
}

// ── API Pública: Registro de Eventos de Reproductor y Scraper ──

export function logPlayerEvent(data: {
  eventType: PlayerEventType;
  provider?: string;
  serverUrl: string;
  playback_attempt_id?: string | number;
  mediaTitle?: string;
  episodeTitle?: string;
  durationBeforeErrorMs?: number;
  bufferPauseCount?: number;
  status?: number;
  reason?: string;
  details?: string;
}): PlayerEventEntry {
  const sanitizedUrl = maskSignedTokens(data.serverUrl);
  const host = extractHost(data.serverUrl);
  const info = resolveRegisteredProvider(data.serverUrl);
  const provider = data.provider || info.providerName || host;

  const entry: PlayerEventEntry = {
    id: nextPlayerId++,
    ts: new Date().toISOString(),
    eventType: data.eventType,
    provider,
    serverUrl: sanitizedUrl,
    host,
    playback_attempt_id: data.playback_attempt_id,
    mediaTitle: data.mediaTitle,
    episodeTitle: data.episodeTitle,
    durationBeforeErrorMs: data.durationBeforeErrorMs,
    bufferPauseCount: data.bufferPauseCount,
    status: data.status,
    reason: data.reason,
    details: data.details,
  };

  const line = JSON.stringify(entry) + "\n";
  playerWriteStream.write(line);
  if (sessionWriteStream && !sessionWriteStream.destroyed) {
    sessionWriteStream.write(JSON.stringify({ type: "player", ...entry }) + "\n");
  }
  return entry;
}

// ── API Pública: Estadísticas Agregadas ──

export function getHostStats(): HostStats[] {
  const entries = readAllProxyEntries();
  const byProvider = new Map<string, ProxyLogEntry[]>();

  for (const entry of entries) {
    const key = entry.providerName || entry.host;
    const existing = byProvider.get(key);
    if (existing) existing.push(entry);
    else byProvider.set(key, [entry]);
  }

  const stats: HostStats[] = [];

  for (const [provider, entries] of byProvider) {
    const successes = entries.filter((e) => e.ok).length;
    const failures = entries.length - successes;
    const totalDuration = entries.reduce((s, e) => s + e.durationMs, 0);
    const totalBytes = entries.reduce((s, e) => s + e.bytesReceived, 0);

    const errorBreakdown: Record<string, number> = {};
    for (const e of entries) {
      if (e.errorType && e.errorType !== "none") {
        errorBreakdown[e.errorType] = (errorBreakdown[e.errorType] || 0) + 1;
      }
    }

    const resourceBreakdown: Record<string, { total: number; ok: number; fail: number }> = {};
    for (const e of entries) {
      if (!resourceBreakdown[e.resourceType]) {
        resourceBreakdown[e.resourceType] = { total: 0, ok: 0, fail: 0 };
      }
      resourceBreakdown[e.resourceType].total++;
      if (e.ok) resourceBreakdown[e.resourceType].ok++;
      else resourceBreakdown[e.resourceType].fail++;
    }

    stats.push({
      host: entries[0].host,
      providerName: provider,
      category: entries[0].category,
      totalRequests: entries.length,
      successes,
      failures,
      successRate: entries.length > 0 ? Math.round((successes / entries.length) * 100) : 0,
      avgDurationMs: entries.length > 0 ? Math.round(totalDuration / entries.length) : 0,
      totalBytes,
      errorBreakdown,
      resourceBreakdown,
      firstSeen: entries[0].ts,
      lastSeen: entries[entries.length - 1].ts,
    });
  }

  stats.sort((a, b) => b.totalRequests - a.totalRequests);
  return stats;
}

export function getProviderHealthStats(): ProviderHealthReport[] {
  const events = readAllPlayerEntries();
  const byProvider = new Map<string, PlayerEventEntry[]>();

  for (const ev of events) {
    const key = ev.provider || "Desconocido";
    const existing = byProvider.get(key);
    if (existing) existing.push(ev);
    else byProvider.set(key, [ev]);
  }

  const results: ProviderHealthReport[] = [];

  for (const [provider, evs] of byProvider) {
    const successfulPlays = evs.filter((e) => e.eventType === "playback_started" || e.eventType === "embed_opened").length;
    const blackScreens = evs.filter((e) => e.eventType === "black_screen_stalled").length;
    const bufferingStalls = evs.filter((e) => e.eventType === "playback_buffering").length;
    const fatalErrors = evs.filter((e) => e.eventType === "playback_error").length;
    const failovers = evs.filter((e) => e.eventType === "failover_auto" || e.eventType === "quota_fallback").length;
    const totalAttempts = successfulPlays + blackScreens + fatalErrors;

    const playEvents = evs.filter((e) => e.eventType === "playback_started" && e.durationBeforeErrorMs);
    const avgTimeToPlayMs = playEvents.length > 0
      ? Math.round(playEvents.reduce((s, e) => s + (e.durationBeforeErrorMs || 0), 0) / playEvents.length)
      : 0;

    const isEmbed = evs.some((e) => e.eventType === "embed_opened");

    let status: ProviderHealthReport["status"] = "EXCELENTE";
    if (blackScreens > 0 && successfulPlays === 0) {
      status = "MUERTO (PANTALLA NEGRA)";
    } else if (blackScreens > 0 || fatalErrors > 0 || bufferingStalls >= 3) {
      status = "INESTABLE (PAUSAS/STALLS)";
    } else if (isEmbed) {
      status = "ACEPTABLE (LENTO/ANUNCIOS)";
    }

    results.push({
      provider,
      category: isEmbed ? "Embed con Anuncios" : "Stream Nativo",
      totalAttempts: totalAttempts || evs.length,
      successfulPlays,
      blackScreens,
      bufferingStalls,
      fatalErrors,
      failovers,
      avgTimeToPlayMs,
      status,
      recentEvents: evs.slice(-6),
    });
  }

  results.sort((a, b) => b.totalAttempts - a.totalAttempts);
  return results;
}

export function getRecentLogs(limit = 100): ProxyLogEntry[] {
  const all = readAllProxyEntries();
  return all.slice(-limit);
}

export function getRecentPlayerEvents(limit = 100): PlayerEventEntry[] {
  const all = readAllPlayerEntries();
  return all.slice(-limit);
}

function readAllProxyEntries(): ProxyLogEntry[] {
  try {
    if (!fs.existsSync(PROXY_LOG_FILE)) return [];
    const content = fs.readFileSync(PROXY_LOG_FILE, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean) as ProxyLogEntry[];
  } catch {
    return [];
  }
}

function readAllPlayerEntries(): PlayerEventEntry[] {
  try {
    if (!fs.existsSync(PLAYER_LOG_FILE)) return [];
    const content = fs.readFileSync(PLAYER_LOG_FILE, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean) as PlayerEventEntry[];
  } catch {
    return [];
  }
}

export function clearLogs(): void {
  proxyWriteStream.end();
  playerWriteStream.end();
  fs.writeFileSync(PROXY_LOG_FILE, "");
  fs.writeFileSync(PLAYER_LOG_FILE, "");
  proxyWriteStream = fs.createWriteStream(PROXY_LOG_FILE, { flags: "a" });
  playerWriteStream = fs.createWriteStream(PLAYER_LOG_FILE, { flags: "a" });
  nextProxyId = 1;
  nextPlayerId = 1;
}

export function getLogFilePaths() {
  return {
    proxyLog: PROXY_LOG_FILE,
    playerLog: PLAYER_LOG_FILE,
  };
}
