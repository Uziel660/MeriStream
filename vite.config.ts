import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const deferredOverlays = fileURLToPath(
  new URL("./src/components/lazy/DeferredOverlays.tsx", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  build: {
    // Android 10's stock WebView can be substantially older than desktop
    // Chromium. Keep the shared frontend modern, but emit syntax that API 29
    // WebViews can parse instead of failing before React mounts.
    target: ['chrome80', 'es2019'],
  },
  resolve: {
    alias: [
      { find: /^\.\/components\/HLSPlayerModal$/, replacement: deferredOverlays },
      { find: /^\.\/components\/MediaDetailsModal$/, replacement: deferredOverlays },
      { find: /^\.\/components\/AdminPanel$/, replacement: deferredOverlays },
      { find: /^\.\/components\/AuthModal$/, replacement: deferredOverlays },
      { find: /^\.\/components\/ContinueWatching$/, replacement: deferredOverlays },
    ],
  },
  server: {
    port: 3011,
    // El túnel público usa este hostname durante las comprobaciones y en
    // desarrollo. Mantenerlo explícito evita el bloqueo de Vite por Host.
    allowedHosts: [".trycloudflare.com", "stream.merith.me"],
    // Reference repositories and probe artifacts live under work/ during
    // development; they must not trigger an application reload or be scanned
    // as part of the frontend module graph.
    watch: {
      ignored: ["**/work/**"],
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
    // Several provider tests intentionally exercise live public endpoints.
    // Keep the default wide enough for normal network latency while each
    // test still owns its stricter timeout when it needs one.
    testTimeout: 30_000,
  },
});
