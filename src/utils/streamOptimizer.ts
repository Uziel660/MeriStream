// src/utils/streamOptimizer.ts

export interface ScoredServer {
  id: string;
  url: string;
  label: string;
  provider: string;
  quality: '4K' | '1080p' | '720p' | '480p' | 'Auto HD';
  isEmbed: boolean;
  score: number;
  health: 'excelente' | 'buena' | 'estable' | 'desconocida';
  latencyMs?: number;
}

/**
 * Detecta si una URL debe cargarse en iframe embed o en motor HLS/video nativo.
 */
export function isEmbedUrl(url: string): boolean {
  if (!url) return false;
  const u = url.toLowerCase();

  // Direct media files (.m3u8, .mp4, .webm, .mkv) are played via native HLS/Video
  if (
    (u.includes('.m3u8') || u.includes('.mp4') || u.includes('.webm') || u.includes('.mkv')) &&
    !u.includes('mega.nz') &&
    !u.includes('streamtape.com') &&
    !u.includes('mp4upload.com') &&
    !u.includes('voe.sx') &&
    !u.includes('/embed') &&
    !u.includes('/e/')
  ) {
    return false;
  }

  return (
    u.includes('player.zilla-networks.com') ||
    u.includes('/embed') ||
    u.includes('/e/') ||
    u.includes('voe.') ||
    u.includes('mega.nz') ||
    u.includes('mp4upload.com') ||
    u.includes('streamtape.com') ||
    u.includes('byselapuix.com') ||
    u.includes('ok.ru/videoembed') ||
    u.includes('streamwish') ||
    u.includes('filemoon') ||
    u.includes('yourupload.com') ||
    u.includes('vidmoly') ||
    u.includes('dood') ||
    u.includes('fembed') ||
    u.includes('mixdrop') ||
    u.includes('uqload') ||
    u.includes('upstream') ||
    u.includes('embedsito') ||
    u.includes('streamlare') ||
    u.includes('fastre')
  );
}

/**
 * Extrae la calidad estimada a partir de la URL o nombres de archivo
 */
export function detectQualityFromUrl(url: string): '4K' | '1080p' | '720p' | '480p' | 'Auto HD' {
  const u = url.toLowerCase();
  if (u.includes('4k') || u.includes('2160p')) return '4K';
  if (u.includes('1080p') || u.includes('fullhd') || u.includes('fhd')) return '1080p';
  if (u.includes('720p') || u.includes('hd')) return '720p';
  if (u.includes('480p') || u.includes('sd')) return '480p';
  if (u.includes('.m3u8') || u.includes('mux.dev')) return 'Auto HD';
  return '1080p';
}

/**
 * Obtiene el nombre del proveedor amigable y legible
 */
export function getProviderName(url: string, index: number): string {
  const u = url.toLowerCase();
  if (u.includes('mux.dev') || u.includes('test-streams')) return 'CDN Ultra HLS (Rápido)';
  if (u.includes('commondatastorage.googleapis.com') || u.includes('storage.googleapis')) return 'Google Fast Direct';
  if (u.includes('zilla-networks')) return 'Zilla HLS Network';
  if (u.includes('voe.sx') || u.includes('voe.') || u.includes('byselapuix')) return 'VOE HighSpeed';
  if (u.includes('streamwish')) return 'Streamwish CDN';
  if (u.includes('filemoon')) return 'Filemoon HD';
  if (u.includes('yourupload')) return 'YourUpload';
  if (u.includes('streamtape')) return 'Streamtape CDN';
  if (u.includes('mega.nz')) return 'Mega Cloud';
  if (u.includes('mp4upload')) return 'MP4Upload HD';
  if (u.includes('vidmoly')) return 'Vidmoly Fast';
  if (u.includes('dood')) return 'Doodstream';
  if (u.includes('fembed')) return 'Fembed HD';
  if (u.includes('mixdrop')) return 'Mixdrop';
  if (u.includes('uqload')) return 'Uqload Fast';
  if (u.includes('animeflv')) return 'AnimeFLV Server';
  if (u.includes('jkanime')) return 'JKanime Server';
  if (u.endsWith('.m3u8') || u.includes('/m3u8/')) return `HLS Master ${index + 1}`;
  if (u.endsWith('.mp4')) return `Direct MP4 ${index + 1}`;
  return `Servidor ${index + 1}`;
}

/**
 * Evalúa y califica un servidor multimedia para ordenar por máxima calidad y mejor salud
 */
export function scoreServer(url: string, index: number): ScoredServer {
  const isEmbed = isEmbedUrl(url);
  const quality = detectQualityFromUrl(url);
  const provider = getProviderName(url, index);
  const u = url.toLowerCase();

  let score = 50; // base

  // 1. Prioridad por Calidad
  if (quality === '4K') score += 50;
  else if (quality === '1080p') score += 40;
  else if (quality === 'Auto HD') score += 38;
  else if (quality === '720p') score += 25;
  else if (quality === '480p') score += 10;

  // 2. Prioridad por Tipo de Entrega (HLS Nativo / Direct CDN > Embeds con publicidad)
  if (u.includes('.m3u8')) score += 25; // HLS nativo adaptativo de alta fidelidad
  if (u.includes('commondatastorage.googleapis.com') || u.includes('mux.dev')) score += 20; // Google / Mux ultra confiable
  if (!isEmbed) score += 15; // Reproductor nativo siempre brinda mejor experiencia

  // 3. Calificación de Salud y Estabilidad Heurística
  let health: ScoredServer['health'] = 'excelente';
  if (isEmbed) {
    if (u.includes('voe.sx') || u.includes('byselapuix')) {
      health = 'buena';
      score += 10;
    } else if (u.includes('mega.nz')) {
      health = 'buena';
      score += 8;
    } else {
      health = 'estable';
    }
  }

  const label = `[${quality}] ${provider}`;

  return {
    id: `server-${index}-${Math.abs(hashString(url))}`,
    url,
    label,
    provider,
    quality,
    isEmbed,
    score,
    health,
  };
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/**
 * Ordena servidores de mayor a menor calidad y salud, eliminando duplicados.
 */
export function rankAndSortServers(urls: string[]): ScoredServer[] {
  const uniqueUrls = Array.from(new Set(urls.filter((u) => Boolean(u && typeof u === 'string'))));

  const scored = uniqueUrls.map((url, idx) => scoreServer(url, idx));

  // Ordenar descendentemente por puntuación (máxima calidad + salud primero)
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Comprobación ultrarrápida de salud en segundo plano (no bloqueante)
 */
export async function quickProbeServerHealth(server: ScoredServer, timeoutMs = 1200): Promise<number | null> {
  if (server.isEmbed) return null; // Los iframes no se pueden sondear por CORS
  try {
    const start = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(server.url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { Range: 'bytes=0-100' },
    });
    clearTimeout(timer);
    if (res.ok || res.status === 206) {
      return Math.round(performance.now() - start);
    }
    return null;
  } catch {
    return null;
  }
}
