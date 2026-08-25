# Informe de Implementación: Adaptador TioPlus (tioplus.app)

| Campo | Valor |
|---|---|
| **Fecha** | 2026-08-21 |
| **Adaptador** | `TioPlusAdapter` (`server/scrapers/adapters/TioPlusAdapter.ts`) |
| **Script de prueba** | `test_tioplus.ts` (raíz del proyecto) |
| **Resultado final** | ✅ Stream directo real `.m3u8` obtenido en búsqueda, serie, película y anime; mocks sin red verificados |

---

## 1. Investigación técnica del sitio (verificada con curl/node, no asumida)

Todas las estructuras fueron sondeadas físicamente contra `https://tioplus.app` antes de programar:

### 1.1 Búsqueda
- La página `/search` es una SPA vacía: los resultados los carga JS vía **API interna** descubierta en `app.js`: `GET /api/search/{query}` → devuelve fragmento HTML con cards.
- Estructura de card verificada:
  ```html
  <article class='item liste relative'>
    <a class='itemA' href="https://tioplus.app/pelicula/supergirl">
      <img alt='Supergirl' data-src='https://image.tmdb.org/t/p/w342/....jpg' src="/images/placever.jpg" class="lazyload" />
      <span class="typeItem movie">Película</span>   <!-- movie | anime | (serie) -->
      <h2>Supergirl (2026)</h2>
    </a>
  </article>
  ```
- El tipo de contenido viene en la clase de `span.typeItem`: `movie`, `anime`, o sin clase extra para `Serie`.

### 1.2 Catálogo (Home y listados)
- `<article>` con `a.itemA`; imágenes lazyload con URL real en `data-src` (**image.tmdb.org**, `src` es placeholder).
- Rutas de contenido: `/pelicula/{slug}`, `/serie/{slug}`, `/anime/{slug}`; episodios: `/{serie|anime}/{slug}/season/{n}/episode/{n}`.

### 1.3 Página de detalle
- `og:title` → `"Ver Supergirl (2026) Online Gratis Español - TioPlus"` (requiere limpieza: prefijo `Ver `, sufijo `- TioPlus` y `Online Gratis...`).
- `og:image` → poster real en `https://image.tmdb.org/t/p/original/....jpg` ✔.
- Año: enlace `href=".../year/2015"`; Rating: `<b>Rating:</b> 7.3` (¡con `</b>` intermedio!); géneros: `.genres a[href*="/genero/"]`.
- Episodios: variable global **`var seasonsJson = {"1":[{title,image,season,episode},...],"2":[...]};`** con TODAS las temporadas (verificado: Diarra from Detroit S1=8 + S2=5). El DOM (`#episodeList`) solo trae la temporada 1.

### 1.4 Página de episodio/película — ofuscación del video (núcleo)
Atributos reales capturados:
```html
<li role="presentation" data-server="cDI3Q25sMng4M2RlSm00aUR2WmJGaFRNVnFxZnlBWHc5b1NKZGo1MW9hZUh2K3hkNk5RPQ==">
<div id="player-tr" class="video-html playrn" data-tr="cDI3Q25sMng4M2RlSm00...">
```
**Descubrimiento clave (app.js del sitio, líneas 132–149 y 267–277):**
```js
var o = element.dataset.server;
'<iframe ... data-src="/player/' + btoa(o) + '" ...>'          // botones de servidor
let ol = b64_to_utf8(item.getAttribute("data-tr"));            // atob(data-tr)
'... data-src="/player/' + btoa(btoa(ol)) + '" ...'            // reproductor por defecto
```
Ambos caminos producen lo mismo: **`/player/{btoa(valor_del_atributo)}`**. Verificado con curl:
```
GET https://tioplus.app/player/Y0RJM1EyNXNNbmc0TTJS...PQ09
→ HTTP 200, body contiene: window.location.href = 'https://vidhideplus.com/v/bb68k3qu3y0l'
```
El endpoint `/player/` funciona **sin cabecera Referer** (probado), por lo que `fetchHtml` de `BaseAdapter` sirve tal cual. El valor decodificado del atributo (`p27Cnl2x83d...=`) es un token opaco NO http, por eso la ruta `/player/` es imprescindible.

---

## 2. Implementación

`TioPlusAdapter extends BaseScraperAdapter` (hermano de TioAnime/LatAnime; **no registrado aún** en `ScraperManager.ts` — fuera de mi alcance por coordinación):

| Método | Función |
|---|---|
| `canHandle(url)` | Detecta dominios `tioplus.app` / `www.tioplus.app` |
| `search(query)` | API interna `/api/search/{q}`; fallback Home + filtrado local |
| `extractCatalogItems(html)` | `<article>` (fallback `div.item`): título h2→alt→slug, imagen lazy tmdb, año `(YYYY)`, kind desde `.typeItem` o ruta |
| `extractMetadata(html, url)` | og:title limpiado (`Ver`/`- TioPlus`/`Online Gratis`), og:image tmdb preservado, descripción, géneros, año `/year/`, rating (tolera `</b>` intermedio) |
| `extractEpisodes(html, baseUrl)` | 1) `var seasonsJson` (todas las temporadas) → URLs `/{serie|anime}/{slug}/season/{s}/episode/{e}`; 2) fallback DOM `#episodeList article a[href*="/season/"]` |
| `decodeDataVideos(html)` | **CRÍTICO**: decodifica `[data-video], [data-server], [data-tr]`. Nivel 1: Base64→http directo. Nivel 2: doble Base64. Nivel 3: token opaco → `${BASE}/player/{btoa(valor)}` |
| `resolvePlayerPage(url)` | Fetch de `/player/{token}` y extracción de `window.location.href = '<embed>'` |
| `analyze(input, type)` | No-URL→búsqueda; rutas catálogo (`/`, `/peliculas`, `/series`, `/animes`, `/doramas`, `/genero/*`, `/year/*`); detalle con kind por ruta (movie/series/anime) |
| `extractStream(url)` | decodeDataVideos → resolver `/player/` → `EmbedResolvers.resolve()` en paralelo → `MediaValidator.validateUrls()` → prioriza `.m3u8/.mp4` |

Sin Playwright: solo `fetch` + `cheerio`.

## 3. Prueba real — salida EXACTA de terminal

Comando: `npx tsx test_tioplus.ts` (ejecutado físicamente; corrida final exitosa tras 2 iteraciones de corrección).

```
=== IDENTIDAD DEL ADAPTADOR ===
id=tioplus name=TioPlus domains=["tioplus.app","www.tioplus.app"]
  OK: id === 'tioplus'
  OK: canHandle(tioplus.app) === true
  OK: canHandle(tioanime.com) === false

=== MOCK: decodificación de data-video (sin red) ===
  data-video="aHR0cHM6Ly92..." -> https://vidhideplus.com/v/mockembed123
  OK: Base64 de iframe directo se decodifica a la URL exacta
  data-server opaco -> https://tioplus.app/player/Y0RJM1EyNXNNbmc0TTJSbFNtMDBhVVIyV21KR2FGUk5WbkZ4Wm5sQ...
  OK: tokens duplicados se deduplican (2 únicos de 3 atributos)
  OK: token opaco genera URL /player/{btoa(valor)} según app.js
  doble Base64 -> https://mega.nz/embed/mockID
  OK: doble Base64 se revuelve hasta el enlace http

=== MOCK: extractEpisodes con seasonsJson ===
  episodios: 3
  OK: seasonsJson extrae todas las temporadas (3 episodios)
  OK: URL T2E1 construida con ruta /serie/{slug}/season/{n}/episode/{n}
  título="Serie Mock (2024)" poster=https://image.tmdb.org/t/p/original/mockABC.jpg
  OK: og:title limpio sin 'Ver ' ni sufijo '- TioPlus'
  OK: og:image conserva enlace image.tmdb.org

=== PASO 1: Búsqueda real 'supergirl' en tioplus.app ===
Resultados encontrados: 3
  - [movie] Supergirl (1984) -> https://tioplus.app/pelicula/supergirl-1984
    img: https://image.tmdb.org/t/p/w342/9ZSS0Gc5fwcu8apglDGoK6zlarL.jpg
  - [series] Supergirl (2015) -> https://tioplus.app/serie/supergirl
    img: https://image.tmdb.org/t/p/w342/vqBsgL9nd2v04ZvCqPzwtckDdFD.jpg
  - [movie] Supergirl (2026) -> https://tioplus.app/pelicula/supergirl
    img: https://image.tmdb.org/t/p/w342/sbPxtcrj3fPp3CH4CZgSj9Or7Yr.jpg
  OK: la búsqueda real devuelve resultados

=== PASO 2: analyze() del primer resultado: https://tioplus.app/serie/supergirl ===
page_type:     detail
content_type:  series
title:         Supergirl (2015)
poster:        https://image.tmdb.org/t/p/original/mmprryb2r0X8u9JkZCnaJIzyYX4.jpg
year:          2015 | rating: 7.3
géneros:       Drama, Acción, Aventura, Ciencia ficción, Fantasía
episodios:     20
  primero: #1 S01E01: Piloto -> https://tioplus.app/serie/supergirl/season/1/episode/1
  último:  #20 S01E20: Ángeles buenos
  OK: analyze(detail) devuelve page_type=detail
  OK: título extraído
  OK: poster_url presente (og:image)

=== PASO 3: extractStream() de https://tioplus.app/serie/supergirl/season/1/episode/1 ===
Título:        Supergirl (2015) Temporada 1 Capítulo 1
STREAM PRINCIPAL: https://cdn.turboviplay.com/data/wZngbxFrun6yBG8klpHT/wZngbxFrun6yBG8klpHT.m3u8
Todos los streams (5):
  * https://cdn.turboviplay.com/data/wZngbxFrun6yBG8klpHT/wZngbxFrun6yBG8klpHT.m3u8
  * https://pelisplus.upns.pro/#cuou
  * https://vudeo.co/embed-kg6fb8yxr7fu.html
  * https://emturbovid.com/t/wZngbxFrun6yBG8klpHT
  * https://waaw.to/f/T3oE6u03dnBX

=== PASO 4: decodeDataVideos sobre página real de episodio ===
Candidatos encontrados: 5
  -> https://tioplus.app/player/Y0RJM1EyNXNNbmc0TTJSbFNtMDBhVVIyV21KR2FGUk5WbkZ4Wm5sQldIYzViMU5LU201bk9IRmhaa0oyUzN
  -> https://tioplus.app/player/Y0RJM1EyNXNNbmc0TTJSWlMyMVpha1pQU2xORmQzVllWVkJUVXpGRllYWTRjMVJGVGpKek5IQmxSVDA9
  -> https://tioplus.app/player/Y0RJM1EyNXNNbmc0TTJSbFQyMDBka05NZUdSRFZtWmpVMDloV25jd1Z6QTFOVEpPWkdwQk1ITjFZa0p5UzI
  -> https://tioplus.app/player/Y0RJM1EyNXNNbmc0TTJST1NXNDBMMFptUWxKRlFraGtReXRsVkhsclpYSnlPWGw0WlcwNGRuTjBTMFYyTjB
  -> https://tioplus.app/player/Y0RJM1EyNXNNbmc0TTJSbVRHMXpPVk5sV2xKVFVqWlhZMkpsVkRSc05uRnpTbWxRWld0dlZnPT0=
  OK: página real expone servidores ofuscados decodificables

¿Stream directo (.m3u8/.mp4)?: SÍ ✔

TEST COMPLETADO
```

Prueba adicional de flujos película/anime (script temporal, ejecutado y luego eliminado):
```
PELI: Supergirl (2026) | kind: movie | year: 2026 | rating: 6.2 | eps: 0
PELI STREAM: https://cdn.turboviplay.com/data3/6a66e24f5c255/6a66e24f5c255.m3u8
ANIME: Clevatess (2025) | kind: anime | eps: 12 | poster tmdb: true
ANIME EP1 STREAM: https://cdn.turboviplay.com/data3/6a7aafb798748/6a7aafb798748.m3u8
```

## 4. Hallazgos críticos

1. **El prompt hablaba de `data-video`, pero el sitio real usa `data-server` (botones) y `data-tr` (reproductor).** El adaptador soporta los tres atributos.
2. **La decodificación Base64 simple NO revela el iframe**: el valor decodifica a otro token opaco (`p27Cnl2x83d...=`), no a una URL. El mecanismo real (revertido de `app.js`) es recodificar el atributo con `btoa` y pedir `GET /player/{token}`, cuya respuesta contiene `window.location.href = '<embed real>'`. Sin este paso el adaptador no obtendría ningún video.
3. **`seasonsJson` es la única fuente completa de episodios**: el DOM solo renderiza la temporada 1; las demás se cargan por JS desde esa variable global.
4. **og:title requiere triple limpieza**: `Ver ` inicial, sufijo `- TioPlus(.net|.app)` y cola `Online Gratis Español`.
5. **Rating con etiqueta intermedia**: el HTML es `<b>Rating:</b> 7.3`; la regex debe tolerar `</b>` entre "Rating:" y el número (bug detectado y corregido durante las pruebas reales).
6. Los embeds finales resuelven a `.m3u8` directos de `cdn.turboviplay.com` vía `EmbedResolvers` (familia StreamWish/turbovid); los enlaces son firmados/temporales → extracción Just-In-Time (el diseño actual ya lo hace).

## 5. Verificaciones de calidad (reales)

| Verificación | Comando | Resultado |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | ✅ Sin errores |
| Suite completa | `npx vitest run` | ✅ **7 archivos, 58/58 tests pasaron** (1.56s) |
| Integración E2E | `npx tsx test_tioplus.ts` | ✅ Exitosa: mocks sin red + búsqueda/analyze/stream reales |
| Flujos extra | película + anime (script temporal) | ✅ Ambos con `.m3u8` directo |

Iteraciones durante desarrollo (transparencia):
- Corrida 1: fallo en mock de og:title (no limpiaba `Online Gratis Español`) → añadida función `cleanTitle()`.
- Corrida 2: rating 0 en página real (por `</b>` intermedio) → regex corregida; corrida 3: todo verde.

## 6. Estado

- Archivos creados: `server/scrapers/adapters/TioPlusAdapter.ts`, `test_tioplus.ts`, `informes/TioPlus.md`.
- **NO se tocó** `ScraperManager.ts` ni archivos de otros adaptadores (coordinación con líder). Pendiente: el líder debe registrar `TioPlusAdapter` en `ScraperManager.ts` (import + push al array de scrapers).
- Nada commiteado (se espera instrucción del líder).

## 7. Recomendaciones

1. **Registro en ScraperManager**: importar `TioPlusAdapter` y añadirlo al listado de scrapers activos.
2. **Cache corto de streams**: los `.m3u8` de turboviplay son firmados y expiran; mantener extracción JIT (diseño actual correcto).
3. **Paginación de catálogos**: los listados `/peliculas`, `/series`, etc. paginan por URL (`/page/N` observado en filtros); si se necesita catálogo completo, iterar páginas.
4. **Dominios nuevos de embeds**: si turboviplay/turbovid rotan dominios, ampliar `KNOWN_EMBED_HOSTS` en `validator.ts` para saltarse la validación HEAD.
