import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
