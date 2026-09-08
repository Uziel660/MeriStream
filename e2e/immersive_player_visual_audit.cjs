const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.MERISTREAM_URL || 'http://127.0.0.1:3010';
const OUT_DIR = path.resolve(process.cwd(), 'artifacts/immersive-player-visual');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SUB_TOKEN_ES = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SUB_TOKEN_EN = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const catalogItem = {
  id: 'tmdb-movie-550', tmdb_id: 550, imdb_id: 'tt0137523', title: 'Fight Club',
  original_title: 'Fight Club', kind: 'movie', category: 'movie',
  description: 'Un oficinista insomne y un vendedor de jabón forman un club clandestino que termina convirtiéndose en algo mucho más grande.',
  synopsis: 'Un oficinista insomne y un vendedor de jabón forman un club clandestino que termina convirtiéndose en algo mucho más grande.',
  poster_path: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg', backdrop_path: '/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
  poster_url: 'https://image.tmdb.org/t/p/w500/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
  banner_url: 'https://image.tmdb.org/t/p/w1280/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
  backdrop_url: 'https://image.tmdb.org/t/p/w1280/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
  rating: 8.4, year: 1999, genres: ['Drama', 'Suspenso'], episode_count: 1, is_trending: true,
  sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] },
};

const masterManifest = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Español Latino",LANGUAGE="es-419",DEFAULT=YES,AUTOSELECT=YES,URI="/visual-audit/audio-es.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="/visual-audit/audio-en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2600000,AVERAGE-BANDWIDTH=2200000,RESOLUTION=1280x720,FRAME-RATE=24.000,AUDIO="audio"
/visual-audit/video-720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5200000,AVERAGE-BANDWIDTH=4600000,RESOLUTION=1920x1080,FRAME-RATE=24.000,AUDIO="audio"
/visual-audit/video-1080.m3u8
`;

const mediaManifest = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.000,
/visual-audit/segment-0.ts
#EXTINF:6.000,
/visual-audit/segment-1.ts
#EXT-X-ENDLIST
`;

const subtitleVtt = `WEBVTT

00:00:00.000 --> 00:00:05.500
Este es un subtítulo de auditoría de MeriStream.
`;

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installMocks(page) {
  await page.route('**/api/v1/catalog/public?**', (route) => json(route, {
    shows: [catalogItem], total: 1, page: 1, pageSize: 1, totalPages: 1, source: 'tmdb',
  }));
  await page.route(/\/api\/v1\/catalog\/public\/(movie|series|anime)\/(\d+)(?:\?.*)?$/, (route) => json(route, {
    ...catalogItem,
    episodes: [{ id: 'tmdb-movie-550-s1-e1', show_id: 'tmdb-movie-550', title: 'Fight Club', episode_number: 1, season_number: 1, source_url: 'tmdb://movie/550/1/1' }],
    external_ids: { imdb_id: 'tt0137523', tvdb_id: null, wikidata_id: null },
  }));
  await page.route('**/api/v1/recommendations**', (route) => json(route, {
    hero: catalogItem,
    rails: [{ id: 'cinema', title: 'Popular ahora', shows: [catalogItem] }],
  }));
  await page.route('**/api/v1/genres**', (route) => json(route, { genres: ['Drama', 'Suspenso'] }));
  await page.route(/\/api\/v1\/shows(?:\?.*)?$/, (route) => json(route, [catalogItem]));

  // Use the real App playback bootstrap instead of the old VidSrc-only dev
  // harness. This validates catalog -> details -> play -> HLSPlayerModal and
  // therefore exercises the same subtitle sanitation used in production.
  await page.route(/\/api\/v1\/providers\/movie\/550(?:\?.*)?$/, (route) => json(route, {
    sources: [{
      provider: 'vidsrc',
      canonicalLocator: 'https://vidsrc.me/embed/movie/550',
      url: 'https://resolver.invalid/visual-master.m3u8',
      streamType: 'hls',
      audioLanguage: 'es-419',
      subtitleLanguage: 'es-419',
      requiredHeaders: { Referer: 'https://vidsrc.me/' },
      subtitles: [
        { id: 'es', label: 'Español Latino', language: 'es-419', url: `/api/v1/subtitles/file/${SUB_TOKEN_ES}.vtt`, is_default: true },
        { id: 'en', label: 'English SDH', language: 'en', url: `/api/v1/subtitles/file/${SUB_TOKEN_EN}.vtt` },
      ],
    }],
    fallbackCandidates: [],
  }));

  await page.route(/\/api\/v1\/play\/tmdb-movie-550-s1-e1(?:\?.*)?$/, (route) => json(route, { error: 'public virtual episode has no legacy row' }, 404));
  await page.route(/\/api\/v1\/subtitles(?:\?.*)?$/, (route) => json(route, {
    tracks: [
      { id: 'external-es', label: 'Español Latino', language: 'es-419', url: `/api/v1/subtitles/file/${SUB_TOKEN_ES}.vtt`, is_default: true },
      { id: 'external-en', label: 'English SDH', language: 'en', url: `/api/v1/subtitles/file/${SUB_TOKEN_EN}.vtt` },
    ],
  }));

  await page.route('**/api/v1/playback/sessions', (route) => json(route, {
    session_id: 'visual-audit-session',
    playback_url: '/visual-audit/master.m3u8',
    resolved: true,
    generation: 'visual-audit',
    refresh_after: Date.now() + 30 * 60 * 1000,
    expires_at: Date.now() + 60 * 60 * 1000,
  }));
  await page.route('**/api/v1/playback/sessions/visual-audit-session', (route) => json(route, { ok: true }));

  await page.route('**/visual-audit/master.m3u8', (route) => route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: masterManifest }));
  await page.route(/.*\/visual-audit\/(?:video-(?:720|1080)|audio-(?:es|en))\.m3u8$/, (route) => route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: mediaManifest }));
  await page.route(/.*\/visual-audit\/segment-\d+\.ts$/, (route) => route.fulfill({ status: 200, contentType: 'video/mp2t', body: Buffer.alloc(188 * 4, 0x47) }));
  await page.route(new RegExp(`/api/v1/subtitles/file/(?:${SUB_TOKEN_ES}|${SUB_TOKEN_EN})\\.vtt`), (route) => route.fulfill({ status: 200, contentType: 'text/vtt; charset=utf-8', body: subtitleVtt }));
}

function horizontalLayout() {
  return {
    innerWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  };
}

function recordOverflow(errors, label, layout) {
  const width = Math.max(layout.documentScrollWidth, layout.bodyScrollWidth);
  if (width > layout.innerWidth + 2) errors.push(`${label} horizontal overflow: ${width}px > ${layout.innerWidth}px`);
}

async function capturePreferences(browser, name, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  await installMocks(page);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const trigger = page.getByRole('button', { name: 'Abrir preferencias' });
  await trigger.waitFor({ state: 'visible', timeout: 15_000 });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Preferencias' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(250);
  const layout = await page.evaluate(horizontalLayout);
  recordOverflow(errors, 'Preferences', layout);
  const box = await dialog.boundingBox();
  if (!box || box.x < -1 || box.x + box.width > viewport.width + 1) errors.push(`Preferences dialog escaped viewport: ${JSON.stringify(box)}`);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-preferences.png`), fullPage: false });
  await context.close();
  return { errors, layout, dialogBox: box };
}

async function openPlayerThroughCatalog(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const card = page.locator('.media-card').first();
  await card.waitFor({ state: 'visible', timeout: 15_000 });
  await card.click();

  const details = page.getByRole('dialog').last();
  await details.waitFor({ state: 'visible', timeout: 10_000 });
  const playButton = details.getByRole('button', { name: /Reproducir película|Continuar película|Reproducir/i }).first();
  await playButton.waitFor({ state: 'visible', timeout: 10_000 });
  await playButton.click();
}

async function capturePlayer(browser, name, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  await installMocks(page);
  await openPlayerThroughCatalog(page);

  const controls = page.locator('[data-player-controls]');
  await controls.waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(900);
  await page.mouse.move(Math.max(10, viewport.width / 2), Math.max(10, viewport.height - 90));
  const layout = await page.evaluate(horizontalLayout);
  recordOverflow(errors, 'Player', layout);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-player.png`), fullPage: false });

  const audioButton = page.locator('button[title="Idioma de Audio"]');
  await audioButton.waitFor({ state: 'visible', timeout: 8_000 });
  await audioButton.click();
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-player-audio.png`), fullPage: false });

  const subtitleButton = page.locator('button[title="Subtítulos"]');
  await subtitleButton.waitFor({ state: 'visible', timeout: 8_000 });
  await subtitleButton.click();
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-player-subtitles.png`), fullPage: false });

  const qualityButton = page.locator('button[title="Calidad de video"]');
  await qualityButton.waitFor({ state: 'visible', timeout: 8_000 });
  await qualityButton.click();
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-player-quality.png`), fullPage: false });

  const closeButton = page.locator('button[title^="Cerrar reproductor"]');
  if (await closeButton.count() !== 1) errors.push('Player close control is not uniquely accessible');

  await context.close();
  return { errors, layout };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const viewports = [
    ['mobile-320x700', { width: 320, height: 700 }],
    ['mobile-390x844', { width: 390, height: 844 }],
    ['tablet-768x1024', { width: 768, height: 1024 }],
    ['laptop-1024x768', { width: 1024, height: 768 }],
    ['desktop-1440x900', { width: 1440, height: 900 }],
    ['wide-1920x1080', { width: 1920, height: 1080 }],
  ];
  const allErrors = [];
  try {
    for (const [name, viewport] of viewports) {
      const preferences = await capturePreferences(browser, name, viewport);
      const player = await capturePlayer(browser, name, viewport);
      const report = { viewport, preferences, player };
      fs.writeFileSync(path.join(OUT_DIR, `${name}-report.json`), JSON.stringify(report, null, 2));
      allErrors.push(...preferences.errors.map((error) => `${name}: ${error}`), ...player.errors.map((error) => `${name}: ${error}`));
    }
  } finally {
    await browser.close();
  }

  if (allErrors.length) {
    console.error(allErrors.join('\n'));
    process.exitCode = 1;
  }
  console.log(`Immersive player visual audit written to ${OUT_DIR}`);
})();
