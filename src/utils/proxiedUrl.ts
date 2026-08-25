// src/utils/proxiedUrl.ts
// Origen del backend y constructores de URLs proxificadas compartidos por el
// reproductor, las imágenes y los health-probes. El endpoint
// /api/v1/proxy/stream aplica los perfiles de host del servidor
// (server/hostProfiles.ts) con el Referer correcto, evitando CORS del navegador.
//
// El origen SIEMPRE viene de app.config.ts (fuente única; sin hardcodes).

import { backendOrigin } from "../../app.config";

export { backendOrigin };

function isLocalUrl(url: string): boolean {
  return (
    url.startsWith('/') ||
    url.includes('localhost') ||
    url.includes('127.0.0.1')
  );
}

/**
 * Envuelve una URL externa en el proxy anti-CORS del backend.
 * Las URLs locales (/..., localhost, 127.0.0.1) se devuelven tal cual.
 *
 * RUTA RELATIVA a propósito: el backend sirve la SPA en su mismo origen,
 * así que `/api/...` funciona igual en local (127.0.0.1:3000) que a través
 * del túnel de Cloudflare — con URLs absolutas, un dispositivo remoto
 * resolvería 127.0.0.1 contra sí mismo y los streams morirían.
 */
export function proxiedStreamUrl(url: string, title?: string, provider?: string): string {
  if (!url || isLocalUrl(url)) return url;
  const titleParam = title ? `&title=${encodeURIComponent(title)}` : '';
  const provParam = provider ? `&provider=${encodeURIComponent(provider)}` : '';
  return `/api/v1/proxy/stream?url=${encodeURIComponent(url)}${titleParam}${provParam}`;
}

/** Alias semántico para imágenes (mismo endpoint de proxy). */
export function proxiedImageUrl(url: string): string {
  return proxiedStreamUrl(url);
}

