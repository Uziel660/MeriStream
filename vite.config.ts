import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const deferredOverlays = fileURLToPath(
  new URL("./src/components/lazy/DeferredOverlays.tsx", import.meta.url),
);

const isAndroidBundle = process.env.MERISTREAM_ANDROID === "1";

export default defineConfig({
  plugins: [react()],
  build: {
    // Keep the normal website on Vite's modern default. Only the APK bundle is
    // transpiled further so Android 10 devices with an old System WebView can
    // parse the same React application.
    target: isAndroidBundle ? ['chrome64', 'es2018'] : 'modules',
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
