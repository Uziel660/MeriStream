import { expect, test } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

function firstMediaLine(manifest: string): string | null {
  return manifest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#')) || null;
}

test.describe('Cobertura E2E de límites de proveedores', () => {
  test('GnulaHD resuelve su página a HLS nativo y entrega un segmento', async ({ page }) => {
    test.setTimeout(120_000);
    const gnulaPage = 'https://ww3.gnulahd.nu/ver/coyote-vs-acme/';

    // La navegación real confirma que la ficha pública sigue accesible.
    const landing = await page.goto(gnulaPage, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    expect(landing?.status()).toBe(200);
    expect(landing?.headers()['content-type']).toMatch(/text\/html/i);

    const resolveResponse = await page.request.post(`${BASE_URL}/api/v1/resolve-embed`, {
      data: { url: gnulaPage },
      timeout: 60_000,
    });
    expect(resolveResponse.status()).toBe(200);
    const resolution = await resolveResponse.json();
    expect(resolution.resolved).toBe(true);
    expect(resolution.type).toBe('direct');
    expect(resolution.url).toMatch(/^https?:\/\/[^\s]+\.m3u8(?:\?|$)/i);
    expect(resolution.url).not.toMatch(/<iframe|embed/i);

    const manifestResponse = await page.request.get(resolution.url, {
      headers: {
        Referer: gnulaPage,
        Origin: 'https://ww3.gnulahd.nu',
      },
      timeout: 45_000,
    });
    expect(manifestResponse.status()).toBe(200);
    expect(manifestResponse.headers()['content-type']).toMatch(/mpegurl/i);
    const master = await manifestResponse.text();
    expect(master).toContain('#EXTM3U');

    const childUrl = firstMediaLine(master);
    expect(childUrl).toMatch(/\.m3u8(?:\?|$)/i);
    const childResponse = await page.request.get(new URL(childUrl!, resolution.url).toString(), {
      headers: { Referer: gnulaPage, Origin: 'https://ww3.gnulahd.nu' },
      timeout: 45_000,
    });
    expect(childResponse.status()).toBe(200);
    const child = await childResponse.text();
    const segment = firstMediaLine(child);
    expect(segment).toMatch(/\.(?:ts|m4s)(?:\?|$)/i);

    const segmentResponse = await page.request.get(new URL(segment!, childUrl!).toString(), {
      headers: { Range: 'bytes=0-1023', Referer: gnulaPage, Origin: 'https://ww3.gnulahd.nu' },
      timeout: 45_000,
    });
    expect([200, 206]).toContain(segmentResponse.status());
    expect(segmentResponse.headers()['content-type']).toMatch(/(?:video\/(?:mp2t|mp4)|octet-stream)/i);
  });

  test('VidSrc queda explícitamente fuera del playback cuando solo entrega una página', async ({ page }) => {
    test.setTimeout(90_000);
    const landing = await page.goto('https://vidsrc.sbs/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    expect(landing?.status()).toBe(200);
    expect(landing?.headers()['content-type']).toMatch(/text\/html/i);

    const response = await page.request.post(`${BASE_URL}/api/v1/resolve-embed`, {
      data: { url: 'https://vidsrc.sbs/' },
      timeout: 45_000,
    });
    expect(response.status()).toBe(200);
    const resolution = await response.json();
    expect(resolution.resolved).toBe(false);
    expect(resolution.type).toBe('embed');
    expect(resolution.failure_reason).toBe('unresolved');
    expect(resolution.url).not.toMatch(/\.(?:m3u8|mpd|mp4)(?:\?|$)/i);
    // La UI principal ya tiene una aserción global de ausencia de iframe en
    // los casos de reproducción; aquí validamos el límite del resolver.
  });

  test('las APIs directas solo cruzan el contrato con HLS/DASH/MP4', async ({ page }) => {
    test.setTimeout(90_000);
    const response = await page.request.get(`${BASE_URL}/api/v1/providers/movie/27205`, { timeout: 60_000 });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.sources)).toBe(true);
    expect(Array.isArray(body.fallbackCandidates)).toBe(true);
    for (const source of body.sources) {
      expect(source.url).toMatch(/^https?:\/\//i);
      expect(source.streamType).toMatch(/^(hls|dash|mp4)$/);
      expect(source.url).not.toMatch(/(?:iframe|embed|vidsrc\.sbs)/i);
    }
    for (const candidate of body.fallbackCandidates) {
      expect(candidate.type).toMatch(/^(page|embed)$/);
      expect(candidate.url).toMatch(/^https?:\/\//i);
    }
  });

  test('subtítulos externos quedan cerrados hasta configurar la API pública', async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/v1/subtitles?tmdb_id=27205&kind=movie&languages=es,en`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.configured).toBe(false);
    expect(body.tracks).toEqual([]);
    expect(body.reason).toBe('not_configured');
  });
});
