const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

const TEST_TITLES = [
  { provider: 'JKanime', query: 'Mach GoGoGo' },
  { provider: 'AnimeFLV', query: 'Youkoso Jitsuryoku Shijou Shugi' },
  { provider: 'LatAnime', query: 'Aggressive Retsuko' },
  { provider: 'TioAnime', query: 'Warau Salesman New' },
  { provider: 'Cinecalidad', query: 'Gracias por tu servicio' },
  { provider: 'Gnula', query: 'The O.C' }
];

async function runBrowserTests() {
  console.log('Iniciando Chromium para validación en navegador real...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required']
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const report = [];

  for (const item of TEST_TITLES) {
    console.log(`\n========================================================`);
    console.log(`PROBANDO EN BROWSER: [${item.provider}] "${item.query}"`);
    console.log(`========================================================`);

    try {
      await page.goto('http://127.0.0.1:3010', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);

      // Search for the title
      const searchInput = page.locator('input[type="search"], input[placeholder*="Busca"], input[aria-label*="Buscar"]').first();
      await searchInput.waitFor({ state: 'visible', timeout: 5000 });
      await searchInput.fill(item.query);
      await page.waitForTimeout(1500);

      // Look for media-card
      const card = page.locator('button.media-card').first();
      await card.waitFor({ state: 'visible', timeout: 6000 });
      await card.click();

      await page.waitForTimeout(1500);

      // Check if details modal opened
      console.log('  Modal de detalles abierto. Buscando botón reproducir...');
      const playBtn = page.locator('button:has-text("Reproducir"), button:has-text("Ver Ahora"), button:has-text("Episodio 1"), button:has-text("Ep. 1")').first();
      if (await playBtn.isVisible().catch(() => false)) {
        await playBtn.click();
      } else {
        const epBtn = page.locator('[data-episode-id], button:has-text("1")').first();
        if (await epBtn.isVisible().catch(() => false)) {
          await epBtn.click();
        } else {
          console.log('  ❌ No se encontró botón de reproducir ni episodio');
          report.push({ ...item, status: 'NO_PLAY_BTN' });
          continue;
        }
      }

      // Wait for player modal
      console.log('  Esperando reproductor...');
      await page.waitForTimeout(5000);

      // Check video element or iframe state
      const playerState = await page.evaluate(() => {
        const video = document.querySelector('video');
        const iframe = document.querySelector('iframe');
        if (video) {
          return {
            mode: 'video',
            found: true,
            paused: video.paused,
            currentTime: video.currentTime,
            duration: video.duration,
            readyState: video.readyState,
            src: video.currentSrc || video.src
          };
        }
        if (iframe) {
          return {
            mode: 'iframe',
            found: true,
            src: iframe.src
          };
        }
        return { found: false };
      });

      console.log(`  Estado de Player: Mode=${playerState.mode || 'none'} Found=${playerState.found} ReadyState=${playerState.readyState} Paused=${playerState.paused} Src=${playerState.src?.slice(0, 50)}`);

      // Check for server selector button
      const serverBtn = page.locator('button:has-text("Servidores"), button:has-text("Servidor"), button[aria-label*="Servidor"], button[title*="Servidor"]').first();
      let serverCount = 0;
      let serverNames = [];

      if (await serverBtn.isVisible().catch(() => false)) {
        await serverBtn.click();
        await page.waitForTimeout(800);

        serverNames = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('[role="menuitem"], button')).filter(el => {
            const text = el.textContent || '';
            return text.includes('StreamWish') || text.includes('VidHide') || text.includes('YourUpload') || 
                   text.includes('Okru') || text.includes('Mega') || text.includes('Servidor') || 
                   text.includes('JKanime') || text.includes('AnimeFLV') || text.includes('LatAnime') || 
                   text.includes('TioAnime') || text.includes('Cinecalidad') || text.includes('Gnula') || 
                   text.includes('Direct') || text.includes('HLS') || text.includes('Embed');
          });
          return items.map(el => el.textContent.trim().replace(/\s+/g, ' ')).slice(0, 8);
        });

        serverCount = serverNames.length;
        console.log(`  Servidores en selector (${serverCount}):`, serverNames.join(' | '));
      }

      // Take screenshot of player with server list open
      const screenshotName = `browser_play_${item.provider.toLowerCase()}.png`;
      const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotName);
      await page.screenshot({ path: screenshotPath });
      console.log(`  📸 Screenshot guardado en: ${screenshotName}`);

      const isPlaying = (playerState.found && playerState.mode === 'video' && playerState.readyState >= 1) || playerState.mode === 'iframe';
      report.push({
        provider: item.provider,
        title: item.query,
        mode: playerState.mode,
        playerFound: playerState.found,
        readyState: playerState.readyState,
        isPlaying,
        serverCount,
        screenshot: screenshotName
      });

      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

    } catch (e) {
      console.log(`  ❌ Error durante la prueba: ${e.message}`);
      report.push({ ...item, error: e.message });
    }
  }

  console.log('\n========================================================');
  console.log('RESUMEN DE PRUEBAS DE BROWSER REAL PLAYWRIGHT');
  console.log('========================================================');
  console.log(JSON.stringify(report, null, 2));

  await browser.close();
}

runBrowserTests().catch(console.error);
