# Diagnóstico y Avance de la Arquitectura de Resolución y Entrega de Streams

**Fecha:** 2026-08-31  
**Entorno:** Meristream (Backend Node.js / Express / Prisma + Frontend React / Vite / HLS.js)  
**Hardware Objetivo:** ASUS T100TA (Intel Atom Z3740, 2 GB RAM, almacenamiento limitado, sin Chromium/Playwright en producción)

---

## 1. Recorrido de Reproducción de Extremo a Extremo

Se auditó el flujo completo que atraviesa una petición desde que el usuario elige un contenido hasta que el reproductor reproduce el flujo de video:

```text
Catálogo/Episodio (DB / MediaItem / Episode)
  │
  ▼
GET /api/v1/play/:episode_id
  ├─ 1. Recupera fuentes canónicas (MediaEpisode + SourceLink o legacy Episode.source_url)
  ├─ 2. Construye cascada clasificada: 'page' | 'embed' | 'stable_direct' | 'ephemeral_direct'
  └─ 3. Devuelve { stream_url, all_available_streams, ranked_streams } (DB-only, 0 scrapers bloqueantes)
  │
  ▼
Selección del Frontend (HLSPlayerModal & playerDelivery)
  ├─ 1. Aplica ranked_streams con tiers backend preservando canonical_locator y metadata
  ├─ 2. Sonda de salud ligera no bloqueante (máximo 4 candidatos, no retrasa TTFB)
  └─ 3. Si el candidato es embed o requiere re-resolución Just-In-Time:
  │
  ▼
POST /api/v1/resolve-embed
  ├─ 1. Consulta ResolutionCoordinator (single-flight por localizador + lease cache LRU ≤ 128)
  ├─ 2. Ejecuta ProviderResolver correspondiente según capacidades (sin Playwright en prod)
  └─ 3. Devuelve contrato PlaybackResolution completo (url, original_url, canonical_locator, delivery_mode, is_proxyable, is_refreshable, requiredHeaders, etc.)
  │
  ▼
Decisión Determinista de Entrega (DeliveryPlanner)
  ├─ direct_ok / direct_trial → Intento directo en <video>/HLS.js
  ├─ Fallo directo + is_proxyable !== false → Escalación a proxy
  ├─ proxy_required → Directo a sesión proxy
  ├─ embed_only / no resoluble → iframe controlado (sin failover ciego por timeout)
  └─ expired_without_locator → Rechazo honesto inmediato (evita bucle de reintentos)
  │
  ▼
POST /api/v1/playback/sessions
  ├─ 1. Valida URL segura (SSRF guard, IPs privadas bloqueadas, protocolos HTTP/HTTPS)
  ├─ 2. Almacena sesión en memoria (máx 64 sesiones activas, bounded LRU, 0 full body en RAM)
  └─ 3. Devuelve { session_id, playback_url: '/api/v1/playback/:sessionId/master.m3u8' }
  │
  ▼
GET /api/v1/playback/:sessionId/master.m3u8
  ├─ 1. Fetch upstream con inyección de cabeceras por perfil (User-Agent, Referer, Origin, Range)
  ├─ 2. Sigue redirecciones controladas (máx 5 saltos) con validación de seguridad
  ├─ 3. Reescribe manifest HLS: sub-playlists, EXT-X-KEY, EXT-X-MAP, audio y subtítulos
  └─ 4. Genera rutas opacas `/api/v1/playback/:sessionId/resource/:resourceId`
  │
  ▼
Playlists Hijas, Claves (#EXT-X-KEY / #EXT-X-MAP) y Segmentos
  ├─ 1. Rebase inteligente de URLs absolutas y relativas sobre nueva generación si renueva
  ├─ 2. Auto-renovación upstream ante 401/403 mediante localizador canónico
  └─ 3. Streaming mediante pipelines Node.js sin acumulación en RAM
  │
  ▼
Confirmación Real de Reproducción (playback_confirmed)
  └─ Cancelación de watchdogs, registro de telemetría estructurada sin tokens.
```

---

## 2. Matriz de Diagnóstico con Muestras Representativas

| # | Caso / Tipo de Muestra | Fuente Canónica Almacenada | URL Temporal Resuelta | Source Kind | Proveedor / Host | HTTP Status | Redirecciones | Expiración Detectada | Headers Requeridos | Respuesta `/play` | Respuesta `/resolve-embed` | Sesión Proxy | Primera Falla Detectada (Previa) | Causa Raíz Confirmada |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **1** | **MP4 Estable** | `https://cdn.example.com/video/sample.mp4` | Idem | `stable_direct` | Direct CDN (`cdn.example.com`) | 200 / 206 | 0 | Ninguna | Ninguno | `direct_trial` | `resolved: true, delivery: direct` | Opcional (Direct OK) | Ninguna (Directo funciona) | Fuente limpia sin expiración ni bloqueo CORS. |
| **2** | **HLS Estable** | `https://vod.example.org/hls/master.m3u8` | Idem | `stable_direct` | HLS Master (`vod.example.org`) | 200 | 0 | Ninguna | Ninguno | `direct_trial` | `resolved: true, delivery: direct` | Opcional | Ninguna | Manifiesto estándar accesible para HLS.js. |
| **3** | **HLS Firmado Vigente** | `https://origin-embed.com/e/abc123` | `https://edge.cdn.com/hls/master.m3u8?st=xyz&e=1788161124` | `ephemeral_direct` (derivado) | Zilla / Fast CDN | 200 | 0 | `e=1788161124` (~24h) | `Referer`, `User-Agent` | `ranked_streams` con metadata | `resolved: true, is_proxyable: true, is_refreshable: false` | Creada exitosamente | Falla si frontend intentaba re-resolver URL firmada | URL firmada no es renovable por sí misma, pero sí es proxyable durante su vigencia. |
| **4** | **HLS Firmado Vencido** | `https://edge.cdn.com/hls/master.m3u8?st=old&e=1600000000` | `""` | `ephemeral_direct` | Edge CDN Legacy | 403 / 410 | 0 | Vencido (`e < now`) | N/A | `failure_reason: expired_without_locator` | `resolved: false, failure_reason: expired_without_locator` | Rechazada (422) | 403 en loop infinito | La URL efímera fue guardada como identidad en importaciones antiguas. Al no tener localizador original, debe rechazarse limpiamente sin intentar proxy. |
| **5** | **Embed → HLS Firmado** | `https://vimeos.net/embed-84838.html` | `https://s03.vimeos.net/hls2/01/0001/master.m3u8?t=token123` | `embed` | Vimeos (`vimeos.net`) | 200 | 1 | `t=token123` | `User-Agent: Chrome`, `Accept-Encoding` | `delivery_mode: embed` (DB-only) | `resolved: true, is_proxyable: true, is_refreshable: true` | Creada exitosamente | 403 si faltaba User-Agent de Chrome | CDN rechaza peticiones directas del navegador por cabeceras y CORS; el proxy inyecta headers del perfil. |
| **6** | **Stream con Headers Específicos** | `https://goodstream.one/embed-992.html` | `https://enc01.goodstream.one/hls2/master.m3u8?t=gs_tok` | `embed` | Goodstream (`goodstream.one`) | 200 | 0 | `t=...` | `Referer: https://goodstream.one/`, `User-Agent` | `embed` | `resolved: true, is_proxyable: true, delivery_mode: proxy_required` | Creada exitosamente | Cloudflare 403 sin Referer | Cloudflare exige `Referer` idéntico al dominio origen. |
| **7** | **Embed solo Iframe** | `https://mega.nz/embed/P2pBRDpa#key` | `https://mega.nz/embed/P2pBRDpa#key` | `embed` | Mega (`mega.nz`) | 200 | 0 | Ninguna | N/A | `embed` | `resolved: false, type: embed` | No requerida (Iframe directo) | Failover precipitado por timeout | Servidores iframe sin stream extraíble deben mantenerse en iframe sin activar failovers automáticos destructivos. |
| **8** | **No Resoluble / DRM / Captcha** | `https://hqq.ac/e/captcha_protected` | `""` | `embed` | Netu / HQQ (`hqq.ac`) | 200 (HTML) | 0 | N/A | N/A | `embed` | `resolved: false, failure_reason: drm_or_captcha` | Rechazada | Reproductor intentaba reproducir video placeholder demo | Contenido bloqueado por captcha interactivo (`need_captcha=1`) servía demo "TenchiMuyo". Ahora se detecta y rechaza con `drm_or_captcha`. |

---

## 3. Diagnóstico de Causas Raíz y Correcciones Aplicadas

### Causa 1: Pérdida de Identidad Canónica por URLs Firmadas
* **Problema:** Scrapers antiguos guardaban directamente el `.m3u8?st=...&e=...` en la columna `source_url` o `url`. Al pasar unas horas, el token vencía y toda reproducción fallaba sistemáticamente con HTTP 403.
* **Solución:** Arquitectura de 3 capas:
  1. La identidad canónica almacena solo páginas y embeds renovables o directos estables.
  2. `classifySourceKind()` clasifica directos con firmas como `ephemeral_direct`.
  3. Directos efímeros vencidos sin locator se marcan `expired_without_locator` y no entran al proxy ni al loop de failover.

### Causa 2: Disparo Concurrente Masivo de Scrapers al Abrir la Ficha
* **Problema:** Cada apertura de `/play/:episode_id` disparaba hasta 4 adaptadores en tiempo real sobre sitios externos, saturando la CPU y memoria del ASUS T100TA (2 GB RAM) y provocando timeouts de socket.
* **Solución:** `/play/:episode_id` es ahora **DB-Only**. Devuelve los localizadores canónicos ya indexados en milisegundos. La resolución JIT ocurre únicamente para la fuente activa mediante `POST /api/v1/resolve-embed` con `ResolutionCoordinator` (single-flight por localizador y caché LRU de 128 entradas).

### Causa 3: Desfase de Cabeceras HTTP Upstream y Bloqueos CORS
* **Problema:** CDNs como Vimeos, Goodstream y Zilla Networks exigen combinaciones específicas de `Referer`, `Origin` y `User-Agent`. Peticiones directas desde el navegador o proxies genéricos recibían 403 Forbidden.
* **Solución:** `hostProfiles.ts` gestiona perfiles estrictos por host (`buildProxyHeaders`). Las sesiones proxy inyectan los encabezados requeridos automáticamente en el fetch upstream.

### Causa 4: Desconexión de Sub-Recursos y Rebase en Renovación de Sesión HLS
* **Problema:** Al renovar un token tras un 401/403, los segmentos absolutos ya indexados reintentaban con la URL vieja, o playlists con claves `#EXT-X-KEY` y mapas `#EXT-X-MAP` quedaban fuera de la sesión proxy.
* **Solución:** `PlaybackSessionStore.rewriteManifest()` procesa tanto líneas de segmentos como atributos `URI="..."` en tags `#EXT-X-KEY`, `#EXT-X-MAP` e `I-FRAME-STREAM-INF`. Al renovar la sesión, `rebaseResource()` reconstruye las URLs secundarias sobre el nuevo host, directorio y query string de la nueva generación.

### Causa 5: Failovers Ciegos y Bucle Infinito en Frontend
* **Problema:** Si un embed tardaba en cargar o no confirmaba frames, el frontend cambiaba de servidor inmediatamente. Al acabarse los servidores, cicla indefinidamente o mostraba pantallas negras silenciosas.
* **Solución:** Máquina de estados determinista (`playerDelivery.ts`), control de concurrencia mediante `attemptIdRef`, registro de modos intentados (`attemptedModesRef`) para que ningún servidor repita el mismo modo en un intento, y diálogo interactivo en lugar de failover ciego para iframes.

---

## 4. Próximos Pasos en la Implementación

1. **Modularizar Registro de Resolvers (`ProviderResolverRegistry`):** Formalizar el contrato `ProviderResolver` e implementar adaptadores limpios y desacoplados con capacidades explícitas.
2. **Observabilidad Estructurada Liviana:** Integrar eventos sin credenciales (`play_requested`, `source_selected`, `resolution_started`, `resolution_succeeded`, `resolution_failed`, `direct_started`, `direct_failed`, `proxy_session_created`, `proxy_upstream_rejected`, `session_refreshed`, `embed_selected`, `manual_failover`, `playback_confirmed`).
3. **Suite Completa de Pruebas Unitarias e Integradas (25 Casos):** Crear `server/streamDeliveryEngine.test.ts` con servidores HTTP simulados (nock / fixtures locales) cubriendo todos los escenarios obligatorios.
