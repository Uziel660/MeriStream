# Informe de Implementación: Adaptador LatAnime.org

| Campo | Valor |
|---|---|
| **Fecha** | 2026-08-21 |
| **Adaptador** | `LatAnimeAdapter` (`server/scrapers/adapters/LatAnimeAdapter.ts`) |
| **Commit** | `9072d4e` — `feat(latanime): add adapter with base64 data-player stream resolution and verified integration test` |
| **Script de prueba** | `test_latanime.ts` (raíz del proyecto) |
| **Resultado final** | ✅ Stream directo real obtenido y verificado en terminal |

---

## 1. Investigación técnica del sitio (verificada con curl, no asumida)

Todas las estructuras fueron sondeadas físicamente contra `https://latanime.org` antes de programar:

### 1.1 Búsqueda
- El formulario del Home apunta a `action="https://latanime.org/buscar"` con input `name="q"` (método GET).
- Endpoint verificado: `GET https://latanime.org/buscar?q=mushoku+tensei` → HTTP 200.
- Las cards de resultado tienen la estructura:
  ```html
  <a href="https://latanime.org/anime/<slug>">
    <div class="series">
      <div class="serieimg"><img src="..." alt=""></div>
      <div class="seriedetails">
        <h3>Título del anime</h3>
        <span>Latino</span><span>...2023</span>  <!-- año tras el ícono -->
      </div>
    </div>
  </a>
  ```

### 1.2 Catálogo (Home)
- Enlaces: `a[href^="https://latanime.org/anime/"]` (confirmado, coincide con el plan).
- Imágenes con lazy-load `lozad`: la URL real está en `data-src`; `src` es placeholder (`capblank.png`).

### 1.3 Página de detalle
- `og:title` → `"Mushoku Tensei: Isekai Ittara Honki Dasu S1 Latino - Latanime"` (sufijo variable `-` o `—`).
- `og:image` → poster real (`/assets/img/serie/imagen/<slug>-<timestamp>.jpg`).
- `og:description` → sinopsis truncada.
- Episodios: enlaces `a[href*="/ver/"]` con formato `<slug>-episodio-N`, texto `"… - Capitulo N"`.
- El HTML inicial expone un subconjunto paginado (24 enlaces únicos observados en S1 Latino).

### 1.4 Página de episodio (data-player Base64) — núcleo del plan
Atributos reales capturados del episodio 1 de S1 Latino:
```
data-player="aHR0cHM6Ly9maWxlbW9vbi5zeC9lLzNjcm9pNjVzOXB0cg=="   → https://filemoon.sx/e/3croi65s9ptr
data-player="aHR0cHM6Ly9kb29kc3RyZWFtLmNvbS9lL2g5d3VhOXZuZXZ1cQ==" → https://doodstream.com/e/h9wua9vnevuq
data-player="aHR0cHM6Ly92b2Uuc3gvZS90Y2tmeHNweWl1Z3U="           → https://voe.sx/e/tckfxspyiugu
data-player="aHR0cHM6Ly93d3cubXA0dXBsb2FkLmNvbS9lbWJlZC11aGtwaXA4cXpobG4uaHRtbA==" → https://www.mp4upload.com/embed-hukpip8qzhln.html
```
**Confirmado:** LatAnime NO ofusca con JS complejo; los iframes van en Base64 plano dentro de `data-player`. La decodificación es `Buffer.from(valor, "base64").toString("utf-8")`.

---

## 2. Implementación

`LatAnimeAdapter extends BaseScraperAdapter` (registrado en `ScraperManager.ts`):

| Método | Función |
|---|---|
| `canHandle(url)` | Detecta dominios `latanime.org` |
| `search(query)` | **[Nuevo, fuera del plan original]** Búsqueda vía `/buscar?q=` |
| `extractCatalogItems(html)` | Cards del Home/búsqueda: título (h3 → alt → slug), imagen lazy, año |
| `extractMetadata(html, url)` | OpenGraph + `.sinopsis`/`p.text-sm`/`p.description`; limpia sufijo `[-–—] Latanime` del título |
| `extractEpisodes(html, baseUrl)` | Enlaces `/ver/`, número desde `-episodio-(\d+)`, deduplicados y ordenados |
| `decodeDataPlayers(html)` | Decodifica Base64 de `[data-player]` → URLs de iframe |
| `analyze(input, type)` | Modo catálogo (Home) vs detalle; opcionalmente resuelve streams |
| `extractStream(url)` | Decodifica data-players → resuelve en paralelo con `EmbedResolvers.resolve()` → prioriza `.m3u8/.mp4` directos como `stream_url`, resto a `all_available_streams` |

Fallback: si no hay `data-player`, delega en `BaseScraperAdapter.extractStream` genérico.

---

## 3. Prueba real — salida EXACTA de terminal

Comando: `npx tsx test_latanime.ts` (ejecutado físicamente, dos corridas, ambas exitosas).

```
=== PASO 1: Búsqueda de 'Mushoku Tensei' en latanime.org ===
Resultados encontrados: 6
  - [2026] Mushoku Tensei Jobless Reincarnation S3 Castellano -> https://latanime.org/anime/mushoku-tensei-jobless-reincarnation-s3-castellano
  - [2026] Mushoku Tensei Jobless Reincarnation S3 Latino -> https://latanime.org/anime/mushoku-tensei-jobless-reincarnation-temporada-3
  - [2023] Mushoku Tensei II: Isekai Ittara Honki Dasu S2 Castellano -> https://latanime.org/anime/mushoku-tensei-ii-isekai-ittara-honki-dasu-s2-castellano
  - [2023] Mushoku Tensei II: Isekai Ittara Honki Dasu S2 Latino -> https://latanime.org/anime/mushoku-tensei-ii-isekai-ittara-honki-dasu-s2-latino
  - [2021] Mushoku Tensei: Isekai Ittara Honki Dasu S1 Castellano -> https://latanime.org/anime/mushoku-tensei-isekai-ittara-honki-dasu-s1-castellano

=== PASO 2: Análisis de detalles de "Mushoku Tensei Jobless Reincarnation S3 Latino" ===
Título:        Mushoku Tensei Jobless Reincarnation S3 Latino
Descripción:   Un joven virgen "nini" de 34 años es echado de casa cuando se queda sin dinero. Él se arrepiente de su vida cuando muere...
Poster:        https://latanime.org/assets/img/serie/imagen/mushoku-tensei-jobless-reincarnation-temporada-3-1785082116.webp
Año:           2026
Tipo:          anime
Episodios:     5
  Primer episodio: #1 - Capitulo 1
    URL: https://latanime.org/ver/mushoku-tensei-jobless-reincarnation-temporada-3-episodio-1
  Último episodio: #5 - Capitulo 5

=== PASO 3: Resolución de video del episodio 1 ===
Página del episodio: https://latanime.org/ver/mushoku-tensei-jobless-reincarnation-temporada-3-episodio-1

--- RESULTADO ---
STREAM PRINCIPAL: https://a3.mp4upload.com:183/d/xsxrpjnpz3b4quuo6grq4jsbkgshshzhfkasukanq4ivfe76mjtumglbfoehbcy6ma2f2vqu/video.mp4

Todos los streams disponibles (9):
  * https://a3.mp4upload.com:183/d/xsxrpjnpz3b4quuo6grq4jsbkgshshzhfkasukanq4ivfe76mjtumglbfoehbcy6ma2f2vqu/video.mp4
  * https://dsvplay.com/e/zk47nva48hh8
  * https://bysekoze.com/e/6vd0to1st7s8
  * https://hexload.com/embed-1gagscvws82e
  * https://savefiles.com/e/j8ocx6w9bk7m
  * https://mega.nz/embed/#!7pA0UbqJ!_deJovLXj13dErVoQy0z4VttZPMm2Fi_rTzgRI1-1l4
  * https://mixdrop.top/e/wlnxlme8fn7k8r
  * https://voe.sx/e/e7xp5tas8tqw
  * https://www.mp4upload.com/embed-ttapunnmlb93.html

¿Stream directo (.m3u8/.mp4)?: SÍ ✔

TEST COMPLETADO
```

*(Nota: el token del enlace mp4upload cambia entre corridas — es un enlace firmado temporal; ambas corridas produjeron `.mp4` directos distintos y válidos.)*

---

## 4. Hallazgo crítico: por qué NO se obtuvo `.m3u8`

El plan pedía llegar al `.m3u8` final. El barrido físico por servidor (curl, con Referer de latanime) demostró que **ningún servidor embebido actual expone `.m3u8` en HTML plano**:

| Servidor | Evidencia real | Veredicto |
|---|---|---|
| **mp4upload** | `resolveMp4Upload` desempaqueta su JS y obtiene `.mp4` directo firmado | ✅ **Único resoluble server-side** |
| **VOE** (`voe.sx`) | Responde 751 bytes: redirect JS a dominio rotativo (`johnbeyondnation.com`). Esa página trae blob `<script type="application/json">["DROH*~nJjm%?…"]` cuyo decoder está tras ofuscación obfuscator.io (control-flow flattening). Incluye señuelo `test-videos.co.uk/bigbuckbunny` | ❌ Requiere navegador headless |
| **filemoon.sx / bysekoze.com** | Ambos sirven la misma SPA React "Byse Frontend" (1605 bytes, `<div id="root">`); la fuente se obtiene por API interna desde JS | ❌ Requiere navegador headless |
| **swhoi.com** (StreamWish clone) | `"File is no longer available as it expired or has been deleted"` | ❌ Enlace muerto |
| **luluvdo / mixdrop / listaeamed / dsvplay / hexload / savefiles** | Challenges JS, iframes ocultos o conexión fallida (HTTP 000) | ❌ No resolubles por HTTP plano |

**Conclusión honesta:** el stream directo real que LatAnime ofrece hoy server-side es el `.mp4` de mp4upload (igualmente reproducible). Obtener `.m3u8` de VOE/Filemoon exigiría Playwright/Puppeteer — queda como recomendación, no como defecto del adaptador.

---

## 5. Verificaciones de calidad (reales)

| Verificación | Comando | Resultado |
|---|---|---|
| Typecheck | `npm run lint` (tsc --noEmit) | ✅ Sin errores |
| Suite completa | `npm test` (vitest run) | ✅ **6 archivos, 54/54 tests pasaron** (5.19s) |
| Integración E2E | `npx tsx test_latanime.ts` | ✅ 2/2 corridas exitosas con stream directo |

---

## 6. Estado del repositorio y decisiones

- **Commiteado** (`9072d4e`, alcance limitado): `LatAnimeAdapter.ts`, `ScraperManager.ts` (import + registro), `test_latanime.ts`.
- **Limpieza aprobada por el usuario:** eliminados 9 scripts desechables de la raíz (`test_minimal.js`, `test_simple.js`, `run_latanime_test.mjs`, `test_compiled.mjs`, `test_latanime_cjs.js`, `test_latanime_simple.ts`, `test_lamovie.ts`, `test_lamovie_series.ts`, `test_vimeos.ts`) y artefactos (`.playwright-mcp/`, `cbm/`, `cbm.zip`). Añadido `.playwright-mcp/` al `.gitignore`.
- **Pendiente deliberado (decisión del usuario):** `LaMovieAdapter.ts` tiene una copia de trabajo divergente sin commitear — HEAD tiene `EmbedResolvers`+`MediaValidator`+`cleanQueryTitle`+API `wp-api/v1/single`; la copia de trabajo tiene catálogo por sitemaps. Cada lado tiene features únicas; requiere fusión manual futura.
- **Detectado post-limpieza:** aparecieron sin trackear `TioAnimeAdapter.ts` y `test_tioanime.ts` (posible sesión paralela); no se tocaron.

## 7. Recomendaciones futuras

1. **Streams .m3u8:** integrar resolución headless (Playwright) solo para VOE/Filemoon como último recurso, con cache agresivo (los enlaces firmados expiran).
2. **Paginación de episodios:** el detalle pagina los episodios vía scroll/AJAX; si se requiere el listado completo de animes largos, replicar la petición AJAX de paginación.
3. **Fusionar LaMovieAdapter** (HEAD + sitemaps) antes de cualquier release.
4. Los enlaces mp4upload son temporales: extraer Just-In-Time (el diseño actual ya lo hace así).
