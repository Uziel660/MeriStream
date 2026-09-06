import { test, expect } from '@playwright/test';

/**
 * Smoke E2E local y acotado: comprueba el flujo real de la interfaz sin tocar
 * proveedores externos ni lanzar tareas del catálogo. Usa una película que
 * aparece en la ventana inicial y verifica que el reproductor recibe la
 * respuesta multi-fuente y muestra el selector de servidores.
 */
test.describe('Playback local multi-fuente', () => {
  test('abre una obra y permite cambiar de servidor', async ({ page }) => {
    const responseTimings: number[] = [];
    page.on('response', (response) => {
      if (/\/api\/v1\/play\//.test(response.url())) {
        responseTimings.push(Date.now());
      }
    });

    await page.goto('http://127.0.0.1:3010/', { waitUntil: 'domcontentloaded' });
    const search = page.locator('input[placeholder*="Buscar"]').first();
    await expect(search).toBeVisible();

    // Duna es una entrada reciente de la ventana inicial y tiene un episodio
    // canónico; el ID se obtiene del catálogo para evitar hardcodear episodios.
    // El orden del catálogo cambia mientras los workers incorporan obras;
    // buscar Duna explícitamente evita que la prueba dependa de las primeras
    // tres filas del catálogo.
    const catalogResponse = await page.request.get('http://127.0.0.1:3010/api/v1/shows?lite=true&search=Duna&limit=10');
    expect(catalogResponse.ok()).toBeTruthy();
    const catalog = await catalogResponse.json();
    const duna = catalog.shows.find((item: any) => item.title === 'Duna');
    expect(duna?.id).toBeTruthy();

    await search.fill('Duna');
    const card = page.locator(`#card-${duna.id}`).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();

    const details = page.getByRole('dialog').last();
    await expect(details).toBeVisible();
    const playButton = details.getByRole('button', { name: /REPRODUCIR PEL[IÍ]CULA/i });
    await expect(playButton).toBeVisible({ timeout: 15_000 });

    const playStartedAt = Date.now();
    const [playResponse] = await Promise.all([
      page.waitForResponse((response) => /\/api\/v1\/play\//.test(response.url()), { timeout: 20_000 }),
      playButton.click(),
    ]);
    const playLatency = Date.now() - playStartedAt;
    expect(playResponse.status()).toBe(200);
    const playPayload = await playResponse.json();
    expect(Array.isArray(playPayload.ranked_streams)).toBeTruthy();
    expect(playPayload.ranked_streams.length).toBeGreaterThan(1);

    const player = page.locator('[role="dialog"]').last();
    await expect(player).toBeVisible();
    const switchButton = player.locator('button[title="Cambiar Servidor de Streaming"]');
    await expect(switchButton).toBeVisible({ timeout: 15_000 });
    const switchLabelBefore = await switchButton.innerText();

    await switchButton.click();
    const serverMenu = player.getByText('Servidores Disponibles', { exact: false });
    await expect(serverMenu).toBeVisible();
    const allButtonLabels = await player.locator('button').allTextContents();
    console.log(`[local-playback] server menu button labels: ${JSON.stringify(allButtonLabels)}`);
    const serverOptions = player.locator('button').filter({ hasText: /\[\d{3,4}p\]/i });
    expect(await serverOptions.count()).toBeGreaterThan(1);

    const selectable = serverOptions.nth(1);
    await selectable.click();
    await expect(switchButton).toBeVisible();
    const switchLabelAfter = await switchButton.innerText();

    expect(switchLabelBefore).toMatch(/\(\d+\/\d+\)/);
    expect(switchLabelAfter).toMatch(/\(\d+\/\d+\)/);
    expect(playLatency).toBeLessThan(20_000);
    expect(responseTimings.length).toBeGreaterThan(0);

    // Regresión de la fusión: una ficha histórica sin Episode legacy debe
    // exponer sus episodios canónicos cuando existe el espejo multiplexado.
    const fallbackResponse = await page.request.get('http://127.0.0.1:3010/api/v1/shows/mtmz2o0haaahdvbw');
    expect(fallbackResponse.ok()).toBeTruthy();
    const fallback = await fallbackResponse.json();
    expect(fallback.title).toBe('Valle salvaje');
    expect(Array.isArray(fallback.episodes)).toBeTruthy();
    expect(fallback.episodes.length).toBeGreaterThan(0);
  });
});
