import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3011,
    allowedHosts: [".trycloudflare.com"],
  },
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
