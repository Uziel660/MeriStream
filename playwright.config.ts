import { defineConfig, devices } from '@playwright/test';

/**
 * Config ligero para E2E de adaptadores reales.
 * - Solo Chromium para minimizar recursos
 * - workers=1 + fullyParallel=false => ejecución serial
 * - LIVE_SCRAPER_E2E=1 requerido para ejecutar tests live (evita carga en CI normal)
 *   Tests hacen test.skip() cuando la variable no está en "1", pero `npx playwright test --list`
 *   sigue listando los 3 casos (Cinecalidad, TubePelis, VerAnimes).
 * Ver e2e/adapters-real.spec.ts para supuestos y validaciones.
 */
export default defineConfig({
  testDir: './e2e',
  // Ejecución serial estricta para entornos con pocos recursos
  fullyParallel: false,
  workers: 1,
  // Fail en CI si queda test.only
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Timeout generoso por resolución de embed + validación de video
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
    // Video de <video> requiere timeout de acción mayor
    actionTimeout: 15_000,
  },
  // Solo Chromium: ligero, evita instalar Firefox/WebKit
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
