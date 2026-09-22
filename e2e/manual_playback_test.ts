import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const BACKEND_URL = 'http://127.0.0.1:3010';
const LOGS_DIR = path.resolve(process.cwd(), 'logs');

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const HAR_PATH = path.join(LOGS_DIR, 'manual-playback.har');
const CONSOLE_LOG_PATH = path.join(LOGS_DIR, 'manual-playback-console.txt');
const DETAILED_REPORT_PATH = path.join(LOGS_DIR, 'manual-playback-report.json');

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
  log('INICIANDO PRUEBA MANUAL DE REPRODUCCIÓN (PLAYWRIGHT)');
  log('======================================================');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-web-security',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });

  const context = await browser.newContext({
    recordHar: {
      path: HAR_PATH,
      mode: 'full',
      content: 'attach',
    },
    viewport: { width: 1366, height: 768 },
  });

  const page = await context.newPage();

  page.on('console', (msg) => {
    const text = `[BROWSER ${msg.type().toUpperCase()}] ${msg.text()}`;
    consoleLogs.push(`[${new Date().toISOString()}] ${text}`);
    if (msg.type() === 'error' || msg.text().includes('[Player]') || msg.text().includes('[HLS]') || msg.text().includes('[Proxy]')) {
      console.log(`  > ${text}`);
    }
  });

  page.on('pageerror', (err) => {
    const text = `[PAGE ERROR] ${err.message}\n${err.stack || ''}`;
    consoleLogs.push(`[${new Date().toISOString()}] ${text}`);
    console.error(`  ! ${text}`);
  });

  page.on('response', async (res) => {
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
      log(`[HTTP ${res.status()}] ${res.request().method()} ${url} (length: ${bodyText.length})`);
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

  // Step 1: Navigate to Meristream
  log(`1. Navegando a ${BACKEND_URL}...`);
  await page.goto(BACKEND_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // Step 2: Clear old browser decisions
  log('2. Limpiando localStorage("meristream_delivery_capabilities") y recargando...');
  await page.evaluate(() => {
    localStorage.removeItem('meristream_delivery_capabilities');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const targets = [
    {
      id: 'mt90ysg9e0tlidk7',
      name: 'The Last of Us — T1:E1',
      title: 'The Last of Us',
      isMovie: false,
      epNumber: 1,
      episodeId: 'cmt9bxox802sjiu1i2kpc9wuo',
    },
    {
      id: 'mt910i0hs7a7fwju',
      name: 'Loki — T1:E1',
      title: 'Loki',
      isMovie: false,
      epNumber: 1,
      episodeId: 'cmt9bxoe902qniu1ibvdhghkn',
    },
    {
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
    log(`[CASO ${i + 1}/3] Probando: ${target.name}`);
    log('======================================================');

    const startIndex = capturedRequests.length;

    // Search for title in Header
    log(`Buscando "${target.title}" en la barra superior...`);
    const searchInput = page.locator('input[placeholder*="Buscar"]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill(target.title);
      await page.waitForTimeout(1200);
    }

    // Wait for card to appear
    log(`Esperando tarjeta (#card-${target.id})...`);
    const cardSelector = `#card-${target.id}`;
    const card = page.locator(cardSelector).first();
    try {
      await card.waitFor({ state: 'visible', timeout: 5000 });
      await card.click();
    } catch {
      log(`Tarjeta no encontrada por ID directo, buscando por texto...`);
      const cardByText = page.locator(`article:has-text("${target.title}")`).first();
      await cardByText.click();
    }

    // Wait for MediaDetailsModal to load
    log('Esperando apertura de ficha de detalles...');
    if (target.isMovie) {
      const playBtn = page.locator('button:has-text("REPRODUCIR PELÍCULA"), button:has-text("CONTINUAR PELÍCULA"), button:has-text("VOLVER A VER PELÍCULA")').first();
      await playBtn.waitFor({ state: 'visible', timeout: 10000 });
      log('Haciendo clic en REPRODUCIR PELÍCULA...');
      await playBtn.click();
    } else {
      const epBtn = page.locator('.group\\/ep').first();
      await epBtn.waitFor({ state: 'visible', timeout: 10000 });
      log('Haciendo clic en el primer episodio (T1:E1)...');
      await epBtn.click();
    }

    log('>>> REPRODUCTOR INICIADO. Observando durante 20 segundos sin tocar nada...');

    // Wait and sample at intervals
    await page.waitForTimeout(5000);
    const snap5 = await getPlayerSnapshot(page);
    log(`  [+5s] Servidor seleccionado: "${snap5.selectedServer}" | Estado delivery: "${snap5.deliveryState}" | Mensaje UI: "${snap5.playerMessage}"`);

    await page.waitForTimeout(5000);
    const snap10 = await getPlayerSnapshot(page);
    log(`  [+10s] Servidor seleccionado: "${snap10.selectedServer}" | Estado delivery: "${snap10.deliveryState}" | Mensaje UI: "${snap10.playerMessage}"`);

    await page.waitForTimeout(5000);
    const snap15 = await getPlayerSnapshot(page);
    log(`  [+15s] Servidor seleccionado: "${snap15.selectedServer}" | Estado delivery: "${snap15.deliveryState}" | Mensaje UI: "${snap15.playerMessage}"`);

    await page.waitForTimeout(5000);
    const snap20 = await getPlayerSnapshot(page);
    log(`  [+20s FINAL] Servidor seleccionado: "${snap20.selectedServer}" | Estado delivery: "${snap20.deliveryState}" | Mensaje UI: "${snap20.playerMessage}"`);
    log(`  [+20s Video State]: ${JSON.stringify(snap20.videoState)}`);
    log(`  [+20s Iframe]: ${snap20.hasIframe ? snap20.iframeSrc : 'No iframe'}`);

    const itemRequests = capturedRequests.slice(startIndex);
    log(`  [Total peticiones capturadas en este caso]: ${itemRequests.length}`);

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

  // Save artifacts
  log('\nGuardando logs resultantes...');
  fs.writeFileSync(CONSOLE_LOG_PATH, consoleLogs.join('\n'), 'utf8');
  fs.writeFileSync(DETAILED_REPORT_PATH, JSON.stringify(testResults, null, 2), 'utf8');

  log('Cerrando contexto de Playwright y guardando manual-playback.har...');
  await context.close();
  await browser.close();

  log('======================================================');
  log('PRUEBA FINALIZADA EXITOSAMENTE');
  log('======================================================');
}

async function getPlayerSnapshot(page: any) {
  return await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    const iframe = document.querySelector('iframe') as HTMLIFrameElement | null;

    // Server selector buttons in modal
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

    // Status messages / badges
    const statusOverlays = Array.from(document.querySelectorAll('.animate-pulse, .animate-spin, [role="alert"], .text-amber-400, .text-red-400, .text-xs, .text-sm'))
      .map(e => e.textContent?.trim() || '')
      .filter(t => t.length > 2 && t.length < 150 && (
        /cargando|conectando|resolviendo|error|servidor|reproduciendo|fallo|espera|cambiando|intentando|embed|directo|proxy|sesión|buffer|stalled/i.test(t)
      ));

    const deliveryState = Array.from(document.querySelectorAll('span, div, p'))
      .map(e => e.textContent?.trim() || '')
      .find(t => /directo|proxy|sesión|embed|resolviendo|failing_over/i.test(t)) || 'N/A';

    return {
      selectedServer,
      playerMessage: statusOverlays.slice(0, 3).join(' | ') || 'Sin mensaje de error visible',
      deliveryState,
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

run().catch((err) => {
  log(`ERROR FATAL: ${err.message}\n${err.stack || ''}`);
  fs.writeFileSync(CONSOLE_LOG_PATH, consoleLogs.join('\n'), 'utf8');
  process.exit(1);
});
