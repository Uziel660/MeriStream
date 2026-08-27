# 📋 Reporte E2E — Adaptador VerAnimes (`wwv.veranimes.net`)

> **Fecha:** 2026-08-22
> **Adaptador:** `server/scrapers/adapters/VerAnimesAdapter.ts`
> **Entorno:** Servidor local en `http://127.0.0.1:3005` (SIEMPRE 127.0.0.1; puerto 3000 = Docker).
> **Herramientas:** curl directo + API del server (`analyze`, `resolve-embed`, `proxy/stream`) + vitest.

---

## Estado final: ✅ OK con FIX aplicado (dentro del adaptador) + 1 pendiente FUERA DE SCOPE

Validación: `npx tsc --noEmit` limpio · `npx vitest run tests/scrapers/VerAnimesAdapter.test.ts` **5/5 passed**.

---

## 1. Ingesta y Metadatos (`POST /api/v1/catalog/analyze`)

| URL probada | page_type | Resultado |
| :--- | :--- | :--- |
| `https://wwv.veranimes.net/animes` | `catalog` | ✅ 20 títulos con title/url/poster (WebP lazy `data-src`) |
| `https://wwv.veranimes.net/anime/boku-no-hero-academia-i-am-a-hero-too` | `detail` | ✅ og:title limpio, sinopsis, poster/banner, 4 géneros, año 2025, 1 episodio |
| `https://wwv.veranimes.net/ver/boku-no-hero-academia-i-am-a-hero-too-1` | `direct_stream` | ✅ **7 streams detectados** |

El flujo de ofuscación del sitio sigue intacto: `<ul class="opt" data-encrypt>` vacío →
`POST {origin}/process {acc=opt, i=<id>}` → `<li encrypt="<hex>">` decodificados con hex→ASCII.
Sin Cloudflare; fetch plano funciona.

## 2. Los servidores del episodio (curl directo + resolve-embed + proxy)

| # | Servidor (embed) | Redirección | Resolución a directo | Reproducible vía proxy |
| :-- | :--- | :--- | :--- | :--- |
| 1 | `streamwish.to/e/26pwujh4mith` | — | ✅ → `playnixes.com/stream/.../master.m3u8` (playwright_sniffer) | ✅ OK |
| 2 | `uqload.is/embed-02l481whpokb.html` | → `uqload.vc` (migración de dominio, normal) | ✅ → `strm10.uqload.vc/hls2/.../master.m3u8?...token` | ✅ **HTTP 200** |
| 3 | `mp4upload.com/embed-v0ejfkbdlaes.html` | → www | ⚠️ → `a3.mp4upload.com:183/d/.../video.mp4` (73 MB) | 🟡 degradado, ver §3 |
| 4 | `voe.sx/e/8uqbak5xtpco` | — | ❌ embed vivo sin resolver (limitación resolvers) | embed crudo |
| 5 | `mixdrop.ps/e/03vjzv16tgd6dl` | → `miixdrop.top` (migración) | ❌ sin resolver | embed crudo |
| 6 | `bysesukior.com/e/rqgso7luh89i` | — (variante Byse nueva) | ❌ SPA cifrada AES-GCM | embed crudo |

**Nota sobre "servidores raritos que redirigen":** las redirecciones `uqload.is→uqload.vc`,
`mixdrop.ps→miixdrop.top`, `mp4upload.com→www.mp4upload.com` son migraciones de dominio del
propio host, responden HTTP 200 al final y NO son errores. El problema real es solo el CDN de MP4Upload.

## 3. Diagnóstico profundo MP4Upload `:183` (el timeout que se veía en los logs)

Síntomas reportados por el usuario: `api/v1/proxy/stream` → `a3.mp4upload.com:183` con
Status 500 / Status 0 y `Connect Timeout Error (10000ms)`.

Causa raíz verificada por bisección (TCP/TLS/undici):

1. **TCP conecta rápido** (151ms) pero **el handshake TLS tarda 8–36s o expira**: medido con
   probes repetidos → ~60% de intentos superan los 15s o directamente expiran.
   El CDN está degradado HOY (no es firewall local ni puerto bloqueado: el puerto abre).
2. El proxy usa undici con su **connect-timeout por defecto = 10s** → pierde la carrera casi siempre.
3. Con headers correctos del perfil (`Referer: https://www.mp4upload.com/`), cuando el TLS
   completa, responde **206 con Range** correctamente (verificado con curl, ttfb 8–35s).
   Sin Referer propio → 403 (hotlink-protection, ya cubierto en `hostProfiles.ts`).
4. Consecuencia en el player: como `extractStream()` ponía los directos SIEMPRE primero,
   este MP4 lento/muerto encabezaba la lista y el usuario veía el error antes del failover.

## 4. Fix aplicado (dentro de scope): sonda de salud + reorden de failover

En `VerAnimesAdapter.ts::extractStream()`:

- Nueva `probeAndOrderDirectStreams()`: sondea cada URL directa (.m3u8/.mp4) con **HEAD 6s**
  usando los headers reales que aplicará el proxy (`buildProxyHeaders()` de `server/hostProfiles.ts`).
- Orden resultante: **directos sanos → embeds → directos caídos al final**.
- Si la sonda falla para todos (bloqueo de red), no descarta nada (fallback seguro).
- Efecto: StreamWish/Uqload (m3u8 vivos) ahora encabezan la lista; el MP4Upload degradado
  queda al fondo y el player hace failover antes de estrellarse contra él.

Validación: `npx tsc --noEmit` ✅ · `npx vitest run tests/scrapers/VerAnimesAdapter.test.ts` **5/5** ✅.
Requiere reinicio del server (tsx sin watch) para probarlo E2E.

## 5. Pendiente FUERA DE SCOPE

> ⚠️ Necesito tocar `server.ts` (+ perfil en `server/hostProfiles.ts`):
> elevar el connect-timeout de undici SOLO para `mp4upload.com` (~35s vía perfil,
> p.ej. campo opcional `connectTimeoutMs` en `HostProfile`) porque su CDN hoy necesita
> hasta ~30s de handshake TLS. **Pendiente de aprobación del usuario** (o lo aplica manual).

Limitaciones aceptadas (no bugs): VOE/Mixdrop/Byse(`bysesukior`) sin resolución server-side
son limitaciones de `server/resolvers.ts` (otro territorio). Favicon 404 es cosmético.
Polling 304 en `/worker/jobs` es comportamiento normal de caché.
