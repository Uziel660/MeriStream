import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Helpers reutilizables para validación E2E de streams de video.
 * - Refactor desde e2e/adapters-real.spec.ts
 * - Evita CDN: usa copia local de node_modules/hls.js/dist/hls.min.js vía page.addScriptTag({path})
 * - Hls({enableWorker:false}) para bajo consumo (workers=1 serial)
 */

// Ruta absoluta a la copia local de hls.js (estable, sin red externa)
export const HLS_LOCAL_PATH = path.resolve(process.cwd(), 'node_modules/hls.js/dist/hls.min.js');

// Mux HLS público estable para pruebas DirectStream y GenericAdapter local
export const MUX_HLS_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

// Validación estricta de URL directa
export const DIRECT_MEDIA_RE = /\.(mp4|m3u8|webm|mkv)(\?|#|$)/i;
export const DIRECT_MEDIA_HINT_RE = /\/m3u8\/|hls-vod|\.m3u8/i;
// Hosts embed que indican iframe sin resolver si no hay extensión directa
export const EMBED_HOST_RE =
  /(?:streamtape|streamwish|filemoon|vidmoly|upstream|fastre|streamhide|swhoi|dood|dsvplay|d000d|ds2play|do7go|uqload|vidhide|vixhide|voe|byselapuix|byseqekaho|bysekoze|hexload|bysesukior|zilla-networks|byselapuix|mega\.nz|mp4upload|yourupload|ok\.ru|vimeos|hqq\.|waaw|cvary\.org|divxplayer|embed|player|iframe)/i;

/** true si es URL de media directa (mp4/m3u8/webm/mkv) */
export function isDirectMediaUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return DIRECT_MEDIA_RE.test(lower) || DIRECT_MEDIA_HINT_RE.test(lower);
}

/** Probe ligero para rechazar 404, HTML o error de red */
export async function probeUrl(url: string): Promise<{ status: number; contentType: string; ok: boolean }> {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    let res = await fetch(url, { method: 'HEAD', signal: controller.signal, headers });
    // Algunos CDNs no soportan HEAD y responden 405 -> reintentar con Range GET
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { ...headers, Range: 'bytes=0-1' },
      });
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    return { status: res.status, contentType, ok: res.ok };
  } catch {
    return { status: 0, contentType: '', ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Valida el stream_url extraído contra todos los criterios de rechazo.
 * Lanza expect() que falla con mensaje explícito si no es directo.
 */
export async function assertDirectStreamOrFail(streamUrl: string, pageUrl: string, adapterName: string) {
  expect(streamUrl, `[${adapterName}] stream_url vacío - no hay URL directa, debe fallar (no aceptar embed)`).toBeTruthy();
  expect(
    streamUrl.trim().toLowerCase(),
    `[${adapterName}] stream_url no debe ser la URL de página (embed sin resolver)`,
  ).not.toBe(pageUrl.trim().toLowerCase());

  // Debe ser media directa, no embed genérico
  const isDirect = isDirectMediaUrl(streamUrl);
  const looksEmbed = EMBED_HOST_RE.test(streamUrl) && !isDirect;
  expect(
    isDirect,
    `[${adapterName}] stream_url debe ser media directa (.mp4/.m3u8/.webm/.mkv). Recibido: ${streamUrl} - Si es embed/iframe sin resolver, el test debe FALLAR`,
  ).toBeTruthy();
  expect(
    looksEmbed,
    `[${adapterName}] stream_url parece embed/iframe sin resolver y debe fallar: ${streamUrl}`,
  ).toBeFalsy();

  // No debe ser 404 ni HTML
  const probe = await probeUrl(streamUrl);
  expect(probe.status, `[${adapterName}] stream_url responde 404 (pageUrl: ${pageUrl}, stream: ${streamUrl})`).not.toBe(404);
  expect(probe.ok, `[${adapterName}] stream_url no responde OK (status ${probe.status}): ${streamUrl}`).toBeTruthy();
  // content-type text/html indica página de descarga/bloqueo, no video
  if (probe.contentType) {
    const isHtml = probe.contentType.includes('text/html');
    // Permitir text/html solo si es fallback de m3u8? No: requisito dice rechazar HTML -> fallar
    expect(
      isHtml,
      `[${adapterName}] stream_url devolvió HTML (content-type: ${probe.contentType}) - no es stream directo: ${streamUrl}`,
    ).toBeFalsy();
  }
}

/**
 * Carga HTML controlado con <video> y valida reproducción real.
 * Soporta mp4 nativo y m3u8 vía hls.js inyectado DESDE COPIA LOCAL (no CDN).
 * Usa Hls({enableWorker:false}) por bajo consumo / estabilidad en workers=1.
 */
export async function assertVideoPlays(page: Page, streamUrl: string, adapterName: string) {
  // Verificar que existe la copia local antes de inyectar
  if (!fs.existsSync(HLS_LOCAL_PATH)) {
    throw new Error(`[${adapterName}] No se encontró hls.js local en ${HLS_LOCAL_PATH}. Verifica que hls.js está instalado.`);
  }

  // HTML controlado mínimo: video 640x360, muted autoplay para evitar bloqueo
  await page.setContent(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh">
<video id="v" controls muted playsinline crossorigin="anonymous" style="width:640px;height:360px;background:#000"></video>
</body></html>`,
    { waitUntil: 'domcontentloaded' },
  );

  // Inyectar src con manejo hls.js para .m3u8 (Chromium no soporta HLS nativo)
  const isHls = streamUrl.toLowerCase().includes('.m3u8') || streamUrl.toLowerCase().includes('/m3u8/');
  if (isHls) {
    // Cargar hls.js desde copia local (estable, pocos recursos, sin CDN)
    await page.addScriptTag({ path: HLS_LOCAL_PATH });
    await page.evaluate(
      async (src) => {
        const video = document.getElementById('v') as HTMLVideoElement;
        // @ts-ignore
        const Hls = (window as any).Hls;
        if (Hls && Hls.isSupported()) {
          // enableWorker:false por bajo consumo y estabilidad
          const hls = new Hls({ enableWorker: false });
          hls.loadSource(src);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = src;
          video.play().catch(() => {});
        } else {
          video.src = src;
          video.play().catch(() => {});
        }
      },
      streamUrl,
    );
  } else {
    await page.evaluate(
      (src) => {
        const v = document.getElementById('v') as HTMLVideoElement;
        v.src = src;
        v.load();
        v.play().catch(() => {});
      },
      streamUrl,
    );
  }

  const video = page.locator('video');
  await expect(video, `[${adapterName}] <video> debe ser visible en HTML controlado`).toBeVisible({ timeout: 10_000 });

  // Esperar readyState >= 2 (HAVE_CURRENT_DATA), dimensiones >0 y error nulo
  await page.waitForFunction(
    () => {
      const v = document.getElementById('v') as HTMLVideoElement;
      if (!v) return false;
      return v.error === null && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0;
    },
    null,
    { timeout: 25_000 },
  );

  const state = await page.evaluate(() => {
    const v = document.getElementById('v') as HTMLVideoElement;
    return {
      error: v.error ? { code: v.error.code, message: v.error.message } : null,
      readyState: v.readyState,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      currentTime: v.currentTime,
      duration: v.duration,
      src: v.currentSrc || v.src,
    };
  });

  expect(state.error, `[${adapterName}] video.error debe ser null. stream: ${streamUrl} error: ${JSON.stringify(state.error)}`).toBeNull();
  expect(state.readyState, `[${adapterName}] readyState >=2 (HAVE_CURRENT_DATA). stream: ${streamUrl} readyState=${state.readyState}`).toBeGreaterThanOrEqual(2);
  expect(state.videoWidth, `[${adapterName}] videoWidth >0. stream: ${streamUrl}`).toBeGreaterThan(0);
  expect(state.videoHeight, `[${adapterName}] videoHeight >0. stream: ${streamUrl}`).toBeGreaterThan(0);

  // Comprobar currentTime avanza (no congelado)
  const t0 = state.currentTime;
  // Si está pausado, forzar play
  await page.evaluate(() => {
    const v = document.getElementById('v') as HTMLVideoElement;
    if (v.paused) v.play().catch(() => {});
  });
  await page.waitForTimeout(1500);
  const t1 = await page.evaluate(() => (document.getElementById('v') as HTMLVideoElement).currentTime);
  await page.waitForTimeout(1500);
  const t2 = await page.evaluate(() => (document.getElementById('v') as HTMLVideoElement).currentTime);

  // Al menos uno de los dos avances debe ser > t0, y t2 > t1 o t2>0
  const advanced = t1 > t0 || t2 > t1 || t2 > 0;
  expect(
    advanced,
    `[${adapterName}] currentTime debe avanzar (t0=${t0}, t1=${t1}, t2=${t2}) stream: ${streamUrl}`,
  ).toBeTruthy();
  expect(t2, `[${adapterName}] currentTime final >0`).toBeGreaterThan(0);
}
