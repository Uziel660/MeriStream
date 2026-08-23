# 📋 REPORTE E2E — ADAPTADOR LAMOVIE

> **Fecha:** 2026-08-23
> **Responsable:** agente exclusivo del adaptador `lamovie`
> **Territorio:** `server/scrapers/adapters/LaMovieAdapter.ts`
> **Estado final:** ✅ **FIXEADO**

---

## 1. Estado del adaptador

**FIXEADO** — el flujo completo funciona end-to-end tras los cambios descritos en §4.
El servidor vivo debe reiniciarse para aplicar el fix (tsx corre sin watch).

## 2. Qué se probó (URLs, endpoints y resultados con datos)

### 2a. Ingesta / analyze contra servidor vivo (`http://127.0.0.1:3005`)

| Prueba | Endpoint | Resultado |
|---|---|---|
| Catálogo vía API listing | `POST /api/v1/catalog/analyze` con `https://lamovie.org/wp-api/v1/listing/movies?page=1` | ✅ HTTP 200 · `page_type=catalog` · **1000 catalog_items** |
| Detalle de película | mismo endpoint con `https://lamovie.org/peliculas/ligeramente-embarazada-2007/` | ✅ HTTP 200 (~6s) · metadatos completos (título "Ligeramente Embarazada", original "Knocked Up", rating 6.3, año 2007, 129 min, poster+banner) · **8 detected_streams** · 1 episodio |

### 2b. Verificación host por host del detalle (curl directo al origen)

| Host | Estado | Diagnóstico |
|---|---|---|
| **vimeos.net** (`embed-383oflluii8t.html`) | ✅ **FUNCIONA** | El m3u8 real vive empaquetado dentro del JS del player: `https://p6.vimeos.zip/hls2/03/00009/383oflluii8t_h/master.m3u8?t=<token>&s=...&e=43200...`. Responde `200 application/vnd.apple.mpegurl` directo Y vía proxy `/api/v1/proxy/stream` con referer `vimeos.net`. |
| goodstream.one (`embed-m7jttrchjlu3.html`) | 🔴 Muerto | Origen responde *"File is no longer available as it expired or has been deleted"* — limitación externa. |
| hlswish.com (`e/0r6uyoxbmfqw`) | 🔴 Muerto | Mismo mensaje del origen — limitación externa. |
| filemoon.sx | ⚠️ SPA shell | Página "Byse Frontend" sin stream directo trivialmente extraíble. |
| voe.sx | ⚠️ Placeholder | Redirige a `tracylocalschool.com` y sirve Big Buck Bunny placeholder (ya invalidado por scoring). |
| **1fichier.com** (`?qznbhqbs9p7c7saod336`) | 🔴 **No hay video** | El "200 OK" es una **página HTML de descarga** con countdown de 60s; hoy además devuelve *"All free guest slots are currently in use"* (sin slots anónimos). Nunca fue un stream reproducible — por eso no se veía en el reproductor pese al 200. |
| megaup.net (`.../Ligeramente.Embarazada.2007.1080p-Dual-Lat.mkv`) | 🔴 404 | Archivo caído en origen — limitación externa. |

## 3. Causa raíz del fallo principal (verificada, no supuesta)

El informe previo atribuía el 403 de vimeos.net a bloqueo del proveedor. La causa real:

1. vimeos.net empaqueta su player con una **variante del Dean Edwards Packer** cuyo
   payload va entre comillas simples con `\'` escapadas y contiene paréntesis dobles
   internos. Los regex genéricos de `jsUnpacker.ts` (`unpackDeanEdwards` /
   `extractMediaUrlsFromCode`) truncaban el payload → devolvían **0 URLs**.
   Resultado: el único servidor vivo quedaba sin resolver y el player solo veía
   embeds muertos o páginas de descarga.
2. El token HLS (`t=MQfrG...` / `t=zajeptx...`) caduca (~12h, `e=43200`): las URLs
   cacheadas viejas dan 403. El diseño JIT lo cubre si el token se extrae fresco
   en cada play.
3. Latencia de `resolve-embed` (3.6–6.6s): `extractStream()` resolviendo **8 embeds
   en secuencia**, donde cada host muerto quemaba su timeout completo antes del siguiente.

## 4. Cambios hechos

**Único archivo tocado:** `server/scrapers/adapters/LaMovieAdapter.ts` (+107/−17)

1. **`unpackPackedScript()`** (nuevo): desempaquetador local con regex anclado al
   cierre `.split('|')`, inmune a la variante de vimeos.net. Maneja radix arbitrario,
   keywords y diccionario base-N igual que el packer estándar.
2. **`resolveVimeosDirectStream()`** (nuevo): resolver dedicado para vimeos.net que
   desempaqueta el HTML del embed, extrae m3u8/mp4 y descarta placeholders
   (Big Buck Bunny) y archivos eliminados ("File is no longer available").
3. **Resolución en paralelo** (`Promise.all` preservando orden): los hosts muertos
   queman su timeout sin bloquear a los vivos → elimina la latencia secuencial.
4. **`DOWNLOAD_HOSTS = ["1fichier.com", "megaup.net"]`**: estos hosts son páginas o
   archivos de descarga, no streams reproducibles; se excluyen del resultado para
   que el player nunca intente abrirlos como video.

### Validación aplicada

| Check | Resultado |
|---|---|
| `npx tsc --noEmit` | ✅ limpio |
| `npx vitest run tests/scrapers/LaMovieAdapter.test.ts` | ✅ **5/5 passed** (11.66s) |
| Fix vs HTML real de vimeos.net (script temporal) | ✅ extrae exactamente el m3u8 verificado con curl (200 HLS) |
| Scope | ✅ solo cambió el adaptador (`git diff --stat` confirmado) |

Archivos temporales de diagnóstico eliminados tras validar.

## 5. Pendientes fuera de scope

**NINGUNO.** No hizo falta tocar `server.ts`, `hostProfiles.ts`, `resolvers.ts`,
frontend ni otros adaptadores.

Notas operativas para el usuario:

- ⚠️ **Reiniciar el server** (`npm run dev` en :3005) cuando convenga: tsx corre sin
  watch y el fix del adaptador no aplica hasta entonces. No se mató ni reinició
  ningún proceso durante esta tarea (server compartido entre sesiones).
- Los hosts caídos (goodstream, hlswish, megaup) son **caídas del sitio origen**:
  documentadas como limitación externa, no bugs del adaptador.
- Estrategia acordada con el usuario: priorizar **vimeos.net** (el servidor estable)
  e ignorar los hosts quisquillosos/muertos del set original.

---
*Reporte generado por ox-alpha — tarea de auditoría y fix del adaptador lamovie.*
