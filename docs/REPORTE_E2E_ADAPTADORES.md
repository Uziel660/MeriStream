# 📋 Reporte de Pruebas E2E de Adaptadores — Nitiflix

> **Fecha:** 2026-08-21  
> **Entorno:** Servidor local en `http://127.0.0.1:3000` (Evitando conflicto IPv6 de Docker en `:3000`).  
> **Herramienta:** Navegador E2E + Análisis de Tráfico de Red y API.

---

## Resumen General de Adaptadores

| Adaptador | Catálogo / Metadatos | Detección de Streams | Reproducción E2E | Estado |
| :--- | :--- | :--- | :--- | :--- |
| **AnimeFLV** (`animeflv.or.at`) | ✅ Exitoso (Título, cover, episodios) | ✅ Exitoso (5 streams detectados) | 🔴 **Falla (403 en segmentos m3u8)** | ⚠️ Requiere ajuste de reproductor/embed |

---

## Detalle de Pruebas por Adaptador

### ### AnimeFLV (`AnimeFlvAdapter.ts`)

- **URL de Catálogo probada:** `https://animeflv.or.at/anime/`
- **URL de Detalle probada:** `https://animeflv.or.at/anime/gaikotsu-kishi-sama-tadaima-isekai-e-odekakechuu-ii-1/`
- **URL de Episodio analizada:** `https://animeflv.or.at/2026/08/03/gaikotsu-kishi-sama-tadaima-isekai-e-odekakechuu-ii-episodio-5/`

#### 1. Ingesta y Metadatos (Catálogo & Detalle)
- **Resultado:** ✅ **FUNCIONA CORRECTAMENTE**
- **Comportamiento:**
  - El extractor universal detecta correctamente la página como `detail` y categoría `anime`.
  - Extrae título en japonés e inglés, sinopsis enriquecida, póster, banner y el listado de episodios (`Episodio 5`, `Episodio 6`).
  - La persistencia en PostgreSQL (`POST /api/v1/catalog/import-show`) funciona sin fallos.

#### 2. Detección y Extracción de Servidores de Video
- **Resultado:** ✅ **FUNCIONA CORRECTAMENTE**
- **Servidores extraídos en tiempo real (`GET /api/v1/play/:episode_id`):**
  1. `https://player.zilla-networks.com/m3u8/21271e214b11ae78d8a2956ea820938c` (Zilla / Servidor Directo)
  2. `https://mega.nz/embed/KT5UyYqb#fOhjxhv7GKBGyj57KrmLW0zuXf7o6XnPmHBhnIoSSxk` (Mega Embed)
  3. `https://www.mp4upload.com/embed-fdqerozqyiwd.html` (Mp4Upload Embed)
  4. `https://www.mp4upload.com/fdqerozqyiwd`
  5. `https://animeav1.uns.bio/#iutbgm`

#### 3. Reproducción en el Reproductor (Prueba de Fuego E2E)
- **Resultado:** 🔴 **FALLO EN REPRODUCCIÓN HLS DIRECTA**
- **Diagnóstico del Error:**
  - `HLSPlayerModal` selecciona prioritariamente el stream directo m3u8 de Zilla Networks (`player.zilla-networks.com/m3u8/...`).
  - El manifiesto maestro m3u8 descarga con HTTP 200, pero **los segmentos individuales** (`/segs/21271e214b11ae78d8a2956ea820938c/init.html`, `.html`) son rechazados por el servidor con **HTTP 403 Forbidden** y sin cabeceras CORS.
  - Esto provoca que `hls.js` falle inmediatamente con `networkError / 403` y la aplicación muestre la pantalla de error en el reproductor.

#### 4. Recomendación de Solución / Fix
1. **Enrutamiento por Proxy:** Pasar los segmentos de `player.zilla-networks.com` a través del proxy Anti-CORS del servidor (`/api/v1/proxy/stream?referer=https://animeflv.or.at/&url=...`) para adjuntar el referer requerido y burlar el 403.
2. **Fallback a Embeds Funcionales:** Si el stream de Zilla falla, conmutar automáticamente al iframe de `mega.nz` o `mp4upload.com`, los cuales son compatibles mediante iframe directo sin bloqueo de hotlink.
