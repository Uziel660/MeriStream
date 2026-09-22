import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const BACKEND_URL = 'http://127.0.0.1:3010';
const LOGS_DIR = path.resolve(process.cwd(), 'logs');
const SHOTS_DIR = path.join(LOGS_DIR, 'screenshots');

if (!fs.existsSync(SHOTS_DIR)) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
}

const HAR_PATH = path.join(LOGS_DIR, 'manual-playback.har');
const CONSOLE_LOG_PATH = path.join(LOGS_DIR, 'manual-playback-console.txt');
const DETAILED_REPORT_PATH = path.join(LOGS_DIR, 'visual-playback-report.json');

const consoleLogs: string[] = [];
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  consoleLogs.push(line);
  console.log(line);
}

interface RequestRecord {
  url: string;
  method: string;
  status: number | null;
  statusText: string | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  timestamp: string;
}

const capturedRequests: RequestRecord[] = [];

async function run() {
  log('======================================================');
  log('INICIANDO PRUEBA VISUAL DE REPRODUCCIÓN EN VIVO (HEADED / CHROMIUM)');
  log('======================================================');

  // Launch headed Chromium on Windows desktop
  let browser: any;
  try {
    browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-web-security',
        '--autoplay-policy=no-user-gesture-required',
        '--start-maximized',
      ],
    });
    log('Navegador Chromium lanzado en MODO VISUAL (HEADED).');
  } catch (err: any) {
    log(`Aviso: No se pudo lanzar en modo headed (${err.message}), usando headless.`);
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-web-security',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  }

  const context = await browser.newContext({
    recordHar: {
      path: HAR_PATH,
      mode: 'full',
      content: 'attach',
    },
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  page.on('console', (msg: any) => {
    const text = `[BROWSER ${msg.type().toUpperCase()}] ${msg.text()}`;
    consoleLogs.push(`[${new Date().toISOString()}] ${text}`);
    if (msg.type() === 'error' || msg.text().includes('[Player]') || msg.text().includes('[HLS]') || msg.text().includes('[Proxy]')) {
      console.log(`  > ${text}`);
    }
  });

  page.on('pageerror', (err: any) => {
    const text = `[PAGE ERROR] ${err.message}\n${err.stack || ''}`;
    consoleLogs.push(`[${new Date().toISOString()}] ${text}`);
    console.error(`  ! ${text}`);
  });

  page.on('response', async (res: any) => {
    const url = res.url();
    const isPlaybackRelevant =
      url.includes('resolve-embed') ||
      url.includes('playback/sessions') ||
      url.includes('master.m3u8') ||
      url.includes('resource') ||
      url.includes('proxy/stream') ||
      url.includes('player-event') ||
      url.includes('/api/v1/play/') ||
      url.includes('.m3u8') ||
      url.includes('.mp4') ||
      url.includes('.ts');

    let bodyText = '';
    if (isPlaybackRelevant) {
      try {
        bodyText = await res.text();
      } catch (e: any) {
        bodyText = `<binary or unreadable: ${e.message}>`;
      }
      log(`[HTTP ${res.status()}] ${res.request().method()} ${url.slice(0, 110)} (length: ${bodyText.length})`);
    }

    if (isPlaybackRelevant || url.includes('/api/v1/')) {
      capturedRequests.push({
        url,
        method: res.request().method(),
        status: res.status(),
        statusText: res.statusText(),
        requestHeaders: res.request().headers(),
        responseHeaders: res.headers(),
        responseBody: bodyText.length > 8000 ? bodyText.slice(0, 8000) + '...[truncated]' : bodyText,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // 1. Navigate to Meristream
  log(`1. Navegando a ${BACKEND_URL}...`);
  await page.goto(BACKEND_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SHOTS_DIR, '01_home_loaded.png'), fullPage: false });

  // 2. Clear old capabilities & reload
  log('2. Limpiando localStorage("meristream_delivery_capabilities") y recargando...');
  await page.evaluate(() => {
    localStorage.removeItem('meristream_delivery_capabilities');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SHOTS_DIR, '02_cleaned_reloaded.png'), fullPage: false });

  const targets = [
    {
      prefix: 'tlou',
      id: 'mt90ysg9e0tlidk7',
      name: 'The Last of Us — T1:E1',
      title: 'The Last of Us',
      isMovie: false,
      epNumber: 1,
      episodeId: 'cmt9bxox802sjiu1i2kpc9wuo',
    },
    {
      prefix: 'loki',
      id: 'mt910i0hs7a7fwju',
      name: 'Loki — T1:E1',
      title: 'Loki',
      isMovie: false,
      epNumber: 1,
      episodeId: 'cmt9bxoe902qniu1ibvdhghkn',
    },
    {
      prefix: 'movie',
      id: 'mtcb9l5rixg5ymbr',
      name: 'Está Detrás De Ti (Película)',
      title: 'Está Detrás De Ti',
      isMovie: true,
      epNumber: 1,
      episodeId: 'cmtcb9l7d000g7cuo9lu45ogu',
    },
  ];

  const testResults: any[] = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    log('\n======================================================');
    log(`[CASO ${i + 1}/3] PROBANDO EN VIVO: ${target.name}`);
    log('======================================================');

    const startIndex = capturedRequests.length;

    // Search in header
    log(`Buscando "${target.title}" en la barra superior...`);
    const searchInput = page.locator('input[placeholder*="Buscar"]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill(target.title);
      await page.waitForTimeout(1500);
    }
    await page.screenshot({ path: path.join(SHOTS_DIR, `${target.prefix}_01_search.png`) });

    // Open card
    log(`Haciendo clic en la tarjeta (#card-${target.id})...`);
    const card = page.locator(`#card-${target.id}`).first();
    try {
      await card.waitFor({ state: 'visible', timeout: 5000 });
      await card.click();
    } catch {
      log(`Card no encontrada por ID, buscando por selector alternativo...`);
      const cardByText = page.locator(`article:has-text("${target.title}")`).first();
      await cardByText.click();
    }

    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SHOTS_DIR, `${target.prefix}_02_details_modal.png`) });

    // Click play
    if (target.isMovie) {
      log('Haciendo clic en REPRODUCIR PELÍCULA...');
      const playBtn = page.locator('button:has-text("REPRODUCIR PELÍCULA"), button:has-text("CONTINUAR PELÍCULA"), button:has-text("VOLVER A VER PELÍCULA")').first();
      await playBtn.waitFor({ state: 'visible', timeout: 10000 });
      await playBtn.click();
    } else {
      log('Haciendo clic en el primer episodio (T1:E1)...');
      const epBtn = page.locator('.group\\/ep').first();
      await epBtn.waitFor({ state: 'visible', timeout: 10000 });
      await epBtn.click();
    }

    log('>>> REPRODUCTOR INICIADO. Observando durante 20 segundos sin tocar nada...');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SHOTS_DIR, `${target.prefix}_03_player_opened.png`) });

    // 5s
    await page.waitForTimeout(4000);
    const snap5 = await getPlayerVisualSnapshot(page);
    await page.screenshot({ path: path.join(SHOTS_DIR, `${target.prefix}_04_playback_5s.png`) });
    log(`  [+5s] Servidor: "${snap5.selectedServer}" | Msg: "${snap5.playerMessage}" | Video: ${JSON.stringify(snap5.videoState)} | Iframe: ${snap5.hasIframe ? snap5.iframeSrc : 'No'}`);

    // 10s
    await page.waitForTimeout(5000);
    const snap10 = await getPlayerVisualSnapshot(page);
    await page.screenshot({ path: path.join(SHOTS_DIR, `${target.prefix}_05_playback_10s.png`) });
    log(`  [+10s] Servidor: "${snap10.selectedServer}" | Msg: "${snap10.playerMessage}" | Video: ${JSON.stringify(snap10.videoState)} | Iframe: ${snap10.hasIframe ? snap10.iframeSrc : 'No'}`);

    // 15s
    await page.waitForTimeout(5000);
    const snap15 = await getPlayerVisualSnapshot(page);
    await page.screenshot({ path: path.join(SHOTS_DIR, `${target.prefix}_06_playback_15s.png`) });
    log(`  [+15s] Servidor: "${snap15.selectedServer}" | Msg: "${snap15.playerMessage}" | Video: ${JSON.stringify(snap15.videoState)} | Iframe: ${snap15.hasIframe ? snap15.iframeSrc : 'No'}`);

    // 20s
    await page.waitForTimeout(5000);
    const snap20 = await getPlayerVisualSnapshot(page);
    await page.screenshot({ path: path.join(SHOTS_DIR, `${target.prefix}_07_playback_20s_final.png`) });
    log(`  [+20s FINAL] Servidor: "${snap20.selectedServer}" | Msg: "${snap20.playerMessage}"`);
    log(`  [+20s Video State]: ${JSON.stringify(snap20.videoState)}`);
    log(`  [+20s Iframe]: ${snap20.hasIframe ? snap20.iframeSrc : 'No iframe'}`);

    const itemRequests = capturedRequests.slice(startIndex);
    log(`  [Peticiones capturadas]: ${itemRequests.length}`);

    testResults.push({
      target: target.name,
      showId: target.id,
      episodeId: target.episodeId,
      snap5,
      snap10,
      snap15,
      finalSnapshot20s: snap20,
      requests: itemRequests,
    });

    // Close Player Modal
    log('Cerrando reproductor...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    // Clear search
    if (await searchInput.isVisible()) {
      await searchInput.fill('');
      await page.waitForTimeout(1000);
    }
  }

  // Save outputs
  log('\nGuardando logs resultantes...');
  fs.writeFileSync(CONSOLE_LOG_PATH, consoleLogs.join('\n'), 'utf8');
  fs.writeFileSync(DETAILED_REPORT_PATH, JSON.stringify(testResults, null, 2), 'utf8');

  log('Cerrando contexto de Playwright y guardando manual-playback.har...');
  await context.close();
  await browser.close();

  log('======================================================');
  log('PRUEBA VISUAL FINALIZADA CON ÉXITO');
  log('======================================================');
}

async function getPlayerVisualSnapshot(page: any) {
  return await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    const iframe = document.querySelector('iframe') as HTMLIFrameElement | null;

    const serverButtons = Array.from(document.querySelectorAll('button')).filter(b => {
      const txt = b.textContent || '';
      return /Servidor|Server|Directo|Embed|HLS|Mega|Vimeos|GoodStream|Streamlare/i.test(txt);
    });

    const activeServerBtn = serverButtons.find(b => 
      b.className.includes('amber') || 
      b.className.includes('border-amber') || 
      b.className.includes('bg-amber') ||
      b.getAttribute('aria-selected') === 'true'
    ) || serverButtons[0];

    const selectedServer = activeServerBtn ? activeServerBtn.textContent?.trim().replace(/\s+/g, ' ') || 'None' : 'None detected';

    const statusOverlays = Array.from(document.querySelectorAll('.animate-pulse, .animate-spin, [role="alert"], .text-amber-400, .text-red-400, .text-xs, .text-sm, p, h2, h3'))
      .map(e => e.textContent?.trim() || '')
      .filter(t => t.length > 2 && t.length < 150 && (
        /cargando|conectando|resolviendo|error|servidor|reproduciendo|fallo|espera|cambiando|intentando|embed|directo|proxy|sesión|buffer|stalled/i.test(t)
      ));

    return {
      selectedServer,
      playerMessage: statusOverlays.slice(0, 3).join(' | ') || 'Sin mensaje de error visible',
      hasVideo: Boolean(video),
      videoState: video ? {
        src: video.src || video.currentSrc || null,
        paused: video.paused,
        currentTime: video.currentTime,
        duration: video.duration,
        readyState: video.readyState,
        networkState: video.networkState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        error: video.error ? { code: video.error.code, message: video.error.message } : null,
      } : null,
      hasIframe: Boolean(iframe),
      iframeSrc: iframe ? iframe.src : null,
      allStatusMessages: statusOverlays.slice(0, 5),
    };
  });
}

run().catch((err: any) => {
  log(`ERROR FATAL: ${err.message}\n${err.stack || ''}`);
  fs.writeFileSync(CONSOLE_LOG_PATH, consoleLogs.join('\n'), 'utf8');
  process.exit(1);
});
