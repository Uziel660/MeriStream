# 📊 Estado del Proyecto — 2026-08-22

> Documento de estado canónico. Los documentos de sesión anteriores
> (`CHECKPOINT_MEGA_2026-08-21.md`, `ERRORES_ADAPTADORES_2026-08-21.md`,
> `ESTADO_PROYECTO_2026-08-21.md`) se conservan como historial.

## Resumen

Validación E2E completa de los 12 adaptadores de scraping con subagentes,
más 3 fixes aplicados y verificados contra el servidor vivo (:3005).

## Fixes de esta sesión (2026-08-22)

| Fix | Archivo | Detalle |
|---|---|---|
| BUG #1 `detected_streams` vacío | `VerAnimesAdapter.ts` | Único adaptador que faltaba; ahora acepta `analyze()` sin `explicitType`. Los otros 5 ya estaban parcheados |
| Streams efímeros TioAnime | `TioAnimeAdapter.ts` | Embeds fiables (Mega/YourUpload/ok.ru) primero; cfglobalcdn (token atado a IP ajena) y vidcache (handshake propietario) van al final. Aplicado en ambas rutas (array `var videos` y fallback genérico) |
| Hotlink MP4Upload | `server.ts` + `HLSPlayerModal.tsx` | El proxy fuerza `Referer: https://www.mp4upload.com/` para hosts mp4upload (antes 403→500). El player además elige referer por host en vez del animeflv hardcodeado |
| Lint frontend | `src/vite-env.d.ts` + `HLSPlayerModal.tsx` | Creado vite-env.d.ts (faltaba referencia vite/client para import.meta.env); ref muerto eliminado |

## Validación E2E por adaptador (subagentes secuenciales)

| Adaptador | Estado | Hallazgo clave |
|---|---|---|
| Cinecalidad | PASS | 6 streams (1 m3u8 Goodstream + 5 embeds), proxy 200, manifiesto HLS válido |
| TubePelis | PASS | Decrypt Byse (AES-256-GCM) verificado con datos frescos; tokens ~15min (JIT obligatorio) |
| TioPlus | PASS | Película + episodio OK; turboviplay HLS vía proxy 200 |
| LatAnime | PASS* | data-player Base64 OK; fix MP4Upload verificado E2E (proxy 200) |
| VerAnimes | PASS* | Fix detected_streams confirmado (3 streams); CDN directo usa Cloudflare Origin CA no confiable → reproducible vía embed StreamWish |
| TioAnime | PASS* | 500 episodios OK; embeds fiables primero tras fix; ok.ru responde 200 vía proxy |
| AnimeFLV / LaMovie | PASS | Validados en sesiones anteriores |

## Limitaciones externas conocidas (no son bugs nuestros)

1. **cfglobalcdn.com** (VerAnimes/TioAnime): certificado Cloudflare Origin CA no confiable + token `secip` firmado para otra IP. Solo funciona dentro de su ecosistema.
2. **vidcache.net**: servidor StretchFS que exige handshake propietario.
3. **Doodstream**: requiere resolver dedicado (`pass_md5`) — pendiente opcional.
4. **VOE placeholder**: el host sirve Big Buck Bunny cuando el archivo cayó (ya invalidado en `streamOptimizer.scoreServer`).
5. Tokens HLS firmados caducan (Goodstream 12h, Byse 15min): el diseño JIT ya lo cubre.

## Entorno

- Servidor Express: puerto **3005** (3000 es Gotenberg/Docker — usar siempre `127.0.0.1`)
- Correr con `npm run dev` (= tsx server.ts, SIN watch → reiniciar tras cambiar `server/**`)
- Tras cambiar `src/`: `npx vite build`
- Tests: `npx vitest run` (103 tests); lint: `npm run lint`
