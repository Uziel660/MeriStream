# 🔴 ERRORES DE ADAPTADORES — Informe verificado contra API real

> Generado por ox-alpha el 2026-08-21. Todos los resultados provienen de
> `POST http://127.0.0.1:3000/api/v1/catalog/analyze` con el servidor ya
> reiniciado y cargando los parches de BUG #1. Complementa
> `docs/ESTADO_PROYECTO_2026-08-21.md`.

---

## 1. Resumen de verificación (resultados reales de hoy)

| Adaptador | URL probada | detected_streams | Veredicto |
|---|---|---|---|
| Cinecalidad | `/ver-pelicula/john-wick-4/` | **7** (1 m3u8 + 6 embeds) | ✅ OK |
| LaMovie (baseline) | Bolt 2008 | **7** (1 m3u8 + 6 embeds) | ✅ OK |
| Archive.org | `night_of_the_living_dead` | **1** mp4 directo | ✅ OK |
| TubePelis | Spider-Man película | **1** (`byseqekaho.com/e/...`) | ⚠️ parcial |
| TioPlus | Supergirl | **4** (1 m3u8 + 3 sospechosas) | ⚠️ parcial |
| VerAnimes | detalle Naruto Shippuden especial | **3** (m3u8 + 2 embeds) | ✅ OK |
| **LatAnime** | página **detalle** Mushoku S3 | **1** = thumbnail de portada 🗑️ | 🔴 ROTO |
| **TioAnime** | página **detalle** `/anime/naruto` | **1** = la propia URL de la página 🗑️ | 🔴 ROTO |

Nota clave: **LatAnime y TioAnime funcionan perfecto a nivel EPISODIO**:
- `latanime.org/ver/mushoku-tensei-...-episodio-1` → **9 streams** reales (mp4upload directo, dsvplay, voe, mega, mixdrop…)
- `tioanime.com/ver/naruto-1` → **7 streams** reales (cfglobalcdn m3u8, mega, yourupload ×2, ok.ru, hqq ×2)

---

## 2. Errores por adaptador

### 🔴 ERROR A — LatAnimeAdapter: analyze() en página DETALLE devuelve basura
**Síntoma**: `detected_streams: ["https://latanime.org/thumbs/portada/mushoku-tensei-...backdrop..."]`
(un thumbnail, no un video).

**Causa raíz**: en `LatAnimeAdapter.ts` el bloque de streams del modo detalle
(ahora :245) llama `this.extractStream(cleanUrl)` pasando la página de **detalle**
(`/anime/<slug>`). Los players reales viven SOLO en páginas de episodio
(`/ver/...`, atributo `data-player` base64 decodificado por `decodeDataPlayers()`).
En detalle, `decodeDataPlayers` devuelve `[]` → cae al fallback genérico de
`BaseScraperAdapter.extractStream`, que termina devolviendo una imagen del HTML
validada como "stream".

**Fix sugerido**: en modo detalle, si hay episodios, extraer streams del primer
episodio (igual que hace VerAnimesAdapter.ts:416-424):
```ts
if (!explicitType || explicitType === "stream" || explicitType === "auto") {
  try {
    const first = episodes[0];
    const target = first ? first.url : cleanUrl;
    const streamResult = await this.extractStream(target);
    detectedStreams = streamResult.all_available_streams;
  } catch {}
}
```

### 🔴 ERROR B — TioAnimeAdapter: analyze() en página DETALLE se auto-devuelve
**Síntoma**: `detected_streams: ["https://tioanime.com/anime/naruto"]` (la propia
URL de la página web).

**Causa raíz**: idéntica al error A. En `TioAnimeAdapter.ts` (:574 ahora) el modo
detalle llama `extractStream(cleanUrl)` sobre `/anime/<slug>`; `extractVideosArray`
solo encuentra `var videos` en páginas `/ver/...` → devuelve `[cleanUrl]`.

**Fix sugerido**: mismo patrón que el error A — usar `episodes[0].url` como
fuente de streams en modo detalle. El endpoint `/ver/naruto-1` ya demuestra que
el extractor funciona (7 streams).

### ⚠️ ERROR C — TubePelisAdapter: solo 1 stream y sin fuente directa
**Síntoma**: `detected_streams: ["https://byseqekaho.com/e/io763rkfeikn/"]`.
Un único embed desconocido (ni m3u8 ni embed whitelisteado). Si ese host falla o
sirve placeholder, no hay failover.

**Causa probable**: `resolveStreamsFromHtml(html)` solo encuentra un iframe en la
página (o los demás están ofuscados/cargados por JS).

**Fix sugerido**: auditar el HTML real de la película de prueba buscando más
iframes/`<source>`; considerar sniffer Playwright para ese dominio si los servers
se cargan dinámicamente.

### ⚠️ ERROR D — TioPlusAdapter: 3 de 4 streams son URLs opacas con fragmento
**Síntoma**: además del m3u8 válido (`cdn.turboviplay.com/...m3u8`) devuelve:
```
https://pelisplus.strp2p.com/#jvgicd
https://pelisplusto.4meplayer.pro/#9msol
https://pelisplus.upns.pro/#dtfoue
```
URLs con `#fragmento` tipo token, sin ruta de embed reconocible. Probablemente
requieren resolución adicional o fallarán al reproducirse.

**Fix sugerido**: verificar manualmente si esas 3 reproducen; si no,
`EmbedResolvers` necesita soporte para hosts `strp2p/4meplayer/upns`, o filtrarlas
en el adaptador dejando solo las resolubles.

### ℹ️ ISSUE persistente — Placeholder Big Buck Bunny en VOE (sin cambios)
Al reproducir via VOE puede servir `Big_Buck_Bunny_1080_10s_5MB.mp4`. Confirmado
que NO es código nuestro: es el host VOE sirviendo demo cuando el archivo cae.
Opciones siguen abiertas (probar otros servers del dropdown / heurística
anti-placeholder en `EmbedResolvers.resolveWithMeta`).

### ℹ️ Entorno — Conflicto de puerto :3000 con Docker (importante para probar)
En esta máquina hay un contenedor Docker (Gotenberg, responde JSON
`chromium/libreoffice`) escuchando también en `0.0.0.0:3000` vía
`com.docker.backend` + `wslrelay.exe` en `[::1]:3000`.

Consecuencia práctica:
- `http://localhost:3000` → resuelve a IPv6 `::1` → **contesta DOCKER, no Nitiflix**.
- `http://127.0.0.1:3000` → **contesta Nitiflix** ("VoidStream Core API").

**Regla para pruebas**: usar SIEMPRE `127.0.0.1` en curl/scripts. Además el
servidor corre sin watch (`tsx server.ts`): tras cambiar `server/**` hay que
reiniciarlo para que cargue el código nuevo.

### ℹ️ Deuda menor (de ESTADO_PROYECTO, sigue pendiente)
- `test_*.ts` sueltos en raíz duplican `tests/scrapers/` → borrar algún día.
- `server_e2e_pid.txt` en raíz → borrar.
- E2E visual en navegador pendiente para casi todos los adaptadores (ISSUE #3).

---

## 3. Estado de los parches de BUG #1 aplicados hoy

Aplicado el patrón `if (!explicitType || explicitType === "stream" || ...)` en:
Cinecalidad (:348→347), LatAnime (:246), TioAnime (:574), TioPlus (:423),
TubePelis (:370), VerAnimes (:367 y :416). También se añadió `cinecalidad.am/`
a `isRawWebpage()` en `src/utils/streamOptimizer.ts`.

Validación: **103/103 vitest**, `tsc --noEmit` limpio, `vite build` OK.

Los parches arreglan la condición, pero los errores A y B muestran que en
LatAnime/TioAnime el problema REAL es *a qué URL* se le piden los streams
(detalle vs episodio), no solo la condición del `if`.

---

*Informe para revisión del usuario — ox-alpha, 2026-08-21.*
