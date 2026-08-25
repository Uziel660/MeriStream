// app.config.ts
// ══════════════════════════════════════════════════════════════════
// ÚNICA fuente de verdad de la configuración de red de VoidStream.
//
// Cambia el host/puerto AQUÍ y se propaga automáticamente a:
//   - Backend:  server.ts (listen + CORS)          → import { APP_CONFIG }
//   - Frontend: src/utils/proxiedUrl.ts            → import { backendOrigin }
//   - Frontend: src/utils/streamOptimizer.ts       → import { backendOrigin }
//
// Tras modificarlo, reinicia el backend: npx tsx server.ts
// ══════════════════════════════════════════════════════════════════

export const APP_CONFIG = {
  /** Host local donde escucha el backend y se sirve la SPA en desarrollo. */
  host: "127.0.0.1",
  /** Puerto del backend. Ningún otro valor de puerto existe en el código. */
  port: 3000,
} as const;

/** Origen absoluto del backend, para construir URLs desde el cliente. */
export function backendOrigin(): string {
  return `http://${APP_CONFIG.host}:${APP_CONFIG.port}`;
}

/**
 * Orígenes locales permitidos por CORS cuando ALLOWED_ORIGINS no está definido:
 * variantes localhost/127.0.0.1 con el puerto configurado + Vite standalone (5173)
 * + túnel Cloudflare expuesto para acceso externo.
 */
export function localAllowedOrigins(): string[] {
  return [
    `http://localhost:${APP_CONFIG.port}`,
    `http://${APP_CONFIG.host}:${APP_CONFIG.port}`,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://classifieds-discounts-father-barrier.trycloudflare.com",
    "https://bookstore-britain-lows-locked.trycloudflare.com",
    "https://fabrics-merit-shut-tone.trycloudflare.com",
    "https://prehensile-hyperactively-zara.ngrok-free.dev",
    "http://prehensile-hyperactively-zara.ngrok-free.dev",
  ];
}
