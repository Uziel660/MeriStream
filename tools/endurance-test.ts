import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// Configuración de la prueba
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3010';
const SEARCH_QUERY = 'Esta detras de ti';
const TARGET_DURATION_SECONDS = 3600; // 1 hora
const MAX_STALLED_SECONDS = 120; // 2 minutos máximo tolerado sin que avance el video
const POLL_INTERVAL_MS = 10000; // Revisar cada 10 segundos

async function runEnduranceTest() {
  console.log(`[Endurance Test] Iniciando simulación en segundo plano (Headless)`);
  console.log(`[Endurance Test] Objetivo: Reproducir "${SEARCH_QUERY}" por ${TARGET_DURATION_SECONDS} segundos.`);
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  const logs: string[] = [];
  const logEvent = (type: string, msg: string) => {
    const time = new Date().toISOString().substring(11, 19);
    const line = `[${time}] [${type}] ${msg}`;
    logs.push(line);
    // Imprimir errores críticos o eventos importantes en tiempo real
    if (type === 'ERROR' || type === 'STALL' || type === 'NETWORK_ERR' || type === 'INFO') {
      console.log(line);
    }
  };

  // Interceptar consola y errores de red
  page.on('console', msg => {
    if (msg.type() === 'error') logEvent('ERROR', msg.text());
    else if (msg.type() === 'warning') logEvent('WARN', msg.text());
    else logEvent('LOG', msg.text());
  });
  page.on('pageerror', err => logEvent('PAGE_ERR', err.message));
  page.on('requestfailed', request => {
    logEvent('NETWORK_ERR', `${request.method()} ${request.url()} - ${request.failure()?.errorText}`);
  });

  try {
    logEvent('INFO', `Navegando a ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Esperar a que el catálogo cargue
    logEvent('INFO', 'Esperando que cargue el catálogo...');
    await page.waitForTimeout(3000); 

    // Buscar la película
    logEvent('INFO', `Buscando "${SEARCH_QUERY}"...`);
    const searchInput = page.locator('input[placeholder*="Buscar"]');
    if (await searchInput.count() > 0) {
      await searchInput.fill(SEARCH_QUERY);
      await page.waitForTimeout(2000);
    } else {
      logEvent('WARN', 'No se encontró el buscador de texto. Intentando localizar directamente.');
    }

    // Localizar la tarjeta (MediaCard) que coincida con el texto, ignorando el header de resultados
    const mediaCard = page.locator('a, button, div[role="button"], img[alt*="ti" i]').filter({ hasText: /est[aá]\s+detr[aá]s\s+de\s+ti/i }).first();
    // Si no encuentra por texto (o hace match raro), forzamos clic en la primera tarjeta visible
    const firstCard = page.locator('main').locator('img').first();
    
    await firstCard.waitFor({ state: 'visible', timeout: 15000 });
    logEvent('INFO', 'Película encontrada en el catálogo. Abriendo modal de detalles...');
    await firstCard.click();

    // Esperar el botón de reproducir y darle clic
    logEvent('INFO', 'Esperando botón de reproducción...');
    const playBtn = page.locator('button', { hasText: /(Reproducir|Continuar|Volver a ver)/i }).or(page.locator('button.group\\/ep')).first();
    await playBtn.waitFor({ state: 'visible', timeout: 15000 });
    await playBtn.click();
    logEvent('INFO', 'Reproducción iniciada. Esperando a que el player cargue el video...');

    // Esperar que el elemento de video exista
    const videoLocator = page.locator('video').first();
    await videoLocator.waitFor({ state: 'attached', timeout: 30000 });

    logEvent('INFO', 'Elemento <video> detectado. Entrando en bucle de monitorización (watchdog).');
    
    let lastTime = -1;
    let stalledTime = 0;
    const startTime = Date.now();
    let playedSeconds = 0;

    // Bucle de comprobación
    while (playedSeconds < TARGET_DURATION_SECONDS) {
      await page.waitForTimeout(POLL_INTERVAL_MS);
      
      const currentTime = await videoLocator.evaluate((v: HTMLVideoElement) => v.currentTime).catch(() => -1);
      
      if (currentTime === -1) {
        logEvent('ERROR', 'No se pudo obtener el tiempo del video (¿se desmontó el player?)');
        throw new Error('Video element disappeared');
      }

      if (currentTime === lastTime) {
        stalledTime += (POLL_INTERVAL_MS / 1000);
        logEvent('STALL', `Buffering/Congelado detectado. Tiempo estancado: ${stalledTime}s. Posición: ${currentTime.toFixed(2)}s`);
        
        if (stalledTime >= MAX_STALLED_SECONDS) {
          throw new Error(`CRITICAL FAIL: El video se ha congelado por ${stalledTime} segundos sin recuperación.`);
        }
      } else {
        if (stalledTime > 0) {
          logEvent('INFO', `Video recuperado tras ${stalledTime}s de buffering.`);
        }
        stalledTime = 0; // Se recuperó
      }
      
      lastTime = currentTime;
      playedSeconds = Math.floor((Date.now() - startTime) / 1000);

      // Reporte esporádico para saber que sigue vivo (cada ~5 minutos)
      if (playedSeconds > 0 && playedSeconds % 300 === 0) {
        logEvent('INFO', `Progreso: ${playedSeconds}/${TARGET_DURATION_SECONDS} segundos. Posición actual del video: ${currentTime.toFixed(2)}s`);
      }
    }

    logEvent('INFO', `¡Prueba completada con éxito! La película se reprodujo de forma continua (o tolerando buffers menores) por ${TARGET_DURATION_SECONDS} segundos.`);

  } catch (error: any) {
    logEvent('ERROR', `La prueba falló o se interrumpió prematuramente: ${error.message}`);
    const screenshotPath = path.join(process.cwd(), 'tools', 'endurance-logs', `error_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    logEvent('INFO', `Captura de pantalla guardada en: ${screenshotPath}`);
    process.exitCode = 1;
  } finally {
    logEvent('INFO', 'Cerrando navegador y generando resumen de logs...');
    await browser.close();

    const logDir = path.join(process.cwd(), 'tools', 'endurance-logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    
    const fileName = `endurance_report_${Date.now()}.txt`;
    const filePath = path.join(logDir, fileName);
    fs.writeFileSync(filePath, logs.join('\n'), 'utf8');
    
    console.log(`\n============================================`);
    console.log(`Resumen guardado en: ${filePath}`);
    console.log(`Últimas 15 líneas del log:`);
    console.log(logs.slice(-15).join('\n'));
    console.log(`============================================\n`);
  }
}

runEnduranceTest();
