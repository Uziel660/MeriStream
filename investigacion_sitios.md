# Análisis Estructural del DOM y Auditoría de OpenGraph

## 1. JkAnime (jkanime.net)
- **Catálogo (Selector):** `.card`
- **Título / Imagen:**
  - `og:title` presente (Ej: `Otome Kaijuu Caraméliser 8 Sub Español Online gratis — JkAnime`).
  - `og:image` presente (URL absoluta a cdn.jkdesa.com).
- **Sinopsis:** Selector `.sinopsis` / `.description`.
- **Reproductor de Video (Obfuscación):**
  - El video no está directamente en un iframe en el DOM inicial.
  - **Descubrimiento clave:** Utilizan un `<script>` que contiene un array `var video = [];` donde insertan strings de HTML. Ejemplo: `video[0] = '<iframe class="player_conte" src="https://jkanime.net/jkplayer/um?e=..."'`. Las URLs suelen contener hashes en base64 en la querystring.

## 2. AnimeJara (animejara.com)
- **Catálogo (Selector):** `a[href*="/anime/"]` (El sitio parece renderizar mucho contenido dinámicamente o tener rutas muy específicas. En `/catalogo` se encuentran las tarjetas).
- **Título / Imagen:** `og:title` y `og:image` presentes en las páginas de detalle, aunque en algunas subpáginas devuelve "Página no encontrada" por cambios de enrutamiento o bloqueo anti-bot (Cloudflare).
- **Sinopsis:** Selector `.description`.
- **Reproductor de Video (Obfuscación):**
  - Generalmente utiliza iframes embebidos y atributos `data-server` en los botones de selección, que luego inyectan el iframe vía JavaScript.

## 3. TioAnime (tioanime.com)
- **Catálogo (Selector):** `article`
- **Título / Imagen:**
  - `og:title` presente (Ej: `Otome Kaijuu Caraméliser 8 - TioAnime`).
  - `og:image` no siempre expuesto correctamente en la etiqueta estándar o bloqueado.
- **Sinopsis:** Selector `.description` o `p.sinopsis`.
- **Reproductor de Video (Obfuscación):**
  - **Descubrimiento clave:** Utilizan un `<script>` con un array JSON multidimensional llamado `var videos = [...]`.
  - Ejemplo: `var videos = [["Mega","https:\/\/mega.nz\/embed\/..."],["Voe","https:\/\/voe.sx\/e\/..."]];`. Un script posterior (`initEpisode()`) lee este array e inyecta el iframe correspondiente al seleccionar el servidor.

## 4. VerAnimes (wwv.veranimes.net)
- **Catálogo (Selector):** `article`
- **Título / Imagen:**
  - `og:title` presente (Ej: `Ver Otome Kaijuu Caraméliser episodio 8 Online Gratis - VerAnime`).
  - `og:image` presente (URL a cdn local).
- **Sinopsis:** Selector `.description`.
- **Reproductor de Video (Obfuscación):**
  - Similar a TioAnime, ocultan el iframe en el DOM inicial.
  - **Descubrimiento clave:** Tienen un script con arrays de variables, típicamente `var video = [...]` o atributos `data-video` en elementos `li` de una lista de servidores.

## 5. AnimeAV1 (animeav1.com)
- **Catálogo (Selector):** El sitio utiliza `article` o elementos dentro de cuadrículas generadas dinámicamente. Al auditar con scripts puros, los enlaces a los episodios están profundamente ofuscados o requieren paso por Cloudflare, dificultando la extracción directa de la URL del home sin renderizado de navegador.
- **Título / Imagen:** Suelen exponer `og:title` pero el scraping directo falla a menudo sin bypass de CF.
- **Reproductor de Video (Obfuscación):**
  - Ocultan los iframes detrás de iframes anidados o redirecciones. Típicamente usan `data-video` en botones de selección, similar a otros sitios.

## 6. EstrenosAnime (estrenosanime.net)
- **Catálogo (Selector):** `.item` o `.anime-item`.
- **Reproductor de Video (Obfuscación):**
  - La estructura es muy cerrada; los enlaces de las tarjetas suelen inyectarse mediante JS y no están presentes estáticamente en los elementos `<a>` en el DOM puro devuelto por el servidor, lo cual previene a los scrapers básicos (como Cheerio) de saltar del catálogo al detalle.

## 7. VerAnimeOnline (ver.animeonline.ninja)
- **Problema de Auditoría:** Este dominio devuelve de inmediato errores 403 / fallos de fetch debido a su fuerte protección Anti-Bot (Cloudflare / DDoS-Guard) cuando se accede desde herramientas de CLI sin encabezados completos o sin un motor de navegador (Puppeteer/Playwright).
- **Obfuscación (Estimada por patrón ninja):** Históricamente, la red "ninja" ofusca los iframes usando funciones complejas en JS con `eval(atob(...))` dentro de etiquetas `<script>` específicas del reproductor.

## 8. TioPlus (tioplus.app)
- **Catálogo (Selector):** `.item` / `article` (ej: `/serie/diarra-from-detroit/...`).
- **Título / Imagen:**
  - `og:title` presente (Ej: `Ver Diarra from Detroit (2024) Temporada 2 Capítulo 5 Online Gratis Español - TioPlus`).
  - `og:image` presente y usualmente apuntando a servidores originales (ej. image.tmdb.org).
- **Sinopsis:** Selector `.description`.
- **Reproductor de Video (Obfuscación):**
  - **Descubrimiento clave:** TioPlus utiliza **Base64** explícito en atributos `data-video` (ej. `cDI3Q25sMng4M2RlSm00...`).
  - Al hacer clic en un servidor, extraen esa cadena en Base64, la decodifican vía JavaScript en el frontend y luego inyectan el resultado (que es el `src` del iframe de video) en el contenedor del reproductor.

## 9. TubePelis (tubepelis.com)
- **Catálogo (Selector):** `.item`, `.pelicula`
- **Título / Imagen:**
  - `og:title` presente (Ej: `El final de Oak Street - Ver Pelicula Completa`).
  - `og:image` presente (URL a servidor propio).
- **Reproductor de Video (Obfuscación):**
  - Utilizan iframes para renderizar el reproductor (`about:blank` en el src inicial para luego inyectar, o iframes que apuntan a `reproductor.php`).
  - **Descubrimiento clave:** Exponen URLs codificadas en Base64 directamente en la query string del iframe de su propio servidor o en los `data-attr`. Ejemplo: `reproductor.php?v=aHR0cHM6...` (donde el Base64 decodifica típicamente a la URL del servidor real de alojamiento de video como `byseqekaho.com` o `playmogo.com`).

## 10. Hackstore (hackstore2.com)
- **Problema de Auditoría:** Altísima protección anti-DDoS (típicamente Cloudflare IUAM). Los endpoints devuelven el reto en lugar del HTML del sitio cuando se consultan con scripts puros de `fetch`. Se requeriría bypass o renderizado completo para extraer los selectores DOM.
- **Obfuscación (Estimada por el motor):** Suelen proveer enlaces directos a Mega/Uptobox (antes) y servidores stream escondidos detrás de acortadores y recaptchas.

## 11. Cinecalidad (cinecalidad.am)
- **Catálogo (Selector):** El home está cargado de tarjetas en un diseño de grilla, pero la navegación en el DOM usa enlaces con anclas en Base64 o dependencias fuertes de JS para cargar el detalle.
- **Reproductor de Video (Obfuscación):**
  - **Descubrimiento clave:** Cinecalidad utiliza Base64 tanto para el enrutamiento a ciertas secciones del detalle (ej. `#aHR0cHM6...`) como para esconder los reproductores (enlaces magnet, opciones de stream) dentro de bloques de script con `eval` o inyección en el contenedor `dooplay_player_response`. Usa la plantilla Dooplay (WordPress) muy fuertemente ofuscada en su archivo JS de frontend.

## 12. GnulaSeries (gnulaseries.nu)
- **Problema de Auditoría:** Similar a Hackstore2, bloquea peticiones de scripts headless/CLI con Cloudflare.
- **Obfuscación (Estimada por el motor):** Al estar habitualmente montado sobre temas como Dooplay o Toroplay, el iframe del reproductor es solicitado vía una petición AJAX (`admin-ajax.php` con la acción `doo_player`) devolviendo el iframe embebido o un script ofuscado con Base64.
