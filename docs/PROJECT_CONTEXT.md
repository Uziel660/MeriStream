# MeriStream: Contexto del proyecto

> ⚠️ **ACTUALIZACIÓN 2026-08-25**: las secciones 1-8 de este documento fueron
> REESCRITAS — describían el prototipo histórico Python/FastAPI que ya no existe.
> El stack real es Node.js (Express + TypeScript + Prisma/PostgreSQL) + React 18.
> Referencia completa viva: `README.md` y `docs/INFORME_SESION_2026-08-25.md`.
> Las secciones 9+ (investigación de extensiones Kohi-den/Aniyomi, patrones de
> scraping, propuesta de mega-adaptador) siguen vigentes como material de referencia.

## 1. Objetivo

Plataforma personal de streaming: catálogo multimedia con reproductor HLS/Embed
propio, ingesta universal multi-plataforma (scrapers dedicados por sitio),
metadatos automáticos en español (TMDB/AniList/MAL/TVMaze) y panel de
administración exclusivo en `/admin` con login.

## 2. Estructura principal actual

### Frontend (React 18 + Vite + Tailwind)

- `src/App.tsx`: catálogo, modales y vistas principales.
- `src/main.tsx`: enruta `/admin` → `AdminGate` (login + panel); el resto → App.
- `src/components/HLSPlayerModal.tsx`: reproductor HLS/Embed con selector premium por plataforma, resolución multi-plataforma (hasta 3 fuentes en paralelo), auto-advance en fallo de embed.
- `src/components/AdminPanel.tsx`: panel de administración (ingesta, workers, verificación, fuentes, catálogo, stream tester).
- `src/components/VerificationPanel.tsx`: verificación automática programable + pipeline paso a paso (8 pasos configurables).
- `src/components/ShowEditModal.tsx`: editor completo de obras + refresh de streams + plataformas disponibles.
- `src/components/WorkerSettingsCard.tsx`: ajustes de worker en vivo + alertas anti-bot.
- `src/utils/proxiedUrl.ts` + `src/utils/streamOptimizer.ts`: URLs del proxy (relativas) y ranking de servidores.
- `src/api/client.ts`: cliente fetch centralizado (`/api/v1`, rutas relativas).

### Backend (Node.js + Express + TypeScript + Prisma/SQLite)

- `server.ts`: servidor unificado (API + SPA vía Vite middleware), puerto de `app.config.ts`. Incluye: pipeline de verificación (`/api/v1/verify/pipeline`), resolución multi-plataforma (hasta 3 fuentes adicionales en paralelo), CDN hostname normalization.
- `app.config.ts`: **única fuente de verdad** de host/puerto/CORS (incluye túneles cloudflared).
- `server/taskWorker.ts`: workers paralelos multi-catálogo (pipeline productor-consumidor, índice de re-escaneo ligero, anti-bot, paginación por sitio).
- `server/verificationWorker.ts`: verificación automática programable (metadatos + novedades por plataforma, timer persistente) + pipeline paso a paso (`/api/v1/verify/pipeline`).
- `server/showService.ts`: dedup por clave canónica, fusión de secuelas por TMDB, editor de obras, sync multi-fuente.
- `server/reconcileCatalog.ts`: reconciliación de secuelas ya guardadas (dry-run + guardas de similitud) y fusión manual.
- `server/metadataBackfill.ts`: completado/reparación de metadatos (descripciones truncadas, títulos con ruido) con write-buffer.
- `server/writeBuffer.ts`: outbox JSONL para escrituras diferidas cuando la PostgreSQL está saturada.
- `server/metadataEngine.ts`: cascada TMDB es-MX → AniList → Jikan → TVMaze, traducción, géneros en español.
- `server/hostProfiles.ts`: perfiles de cabeceras por CDN (vimeos, goodstream, playmudos, etc.).
- `server/scrapers/adapters/*`: adaptadores por sitio (AnimeFLV, LaMovie, Cinecalidad, TioAnime, TioPlus, LatAnime, VerAnimes, TubePelis, Archive…).
- `server/utils/titleNormalizer.ts`: normalización de títulos, claves canónicas, guard anti-basura.
- `server/utils/antiBot.ts`: detección Cloudflare/anti-bot + registro por host.
- `prisma/schema.prisma`: Show, Episode, MediaItem, MediaEpisode, SourceLink, CrawlTask, WorkerSettingsStore.

## 3. Cómo se ejecuta

```bash
npm install
npx prisma generate
npm run dev        # servidor unificado (API + SPA) en el puerto de app.config.ts (3000)
```

- App principal: `http://localhost:3000/`
- Panel admin: `http://localhost:3000/admin` (login: `ADMIN_USER`/`ADMIN_PASS` de `.env`)
- Acceso externo: túnel `cloudflared tunnel --url http://localhost:3000` (URL a CORS en `app.config.ts`).

## 8. Problemas encontrados y correcciones (HISTÓRICO — prototipo Python)

> Las notas de esta sección corresponden al prototipo histórico Python/FastAPI.
> Se conservan como lecciones aprendidas; los problemas equivalentes del stack
> actual (Node/Express/Prisma) están documentados en `README.md` y en
> `docs/INFORME_SESION_2026-08-24_PARTE3.md`.

### Autoplay del reproductor

El reproductor intentaba reproducir con audio y los navegadores bloqueaban el autoplay. Se corrigió con:

- Autoplay silenciado.
- Inicio tras `canplay`.
- Botón manual de reproducción.
- Mensajes visibles de carga y error.

### URLs MP4 de prueba

Algunas URLs de Google Storage usadas como demo devolvían HTTP 403. Se sustituyeron algunas por fuentes públicas verificadas de W3:

```text
https://media.w3.org/2010/05/sintel/trailer.mp4
https://media.w3.org/2010/05/bunny/trailer.mp4
```

### Failed to fetch

El panel usaba `http://localhost:8000` directamente. En puertos reenviados de VS Code fallaba. Se corrigió usando `/api/v1` relativo y proxy Vite.

### Playwright sin navegador

Playwright estaba instalado, pero faltaban Chromium y librerías Linux. Se solucionó con:

```bash
python -m playwright install chromium
python -m playwright install-deps chromium
```

### Tareas eternamente en running

Las tareas lanzadas en versiones antiguas quedaban en `running` al reiniciar Uvicorn. El lifespan del backend debe marcar tareas `pending` o `running` como interrumpidas al arrancar.

### Contadores engañosos

Antes, `items_processed` solo aumentaba al guardar un vídeo. Eso provocaba `0 de 50` durante todo el proceso aunque sí se estuvieran revisando páginas. El texto del panel debe decir “páginas revisadas” y el contador debe avanzar por cada resultado terminado.

### Completed con cero importados

Una tarea que descubre páginas pero no importa ningún stream no debe considerarse éxito. Debe terminar como `failed` con un mensaje como:

```text
Se revisaron N páginas, pero ninguna contenía un vídeo MP4/HLS reproducible.
```

## 9. Resultados de pruebas reales

### AnimeFLV

Se encontraron 50 enlaces, pero se importaron 0. Las páginas no expusieron MP4/HLS directo detectable por el crawler. Esto demuestra que descubrir fichas no equivale a encontrar streams reproducibles.

### Blender Studio

Se descubrieron páginas del dominio. Algunas páginas de proyecto sí llegaron a exponer un HLS real, por ejemplo un manifiesto bajo `video.blender.org`. Otras páginas eran navegación, training, login o secciones sin vídeo.

La fuente tiene contenido público/CC-BY según el proyecto y es mejor candidata para validar el crawler.

### Internet Archive

La API oficial devuelve resultados de colecciones y es la vía más fiable para esa fuente. Sin embargo, el usuario también quiere probar Playwright explícitamente. El sistema debe respetar la estrategia elegida:

- `api`: usar Advanced Search y luego procesar páginas de resultados.
- `playwright`: abrir páginas y observar DOM/red, aunque tarde.

## 10. Repositorio Kohi-den/extensions-source

Repositorio analizado:

```text
https://github.com/Kohi-den/extensions-source/tree/main
```

Revisión consultada:

```text
00aacef360ad8b25388c99e88ca2e4f3e8e24075
```

Tiene licencia Apache 2.0.

No es una base de datos de vídeos. Es código fuente de extensiones Android/Kotlin para Aniyomi y forks.

Estructura conceptual:

```text
src/             extensiones específicas por fuente
lib/             extractores y librerías compartidas
lib-multisrc/    bases para webs con estructuras similares
.github/         workflows y generación de APKs
repo/apk/        APKs publicados
index.min.json   índice de APKs y metadatos de extensiones
```

El `index.min.json` describe las extensiones, no contiene directamente todos los vídeos. Las extensiones implementan operaciones como:

- Buscar títulos.
- Obtener detalles.
- Obtener episodios.
- Resolver reproductores.
- Obtener calidades.
- Obtener subtítulos.

El repositorio usa adaptadores específicos por fuente y librerías de extractores para reproductores externos.

## 11. Investigación de AnimePahe

Se revisó la extensión AnimePahe del repositorio y su dominio configurado `https://animepahe.pw`.

Una petición HTTP normal respondió:

```text
HTTP 403
server: cloudflare
cf-mitigated: challenge
```

También devolvió CSP y recursos relacionados con `challenges.cloudflare.com`.

La extensión contiene:

- `DdosGuardInterceptor`.
- `CloudflareBypass` basado en WebView Android.
- JavaScript y DOM storage.
- Cookies de sesión.
- User-Agent asociado a la sesión.
- Reintentos ante 403/419.
- Resolución de un reproductor externo Kwik.
- Detección de listas HLS.

Esto demuestra que algunas fuentes no son solucionables con selectores CSS genéricos. Requieren lógica específica, sesiones de navegador y reproductores externos.

backend debe intentar Cloudflare, CAPTCHA, DRM, login o protecciones de terceros. El extaactor debe detectarlo y cambiar a meotdos correspondientes

## 12. Propuesta: mega-adaptador propio

La meta es no depender completamente de adaptadores públicos, pero sí aprender de sus patrones.

Arquitectura recomendada:

```text
UniversalBrowserExtractor
        |
        v
PageObservation
        |
        +--> reglas deterministas
        |
        +--> IA para generar un plan estructurado
        |
        v
PlanExecutor con acciones permitidas
        |
        v
StreamValidator
        |
        v
DomainMemory
        |
        v
Catálogo
```

### UniversalBrowserExtractor

Observa de forma pasiva:

- HTML renderizado.
- DOM.
- `<video>` y `<source>`.
- `<track>`.
- iframes.
- OpenGraph y JSON-LD.
- URLs de red.
- `.mp4`, `.m3u8`, `.mpd`, `.vtt`, `.srt`.

### PageObservation

Debe crear un resumen seguro y limitado:

```json
{
  "url": "https://example.org/title",
  "title_candidates": [],
  "video_elements": [],
  "iframes": [],
  "network_urls": [],
  "links": [],
  "protection_signals": []
}
```

### ExtractionPlan

La IA puede proponer acciones permitidas, no código arbitrario:

```json
{
  "title_selector": "h1.entry-title",
  "poster_selector": "meta[property='og:image']",
  "episode_selector": ".episodes a",
  "video_strategy": "inspect_iframes_and_network",
  "subtitle_patterns": [".vtt", ".srt"],
  "confidence": 0.84
}
```

Acciones permitidas:

```text
click_selector
follow_link
inspect_iframe
read_attribute
watch_network
extract_json
wait_for_selector
otras que sean pertinentes
```

### DomainMemory

Cuando un plan funciona, se guarda por dominio:

```json
{
  "domain": "studio.blender.org",
  "version": 1,
  "catalog_links": "a[href*='/projects/']",
  "title_selector": "h1",
  "poster_selector": "meta[property='og:image']",
  "video_detection": "network",
  "subtitle_detection": "track, network:.vtt",
  "confidence": 0.96
}
```

La IA se usaría para descubrimiento inicial y reparación de planes, no necesariamente en cada ejecución.

## 13. Uso de listas públicas de Aniyomi

Podemos leer un índice público como `index.min.json` para obtener:

- Nombre de extensión.
- Idioma.
- Versión.
- Paquete.
- APK.
- Icono.
- Fecha de actualización.

Pero el índice no contiene por sí mismo la lógica de scraping ni los vídeos. La lógica está dentro de cada extensión Kotlin/Android.

Se puede usar el repositorio como:

- Referencia de patrones.
- Fuente de dominios conocidos.
- Catálogo de extractores.
- Inspiración para adaptadores propios.
- Datos de prueba.

No conviene ejecutar APKs arbitrarios ni traducir automáticamente todo el código Kotlin a Python. Hay dependencias de Android, WebView, librerías internas, cifrado y APIs específicas.

## 14. Recomendación de siguientes pasos

1. Añadir una cola global de tareas para impedir varios scrapers grandes simultáneos.
2. Añadir un botón de cancelación.
3. Compartir un navegador/contexto controlado por tarea en lugar de crear un navegador completo por página.
4. Separar claramente `enlaces descubiertos`, `páginas revisadas` y `vídeos importados`.
5. Crear `PageObservation` y señales de protección.
6. Crear `ExtractionPlan` validado con Pydantic.
7. Implementar `StreamValidator` para HTTP/MIME/rangos.
8. Añadir memoria de planes por dominio.
9. Añadir importador de índices públicos como herramienta informativa, no como ejecutor de APKs.
10. Crear primero adaptadores propios para fuentes públicas y autorizadas como Internet Archive y Blender Studio.
11. Añadir autenticación real al panel admin.
12. Añadir pruebas de integración con páginas de prueba controladas.

## 15. Principio de legalidad y seguridad

El sistema debe trabajar solo con contenido público, de dominio público, Creative Commons o contenido para el que exista autorización de indexación y reproducción.

El sistema puede detectar protecciones y reportarlas, pero no debe intentar evadir:

- DRM.
- CAPTCHA.
- Cloudflare challenge.
- DDoS-Guard.
- Login o suscripciones.
- URLs firmadas protegidas.
- Restricciones técnicas o contractuales de una fuente.

## 16. Análisis adicional de cinco extensiones

Se analizaron cinco extensiones más de `Kohi-den/extensions-source`:

- `AnimeUnity`.
- `AnimeSaturn`.
- `MyAnime`.
- `AllAnime`.
- `AnimeFLV`.

### AnimeUnity: CSRF, cookies y API híbrida

AnimeUnity combina HTML y API. Primero carga una página de archivo, obtiene un token CSRF y cookies de sesión, y después realiza un `POST` JSON con filtros y cabeceras como `Origin`, `Referer`, `X-CSRF-TOKEN` y `X-Requested-With`.

Patrón:

```text
GET página inicial
        -> CSRF + cookies
        -> POST JSON
        -> resultados estructurados
```

El mega-adaptador debe poder observar peticiones XHR/fetch, detectar tokens CSRF y conservar una sesión legítima durante una ejecución autorizada.

### AnimeSaturn: dominios alternativos y HLS

AnimeSaturn soporta dominios distintos con perfiles de selectores diferentes. El flujo obtiene episodios, sigue una página `watch`, detecta `jwplayer` o `<source>`, descarga un manifiesto HLS y extrae sus variantes mediante `RESOLUTION`.

Patrón:

```text
catálogo -> detalles -> episodios -> /watch -> playlist.m3u8 -> calidades
```

Las calidades deben derivarse del manifiesto real y no de valores simulados.

### MyAnime: infinite scroll e iframes

MyAnime detecta paginación mediante scripts de infinite scroll, busca episodios en diferentes estructuras y puede encontrar un `iframe.youtube-player`.

Los iframes se clasifican por proveedor:

```text
YouTube
Dailymotion
OK.ru
Gdriveplayer
```

Patrón:

```text
fuente principal -> iframe externo -> extractor del proveedor
```

El modelo de datos debe conservar el proveedor y la URL embed, no solo una URL final sin contexto.

### AllAnime: GraphQL

AllAnime utiliza consultas GraphQL para popular, novedades, búsqueda, filtros, detalles y episodios. Envía `query` y `variables` en peticiones POST y usa identificadores internos para enlazar las operaciones.

Patrón:

```text
POST GraphQL(query, variables) -> respuesta tipada
```

Cuando una fuente ofrece GraphQL o una API pública/estable, debe preferirse una estrategia de API frente al scraping de HTML.

### AnimeFLV: JavaScript inline y servidores

AnimeFLV guarda información de episodios en variables JavaScript embebidas como `anime_info` y `episodes`. La información de servidores aparece en otra estructura JavaScript (`videos`).

Cada servidor se entrega a un extractor distinto, como StreamTape, OK.ru, YourUpload, StreamWish o un extractor universal.

Patrón:

```text
HTML -> script inline -> episodios
HTML -> objeto JS -> servidores
servidor -> extractor específico
```

El mega-adaptador debe inspeccionar scripts inline y objetos JSON además de etiquetas visibles.

## 17. Patrones consolidados del repositorio

Después de analizar diez extensiones, el contrato común queda así:

```text
catalog()
search()
details()
episodes()
streams()
subtitles()
```

Las implementaciones varían entre:

- HTML y selectores CSS.
- JSON REST.
- GraphQL.
- AJAX con CSRF.
- JavaScript inline.
- Iframes externos.
- Peticiones de red HLS.
- Extractores por proveedor.

La arquitectura recomendada para Nitiflix es un núcleo universal con estrategias intercambiables:

```text
UniversalDiscovery
        +-- HtmlStrategy
        +-- JsonStrategy
        +-- GraphQLStrategy
        +-- InlineScriptStrategy
        +-- AjaxStrategy
        +-- IframeStrategy
        +-- NetworkStreamStrategy
        +-- ProviderResolvers
```

## 18. Plan de extracción seguro

La IA puede clasificar una observación de página:

```json
{
        "catalog_type": "html_with_inline_json",
        "details_type": "html",
        "episode_type": "inline_script",
        "video_type": "external_iframe",
        "providers": ["youtube", "okru"],
        "confidence": 0.91
}
```

Después puede generar un plan limitado a acciones conocidas:

```text
GET
POST JSON
leer selector
leer atributo
parsear JSON
seguir iframe
observar red
validar MIME
otras que sean convenientes
```

No debe ejecutar código arbitrario generado por la IA ni ejecutar APKs de terceros a menos que se evalue qeu se puede.

## 19. Expectativas de automatización

Estimación orientativa:

```text
60-80% automático: webs HTML/API sencillas
40-60% asistido: AJAX, iframes y varios reproductores
0-20% automático: DRM, CAPTCHA, login o protecciones fuertes
```

La IA debería ayudar a generar y reparar planes, pero una vez validado el plan conviene guardarlo por dominio y ejecutar reglas deterministas. Así el sistema no depende de llamar a la IA en cada página.

## 20. Nuevos siguientes pasos

1. Añadir observación de `fetch`/XHR y GraphQL.
2. Extraer JSON de scripts inline.
3. Detectar CSRF y cookies sin intentar superar desafíos anti-bot.
4. Modelar proveedores externos como resolvers reutilizables.
5. Guardar calidades HLS reales desde el manifiesto.
6. Guardar idioma, servidor, calidad y proveedor en cada stream.
7. Crear planes versionados por dominio.
8. Añadir validación de planes y límite de acciones.
9. Añadir pruebas con páginas legales y controladas.
