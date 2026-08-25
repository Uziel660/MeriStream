# Informe de Implementación: Adaptador VerAnimes (wwv.veranimes.net)

| Campo | Valor |
|---|---|
| **Fecha** | 2026-08-21 |
| **Adaptador** | `VerAnimesAdapter` (`server/scrapers/adapters/VerAnimesAdapter.ts`) |
| **Script de prueba** | `test_veranimes.ts` (raíz del proyecto) |
| **Resultado final** | ✅ Stream directo `.m3u8` real obtenido y verificado en terminal; 5/5 mocks OK; `tsc --noEmit` sin errores |

---

## 1. Investigación técnica del sitio (verificada con curl, no asumida)

Todas las estructuras fueron sondeadas físicamente contra `https://wwv.veranimes.net` antes de programar:

### 1.1 Catálogo y búsqueda
- Home (`GET /`) → HTTP 200, 82.511 bytes, **37 elementos `<article class="li">`**.
- Formulario de búsqueda: `<form class="f" action="./animes"><input name="buscar">` → endpoint verificado `GET /animes?buscar=naruto` → HTTP 200, 20 resultados.
- Estructura real de card:
  ```html
  <article class="li">
    <figure class="i">
      <a href="./anime/{slug}" title="...">
        <img data-src="https://wwv.veranimes.net/cdn/img/anime/{slug}.webp?t=0.1" src="./cdn/img/anime.png" alt="...">
      </a><span>TV</span>
    </figure>
    <h3 class="h"><a href="./anime/{slug}">Título</a></h3>
  </article>
  ```
- Imágenes: CDN propio en WebP (`/cdn/img/anime/*.webp`, `/cdn/img/portada/*.webp`) con lazy-load (`data-src`; `src` es placeholder `anime.png`/`episode.png`).

### 1.2 Página de detalle (/anime/{slug})
- `og:title` → `"Ver Naruto Shippuden Anime Online Gratis - VerAnime"` (sufijo `- VerAnime`).
- `og:image` → poster WebP del CDN propio; `og:description` → sinopsis.
- Géneros: `<ul class="gn"><li><a href="./animes?genero=...">Acción</a>...`.
- **Episodios generados por JS** (no hay enlaces estáticos): el HTML trae
  ```js
  var eps = ["500","499","498",...];
  ```
  junto a los atributos `data-sl="naruto-shippuden"`, `data-zr="1"` (inicio), `data-ep="500"` (total). El JS construye `./ver/${sl}-${epn}`. El adaptador reconstruye estas URLs server-side sin navegador.

### 1.3 Página de episodio + ofuscación de video (núcleo del plan)
Estructura capturada de `/ver/naruto-shippuden-1`:
```html
<ul class="opt" data-encrypt="3830342d31"></ul>   <!-- VACÍO -->
<div class="ply"><div class="play"></div></div>
```
El JS del sitio hace:
```js
ajax({acc:'opt',' i': $('.opt').data('encrypt')}, function(d){ $('.opt').append(d); ... });
// ajax = $.post('./process', o)
$('.ply').html('<iframe src="'+hex2a(e.attr('encrypt'))+'" ...>');
```
Hallazgos verificados con curl:
1. La página tiene `<base href="https://wwv.veranimes.net/">`, por lo que `./process` resuelve al **origen**: `POST https://wwv.veranimes.net/process`. (POST a `/ver/process` o `/ver/{slug}/process` → 404, comprobado.)
2. `POST /process` con body `acc=opt&i=3830342d31` (+ `Referer` y `X-Requested-With: XMLHttpRequest`) devuelve los botones reales:
   ```html
   <li encrypt="68747470733a2f2f6871712e61632f652f61525554387376534d397363" title="Netu"><span>netu 1</span><span>Opción 1</span></li>
   <li encrypt="68747470733a2f2f6d703475706c6f61642e636f6d2f656d6265642d3137736677336a333763306f2e68746d6c" title="Mp4upload"><span>mp4upload 1</span><span>Opción 6</span></li>
   ```
3. La ofuscación es **hexadecimal** (`hex2a`), decodificada y confirmada:
   - `6874...9363` → `https://hqq.ac/e/aRUT8svSM9sc`
   - `6874...6d6c` → `https://mp4upload.com/embed-17sfw3j37c0o.html`
   - `data-encrypt="3830342d31"` → `"804-1"` (ID interno de episodio).
4. Extra: el atributo `data-dwn='[["mp4upload",0,"https:\/\/www.mp4upload.com\/17sfw3j37c0o"]]'` contiene URLs de descarga reales (fuente secundaria potencial).
5. Sin Cloudflare ni bloqueos: todo respondió con fetch/curl plano.

**Nota sobre el requisito `data-video`:** el prompt describe botones `<li>`/`<button>` con `data-video="url"`. El sitio real usa el mismo patrón pero con el atributo `encrypt` (URL en hex). El adaptador soporta **ambos**: `data-video` (plana o Base64) y `encrypt` (hex), según se documenta en `decodeDataVideoButtons()`.

---

## 2. Implementación

`VerAnimesAdapter extends BaseScraperAdapter` (NO registrado aún en `ScraperManager.ts` — fuera del alcance de este agente):

| Método | Función |
|---|---|
| `canHandle(url)` | Detecta dominios `veranimes.net` (cualquier subdominio) |
| `search(query)` | Búsqueda vía `/animes?buscar=` |
| `extractCatalogItems(html)` | Selector `<article>`; imagen lazy `data-src` (ignora placeholders del CDN), título h3→alt→title→slug, `kind="anime"` |
| `extractMetadata(html, url)` | og:title (limpia sufijo `- VerAnime`), og:image, og:description, géneros `.gn li a`, año por regex |
| `extractEpisodes(html, baseUrl)` | Reconstruye `var eps=[...]` + `data-sl` → `/ver/{sl}-{ep}`; fallback a enlaces estáticos `/ver/`; deduplicados y ordenados |
| `decodeDataVideoButtons(html)` | Localiza `[data-video], [encrypt]`; decodifica URL plana, `//`, hexadecimal (`hexToAscii`, equivalente de `hex2a`) o Base64 |
| `resolveServerButtons(episodeUrl)` | [Extra] Obtiene los botones reales: lee `data-encrypt` de la página → `POST {origin}/process {acc=opt, i=...}` → decodifica |
| `analyze(input, type)` | Modo catálogo (`/`, `/animes*`), episodio (`/ver/*` → `direct_stream`) o detalle (`/anime/*`) |
| `extractStream(url)` | Botones → iframes → `EmbedResolvers.resolve()` en paralelo → prioriza `.m3u8/.mp4` directos → `MediaValidator.validateUrls()` |

Fallback: si no hay botones/iframes, delega en `BaseScraperAdapter.extractStream` genérico.

---

## 3. Prueba real — salida EXACTA de terminal

Comando: `npx tsx test_veranimes.ts` (ejecutado físicamente; pasó a la primera iteración).

```
=== TEST 0: canHandle ===
veranimes.net:      true
www.veranimes.net:  true
otro dominio:       false

=== PASO 1: Búsqueda de 'naruto' en wwv.veranimes.net ===
Resultados encontrados: 20
  - Naruto Shippuden Especial ~Madara vs Hashirama~ -> https://wwv.veranimes.net/anime/naruto-shippuden-especial-madara-vs-hashirama
    img: https://wwv.veranimes.net/cdn/img/anime/naruto-shippuden-especial-madara-vs-hashirama.webp?t=0.1
  - Naruto Shippuden: Naruto X Uniqlo -> https://wwv.veranimes.net/anime/naruto-shippuden-naruto-x-uniqlo
    img: https://wwv.veranimes.net/cdn/img/anime/naruto-shippuden-naruto-x-uniqlo.webp?t=0.1
  - Naruto Ovas -> https://wwv.veranimes.net/anime/naruto-ovas
    img: https://wwv.veranimes.net/cdn/img/anime/naruto-ovas.webp?t=0.1
  - Naruto Shippuden Sunny Side Battle Jump Festa Special -> https://wwv.veranimes.net/anime/naruto-shippuden-sunny-side-battle-jump-festa-special
    img: https://wwv.veranimes.net/cdn/img/anime/naruto-shippuden-sunny-side-battle-jump-festa-special.webp?t=0.1
  - Naruto: Honoo no Chuunin Shiken! Naruto vs. Konohamaru!! -> https://wwv.veranimes.net/anime/naruto-honoo-no-chuunin-shiken-naruto-vs-konohamaru
    img: https://wwv.veranimes.net/cdn/img/anime/naruto-honoo-no-chuunin-shiken-naruto-vs-konohamaru.webp?t=0.1

=== PASO 2: Análisis de detalles de "Naruto Shippuden Especial ~Madara vs Hashirama~" ===
Título:        Ver Naruto Shippuden Especial ~Madara vs Hashirama~ Anime Online Gratis
Descripción:   ver online Naruto Shippuden Especial ~Madara vs Hashirama~ en HD, Naruto Shippuden Especial ~Madara vs Hashirama~ ver ep...
Poster:        https://wwv.veranimes.net/cdn/img/anime/naruto-shippuden-especial-madara-vs-hashirama.webp?t=1
Año:           2012
Tipo:          anime
Géneros:       Aventura, Comedia, Drama, Acción, Sobrenatural, Shōnen
Episodios:     1
  Primer episodio: #1 - Episodio 1
    URL: https://wwv.veranimes.net/ver/naruto-shippuden-especial-madara-vs-hashirama-1
  Último episodio: #1 - Episodio 1

=== PASO 3: Extracción de iframes del episodio 1 ===
Página del episodio: https://wwv.veranimes.net/ver/naruto-shippuden-especial-madara-vs-hashirama-1
Iframes/botones decodificados (2):
  * https://streamwish.to/e/4xnq3jx83p1y
  * https://hqq.ac/e/Ed4FwVg7mucG

=== PASO 4: extractStream + EmbedResolvers + MediaValidator ===

--- RESULTADO ---
STREAM PRINCIPAL: https://4fw4gd.cfglobalcdn.com/secip/1/861rQM940fF8R1fZDCdglg/OTQuMjUuMTcwLjI2/1606597200/hls-vod-s03/flv/api/files/videos/2018/08/01/153311550983uua.mp4.m3u8
Título:           Ver Naruto Shippuden Especial ~Madara vs Hashirama~ episodio 1 Online Gratis

Todos los streams disponibles (3):
  * [DIRECTO] https://4fw4gd.cfglobalcdn.com/secip/1/861rQM940fF8R1fZDCdglg/OTQuMjUuMTcwLjI2/1606597200/hls-vod-s03/flv/api/files/videos/2018/08/01/153311550983uua.mp4.m3u8
  * [embed] https://streamwish.to/e/4xnq3jx83p1y
  * [embed] https://hqq.ac/e/Ed4FwVg7mucG

¿Stream directo (.m3u8/.mp4)?: SÍ ✔
¿URL compatible con reproductor (http/s)?: SÍ ✔

=== PASO 5: TESTS MOCK (sin red) ===

[MOCK 5a] data-video plano (<li> y <button>): 3 URLs
  * https://mp4upload.com/embed-17sfw3j37c0o.html
  * https://voe.sx/e/tckfxspyiugu
  * https://streamtape.com/e/abc123

[MOCK 5b] encrypt hex + data-video base64: 3 URLs
  * https://hqq.ac/e/aRUT8svSM9sc
  * https://mp4upload.com/embed-17sfw3j37c0o.html
  * https://filemoon.sx/e/3croi65s9ptr

[MOCK 5c] Catálogo <article>: 2 items
  - Naruto Shippuden | kind=anime | img=https://wwv.veranimes.net/cdn/img/anime/naruto-shippuden.webp?t=0.1
    url: https://wwv.veranimes.net/anime/naruto-shippuden
  - Koko wa Ore | kind=anime | img=https://wwv.veranimes.net/cdn/img/portada/koko-wa-ore.webp?v=0.1
    url: https://wwv.veranimes.net/ver/koko-wa-ore-8

[MOCK 5d] Episodios desde var eps + data-sl: 3
  - #1 Episodio 1 -> https://wwv.veranimes.net/ver/naruto-shippuden-1
  - #2 Episodio 2 -> https://wwv.veranimes.net/ver/naruto-shippuden-2
  - #3 Episodio 3 -> https://wwv.veranimes.net/ver/naruto-shippuden-3

[MOCK 5e] Metadatos og:
  title:       Ver Naruto Shippuden Anime Online Gratis
  poster:      https://wwv.veranimes.net/cdn/img/anime/naruto-shippuden.webp?t=1
  description: Pasados dos años y medio de entrenamiento con jiraiya......
  genres:      Acción, Shounen

TEST COMPLETADO ✔
```

*(Nota: el `.m3u8` de cfglobalcdn contiene un token firmado temporal; entre corridas puede variar. Los embeds crudos streamwish/hqq se conservan como alternativa.)*

---

## 4. Hallazgos críticos

1. **La ofuscación real NO es `data-video` sino `encrypt` (hexadecimal).** El flujo completo requiere imitar al JS del sitio: leer `data-encrypt` del `<ul class="opt">` vacío → `POST {origin}/process` con `acc=opt&i={id}` → decodificar cada atributo `encrypt` de los `<li>` con hex→ASCII. Resuelto server-side sin Playwright.
2. **El `<base href>` es obligatorio para ubicar `/process`:** sin él, `./process` parecería relativo a `/ver/` y da 404 (comprobado con curl contra 3 rutas candidatas).
3. **Los episodios no existen como HTML:** se generan desde `var eps=[...]` + `data-sl`. El adaptador los reconstruye determinísticamente (500 episodios de Naruto Shippuden accesibles sin navegador).
4. **Stream directo real obtenido:** StreamWish (`streamwish.to`) fue resuelto por `EmbedResolvers.resolvePackedEmbed` hasta un `.m3u8` de `cfglobalcdn.com`, validado por `MediaValidator` (host conocido + patrón HLS). `hqq.ac` (Netu) queda como embed alternativo (requiere navegador, igual que en LatAnime).
5. **Sin Cloudflare:** todas las peticiones (home, búsqueda, detalle, episodio, POST /process) funcionaron con `fetch` plano y User-Agent estándar.

## 5. Verificaciones de calidad (reales)

| Verificación | Comando | Resultado |
|---|---|---|
| Integración E2E + mocks | `npx tsx test_veranimes.ts` | ✅ TEST COMPLETADO ✔ (pasó a la primera; asserts 5a–5e sin fallos) |
| Typecheck | `npx tsc --noEmit` | ✅ Sin errores (sin salida) |

## 6. Estado y alcance

- Creados: `server/scrapers/adapters/VerAnimesAdapter.ts`, `test_veranimes.ts`, `informes/VerAnimes.md`.
- **NO tocado** (según instrucciones): `ScraperManager.ts` y adaptadores de otros agentes. **El adaptador aún no está registrado en `ScraperManager.ts`** — el líder debe añadir import + registro al integrar.

## 7. Recomendaciones futuras

1. Registrar el adaptador en `ScraperManager.ts` durante la integración (único paso pendiente para producción).
2. `hqq.ac` (Netu) requiere navegador headless para resolverse; si se necesita su stream directo, replicar la estrategia Playwright+cache ya recomendada para VOE/Filemoon en LatAnime.
3. Los tokens del `.m3u8` (cfglobalcdn) son temporales: el diseño Just-In-Time actual (resolver en cada reproducción) ya lo contempla.
4. Si el sitio cambia `acc=opt` u oculta el ID tras otra capa, el punto único a revisar es `postProcessEndpoint()` + `decodeDataVideoButtons()`.
