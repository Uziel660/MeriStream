import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const deferredOverlays = fileURLToPath(
  new URL("./src/components/lazy/DeferredOverlays.tsx", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
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
    allowedHosts: [".trycloudflare.com"],
    // Reference repositories and probe artifacts live under work/ during
    // development; they must not trigger an application reload or be scanned
    // as part of the frontend module graph.
    watch: {
      ignored: ["**/work/**"],
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
