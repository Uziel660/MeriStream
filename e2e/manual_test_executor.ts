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
function logConsole(msg: string) {
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
  timing?: number;
  category?: string;
  error?: string;
}

const capturedRequests: RequestRecord[] = [];

async function run() {
  logConsole('Starting Manual Playback Test with Playwright...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-web-security', '--autoplay-policy=no-user-gesture-required']
  });

  const context = await browser.newContext({
    recordHar: {
      path: HAR_PATH,
      mode: 'full',
      content: 'attach',
    },
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  page.on('console', (msg) => {
    const text = `[BROWSER CONSOLE ${msg.type().toUpperCase()}] ${msg.text()}`;
    consoleLogs.push(`[${new Date().toISOString()}] ${text}`);
  });

  page.on('pageerror', (err) => {
    const text = `[BROWSER PAGE ERROR] ${err.message}\n${err.stack || ''}`;
    consoleLogs.push(`[${new Date().toISOString()}] ${text}`);
  });

  page.on('request', (req) => {
    const url = req.url();
    if (
      url.includes('resolve-embed') ||
      url.includes('playback/sessions') ||
      url.includes('master.m3u8') ||
      url.includes('resource') ||
      url.includes('proxy/stream') ||
      url.includes('player-event') ||
      url.includes('/api/v1/play/') ||
      url.includes('.m3u8')
    ) {
      logConsole(`[REQ] ${req.method()} ${url}`);
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    const isTarget =
      url.includes('resolve-embed') ||
      url.includes('playback/sessions') ||
      url.includes('master.m3u8') ||
      url.includes('resource') ||
      url.includes('proxy/stream') ||
      url.includes('player-event') ||
      url.includes('/api/v1/play/') ||
      url.includes('.m3u8');

    let bodyText = '';
    if (isTarget) {
      try {
        bodyText = await res.text();
      } catch (e: any) {
        bodyText = `<binary or error reading body: ${e.message}>`;
      }
      logConsole(`[RES] ${res.status()} ${reqSummary(url)} => Body length: ${bodyText.length}`);
    }

    if (isTarget || url.includes('/api/')) {
      capturedRequests.push({
        url,
        method: res.request().method(),
        status: res.status(),
        statusText: res.statusText(),
        requestHeaders: res.request().headers(),
        responseHeaders: res.headers(),
        responseBody: bodyText.length > 5000 ? bodyText.slice(0, 5000) + '...[truncated]' : bodyText,
      });
    }
  });

  function reqSummary(u: string) {
    try {
      const parsed = new URL(u);
      return parsed.pathname + (parsed.search ? parsed.search.slice(0, 80) : '');
    } catch {
      return u.slice(0, 100);
    }
  }

  // 1. Navigate to Meristream & Clear old decisions
  logConsole(`Navigating to ${BACKEND_URL}...`);
  await page.goto(BACKEND_URL, { waitUntil: 'networkidle', timeout: 30000 });

  logConsole('Clearing localStorage meristream_delivery_capabilities and reloading...');
  await page.evaluate(() => {
    localStorage.removeItem('meristream_delivery_capabilities');
  });
  await page.reload({ waitUntil: 'networkidle' });

  // Array to store results for the 3 items
  const testResults: any[] = [];

  const targets = [
    {
      name: 'The Last of Us — T1:E1',
      showSearch: 'The Last of Us',
      showId: 'mt90ysg9e0tlidk7',
      epNumber: 1,
      episodeId: 'cmt9bxox802sjiu1i2kpc9wuo',
    },
    {
      name: 'Loki — T1:E1',
      showSearch: 'Loki',
      showId: 'mt910i0hs7a7fwju',
      epNumber: 1,
      episodeId: 'cmt9bxoe902qniu1ibvdhghkn',
    },
    {
      name: 'Película: Está Detrás De Ti',
      showSearch: 'Está Detrás De Ti',
      showId: 'mtcb9l5rixg5ymbr',
      epNumber: 1,
      episodeId: 'cmtcb9l7d000g7cuo9lu45ogu',
    },
  ];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    logConsole(`\n============================================================`);
    logConsole(`[TEST ${i + 1}/3] Iniciando prueba para: ${target.name}`);
    logConsole(`============================================================`);

    const itemRequestsBefore = capturedRequests.length;

    logConsole(`Opening player for ${target.name} (showId: ${target.showId}, epId: ${target.episodeId})...`);

    const opened = await page.evaluate(async (t) => {
      const res = await fetch(`/api/v1/shows/${t.showId}`);
      if (!res.ok) throw new Error(`Could not fetch show ${t.showId}`);
      const showData = await res.json();
      return showData;
    }, target);

    logConsole(`Show fetched: "${opened.title}" (${opened.category}). Searching in catalog UI...`);

    const searchInput = page.locator('input[type="text"], input[placeholder*="Buscar"]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill(target.showSearch);
      await page.waitForTimeout(1000);
    }

    // Look for media card
    const card = page.locator(`text="${opened.title}"`).first();
    if (await card.isVisible()) {
      logConsole(`Clicking on show card "${opened.title}"...`);
      await card.click();
      await page.waitForTimeout(1500);

      // In Media Details modal, click on Episode 1 or Play button
      const playBtn = page.locator('button:has-text("Reproducir"), button:has-text("Ver ahora")').first();
      const ep1Btn = page.locator(`button:has-text("T1:E1"), button:has-text("Episodio 1"), div:has-text("T1:E1")`).first();

      if (await ep1Btn.isVisible()) {
        logConsole('Clicking on Episode 1 in modal...');
        await ep1Btn.click();
      } else if (await playBtn.isVisible()) {
        logConsole('Clicking on Play button in modal...');
        await playBtn.click();
      } else {
        logConsole('Looking for any episode button in modal...');
        const anyEp = page.locator('[role="button"]:has-text("1"), button:has-text("1")').first();
        if (await anyEp.isVisible()) {
          await anyEp.click();
        }
      }
    } else {
      logConsole(`Show card not found by text, triggering playback via window evaluation...`);
      await page.evaluate(async (t) => {
        const playRes = await fetch(`/api/v1/play/${t.episodeId}`);
        const playData = await playRes.json();
        console.log('[EVAL PLAY DATA]', playData);
      }, target);
    }

    logConsole('Waiting 20 seconds for playback and auto-selection without manual interaction...');
    
    let stateAt5s: any = null;
    let stateAt10s: any = null;
    let stateAt20s: any = null;

    await page.waitForTimeout(5000);
    stateAt5s = await capturePlayerState(page);
    logConsole(`[+5s State] Server: "${stateAt5s.selectedServer}", UI Status: "${stateAt5s.playerMessage}", Delivery: "${stateAt5s.deliveryState}", Video: ${JSON.stringify(stateAt5s.videoState)}`);

    await page.waitForTimeout(5000);
    stateAt10s = await capturePlayerState(page);
    logConsole(`[+10s State] Server: "${stateAt10s.selectedServer}", UI Status: "${stateAt10s.playerMessage}", Delivery: "${stateAt10s.deliveryState}", Video: ${JSON.stringify(stateAt10s.videoState)}`);

    await page.waitForTimeout(10000);
    stateAt20s = await capturePlayerState(page);
    logConsole(`[+20s State] Server: "${stateAt20s.selectedServer}", UI Status: "${stateAt20s.playerMessage}", Delivery: "${stateAt20s.deliveryState}", Video: ${JSON.stringify(stateAt20s.videoState)}`);

    const itemRequests = capturedRequests.slice(itemRequestsBefore);
    logConsole(`Total relevant requests captured for this item: ${itemRequests.length}`);

    testResults.push({
      target: target.name,
      showId: target.showId,
      episodeId: target.episodeId,
      stateAt5s,
      stateAt10s,
      finalStateAt20s: stateAt20s,
      relevantRequests: itemRequests,
    });

    logConsole('Closing player modal...');
    const closeBtn = page.locator('button[aria-label="Cerrar reproductor"], button:has-text("✕"), [data-testid="close-player"]').first();
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(2000);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    if (await searchInput.isVisible()) {
      await searchInput.fill('');
      await page.waitForTimeout(1000);
    }
  }

  logConsole('Saving all console logs to manual-playback-console.txt...');
  fs.writeFileSync(CONSOLE_LOG_PATH, consoleLogs.join('\n'), 'utf8');

  logConsole('Saving detailed report JSON...');
  fs.writeFileSync(DETAILED_REPORT_PATH, JSON.stringify(testResults, null, 2), 'utf8');

  logConsole('Closing browser context to finalize HAR recording...');
  await context.close();
  await browser.close();

  logConsole('Manual playback test completed successfully!');
}

async function capturePlayerState(page: any) {
  return await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    const serverButtons = Array.from(document.querySelectorAll('button, div, span')).filter(el => {
      const txt = el.textContent || '';
      return /Servidor|Server|HLS|Directo|Embed|Mega|Vimeos|GoodStream/i.test(txt);
    });

    const statusElements = Array.from(document.querySelectorAll('.animate-pulse, [role="alert"], .text-amber-400, .text-red-400, .text-zinc-400, .text-xs, .text-sm, h2, h3, p'));
    const messages = statusElements
      .map(e => e.textContent?.trim() || '')
      .filter(t => t.length > 5 && (
        /cargando|conectando|resolviendo|error|servidor|reproduciendo|fallo|espera|cambiando|intentando|embed/i.test(t)
      ));

    const activeServerEl = document.querySelector('[class*="border-amber-500"], [class*="bg-amber-500"], [class*="text-amber-400"], [aria-selected="true"]');
    const selectedServerText = activeServerEl ? activeServerEl.textContent?.trim() || 'Unknown' : 'None detected';

    const videoState = video ? {
      src: video.src || video.currentSrc || null,
      paused: video.paused,
      currentTime: video.currentTime,
      duration: video.duration,
      readyState: video.readyState,
      networkState: video.networkState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
    } : null;

    const deliveryStateText = Array.from(document.querySelectorAll('span, div, p'))
      .map(e => e.textContent?.trim() || '')
      .find(t => /directo|proxy|sesión|embed|resolviendo|failing_over/i.test(t)) || 'N/A';

    return {
      selectedServer: selectedServerText,
      playerMessage: messages.slice(0, 5).join(' | ') || 'No specific message',
      allVisibleMessages: messages,
      deliveryState: deliveryStateText,
      videoState,
      hasIframe: Boolean(document.querySelector('iframe')),
      iframeSrc: document.querySelector('iframe')?.src || null,
    };
  });
}

run().catch((err) => {
  console.error('Execution error:', err);
  logConsole(`FATAL ERROR: ${err.message}\n${err.stack || ''}`);
  fs.writeFileSync(CONSOLE_LOG_PATH, consoleLogs.join('\n'), 'utf8');
});
