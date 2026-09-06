const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

async function testTitle(page, title, providerName) {
  console.log(`\n======================================================`);
  console.log(`[TEST] Probando: "${title}" (${providerName})`);
  console.log(`======================================================`);

  const networkErrors = [];
  const consoleMessages = [];

  const onConsole = msg => {
    const text = msg.text();
    if (msg.type() === 'error' || text.includes('HLS') || text.includes('Error') || text.includes('error')) {
      consoleMessages.push(`[${msg.type()}] ${text.slice(0, 140)}`);
    }
  };
  const onRequestFailed = req => {
    networkErrors.push(`${req.method()} ${req.url().slice(0, 100)} - ${req.failure()?.errorText}`);
  };

  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);

  try {
    await page.goto('http://127.0.0.1:3010', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);

    const searchInput = page.locator('input[type="search"]').first();
    await searchInput.fill(title);
    await page.waitForTimeout(1500);

    const card = page.locator('button.media-card').first();
    await card.waitFor({ state: 'visible', timeout: 6000 });
    await card.click();
    await page.waitForTimeout(1500);

    const playBtn = page.locator('button:has-text("Reproducir"), button:has-text("Ver Ahora"), button:has-text("Episodio 1"), button:has-text("Ep. 1")').first();
    await playBtn.waitFor({ state: 'visible', timeout: 6000 });
    await playBtn.click();

    console.log('  Reproductor abierto. Esperando 6s para avance de reproducción...');
    await page.waitForTimeout(6000);

    // Evaluate video playback metrics
    const metrics = await page.evaluate(async () => {
      const video = document.querySelector('video');
      const iframe = document.querySelector('iframe');
      if (video) {
        const initialTime = video.currentTime;
        // Wait 2.5 seconds to measure actual progress
        await new Promise(r => setTimeout(r, 2500));
        const finalTime = video.currentTime;
        const advanced = finalTime > initialTime || finalTime > 1.0;
        return {
          type: 'video',
          initialTime,
          finalTime,
          advanced,
          duration: video.duration,
          paused: video.paused,
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          src: video.currentSrc || video.src
        };
      }
      if (iframe) {
        return {
          type: 'iframe',
          src: iframe.src
        };
      }
      return { type: 'none' };
    });

    console.log('  Métricas de Reproducción:', JSON.stringify(metrics, null, 2));

    if (consoleMessages.length > 0) {
      console.log('  Mensajes de consola relevantes:');
      consoleMessages.slice(0, 5).forEach(m => console.log('   ', m));
    }
    if (networkErrors.length > 0) {
      console.log('  Peticiones de red fallidas:');
      networkErrors.slice(0, 5).forEach(e => console.log('   ', e));
    }

    const screenshotPath = path.join(SCREENSHOTS_DIR, `diag_${providerName.toLowerCase()}.png`);
    await page.screenshot({ path: screenshotPath });
    console.log(`  📸 Captura guardada en: diag_${providerName.toLowerCase()}.png`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    return { title, providerName, metrics, screenshot: `diag_${providerName.toLowerCase()}.png` };

  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
    return { title, providerName, error: err.message };
  } finally {
    page.off('console', onConsole);
    page.off('requestfailed', onRequestFailed);
  }
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  const results = [];
  results.push(await testTitle(page, 'Gracias por tu servicio', 'Cinecalidad'));
  results.push(await testTitle(page, 'Mach GoGoGo', 'JKanime'));
  results.push(await testTitle(page, 'Youkoso Jitsuryoku', 'AnimeFLV'));
  results.push(await testTitle(page, 'Himesama "Goumon" no Jikan desu', 'TioAnime'));

  console.log('\n======================================================');
  console.log('RESUMEN DE DIAGNÓSTICO DE REPRODUCCIÓN REAL');
  console.log('======================================================');
  console.log(JSON.stringify(results, null, 2));

  await browser.close();
}

run().catch(console.error);
