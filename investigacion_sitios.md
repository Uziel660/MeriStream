# Análisis Estructural del DOM y Auditoría de OpenGraph (Investigación Detallada)

## 1. JkAnime (jkanime.net)
- **Catálogo (Selector):** `.card`
- **Metadatos (SEO):**
  - `og:title`: Extraído de `meta[property="og:title"]` (Ej: `Otome Kaijuu Caraméliser 8 Sub Español Online gratis — JkAnime`).
  - `og:image`: Presente, apunta al CDN (Ej: `https://cdn.jkdesa.com/assets/images/animes/video/image_thumb/jkvideo_...jpg`).
  - **Sinopsis:** Se encuentra bajo las clases `.sinopsis` o `.description`.
- **Reproductor de Video (Obfuscación):**
  - El iframe no está en el DOM. Se inyecta dinámicamente desde un bloque `<script>` específico.
  - **Estructura Exacta:** Declaran un array literal en el contexto global: `var video = [];`
  - Asignan strings HTML con el iframe directamente a los índices del array.
  - Ejemplo extraído: `video[0] = '<iframe class="player_conte" src="https://jkanime.net/jkplayer/um?e=Qys1MElYZlh2dVdT..."'`
  - **Codificación:** El parámetro `?e=` en la URL del iframe es una cadena codificada en Base64 que el endpoint `/jkplayer/um` decodifica del lado del servidor.

## 2. AnimeJara (animejara.com)
- **Catálogo (Selector):** Los enlaces del catálogo principal están bajo rutas específicas `a[href*="/anime/"]`. (Ej: `/anime/yarinaoshi-reijou-wa-ryuutei-heika-wo-kouryakuchuu/`).
- **Metadatos (SEO):** Poseen `og:title` y `og:image` en el detalle del episodio, pero el servidor utiliza una fuerte protección de Cloudflare (IUAM) que devuelve HTML de "Página no encontrada" si las cabeceras o la huella digital del cliente no coinciden con un navegador real.
- **Reproductor de Video (Obfuscación):**
  - No exponen el `src` del iframe en texto plano en la carga inicial. Utilizan atributos en botones de servidores como `data-video` o `data-server`, que un script de JavaScript lee al hacer click para generar el iframe.

## 3. TioAnime (tioanime.com)
- **Catálogo (Selector):** Etiqueta `<article>`
- **Metadatos (SEO):**
  - `og:title`: Extraído correctamente (Ej: `Otome Kaijuu Caraméliser 8 - TioAnime`).
  - `og:image`: El metadato a veces se omite o está mal formateado (retorna `undefined` sin un user-agent completo).
  - **Sinopsis:** Se ubica en `<p class="sinopsis">`.
- **Reproductor de Video (Obfuscación):**
  - **Estructura Exacta:** En lugar de strings HTML, utilizan un array JSON multidimensional inyectado en un `<script>` bajo la variable global `videos`.
  - Código extraído: `var videos = [["Mega","https:\/\/mega.nz\/embed\/!IGEWWYJS!HkBuouYE96PVkx17cN87Ccyd7MbTgWG6ILE3mk0c2w4",0,0],["Voe","https:\/\/voe.sx\/e\/gqmxydzan6rl",0,0]];`
  - Función de arranque: Inmediatamente después del array, llaman a la función `$(document).ready(function () { initEpisode(); });` para montar el DOM del reproductor usando los datos de la variable `videos`.

## 4. VerAnimes (wwv.veranimes.net)
- **Catálogo (Selector):** Etiqueta `<article>` (Ej URL extraída: `/ver/otome-kaijuu-carameliser-8`)
- **Metadatos (SEO):**
  - `og:title`: Presente (Ej: `Ver Otome Kaijuu Caraméliser episodio 8 Online Gratis - VerAnime`).
  - `og:image`: Usa su propio CDN para imágenes WebP (Ej: `https://wwv.veranimes.net/cdn/img/anime/otome-kaijuu-carameliser.webp?t=1`).
- **Reproductor de Video (Obfuscación):**
  - Su técnica de obfuscación se basa en botones de selección de servidor `<li>` o `<button>` que contienen atributos de datos (ej. `data-video="url"`).
  - La lógica de inyección está en un archivo de JavaScript externo que captura el evento `click` sobre esos botones, extrae la URL y crea el tag `<iframe>` dinámicamente.

## 5. AnimeAV1 (animeav1.com)
- **Catálogo (Selector):** Usa `article` en un diseño de grilla cargado dinámicamente.
- **Problema de Fetch:** Al intentar consultar rutas de episodios (rutas que contienen `-episodio-` o `/v/`), su Cloudflare detecta la firma del scraper si no hay un motor de renderizado y bloquea la petición.
- **Reproductor de Video (Obfuscación):**
  - La URL real suele estar envuelta en dos capas de iframes. En el frontend se usan botones con la clase `.play-video` y el atributo `data-src` que detonan la carga.

## 6. EstrenosAnime (estrenosanime.net)
- **Catálogo (Selector):** `.item` o `.anime-item`.
- **Reproductor de Video (Obfuscación):**
  - Fuertemente acoplado con scripts del lado del cliente. No renderizan los href reales en el DOM devuelto por el primer request GET, por lo que la navegación automatizada estática (`cheerio`) no puede transitar del home al episodio sin ejecutar el JS del DOM.

## 7. VerAnimeOnline (ver.animeonline.ninja)
- **Bloqueo a Nivel Red:** DDoS-Guard o Cloudflare en modo restrictivo ("I'm Under Attack Mode"). Ninguna petición `fetch` estática pasa.
- **Reproductor de Video (Obfuscación):**
  - Patrón de la familia "Ninja": Usan scripts ofuscados que decodifican iframes al vuelo utilizando una combinación de funciones `eval()` y `atob()` anidadas.

## 8. TioPlus (tioplus.app)
- **Catálogo (Selector):** `<article>` y `<div class="item">` (Estructura de URL: `/serie/{nombre}/season/{num}/episode/{num}`).
- **Metadatos (SEO):**
  - `og:title`: `Ver Diarra from Detroit (2024) Temporada 2 Capítulo 5 Online Gratis Español - TioPlus`
  - `og:image`: Obtienen los pósters directamente de TMDb (`https://image.tmdb.org/t/p/original/...jpg`).
- **Reproductor de Video (Obfuscación):**
  - **Estructura Exacta:** Exponen directamente cadenas Base64 codificadas en los atributos de datos de la lista de servidores en el DOM inicial.
  - Ejemplos extraídos:
    - `data-video="cDI3Q25sMng4M2RlSm00aUR2WmJGaFRNVnFxZnlBWHc5b1NKZGo1MW9hZUh2K3hkNk5RPQ=="`
    - `data-video="cDI3Q25sMng4M2RBS0drbUNPZGFTQXpXQ3VIVDAxaTE2TVNhYzJvM3JLT2Y="`
  - El frontend decodifica `atob(data-video)` en un evento de click para montar el iframe.

## 9. TubePelis (tubepelis.com)
- **Catálogo (Selector):** `.item` o `.pelicula` (Estructura de URL: `/pelicula/{id}/{slug}.html`).
- **Metadatos (SEO):**
  - `og:title`: `El final de Oak Street - Ver Pelicula Completa`
  - `og:image`: `https://www.tubepelis.com/files/uploads/4667.webp`
- **Reproductor de Video (Obfuscación):**
  - Hay múltiples iframes iniciales apuntando a `about:blank`.
  - **Estructura Exacta:** Utilizan atributos de datos para esconder URLs hacia su proxy interno (`reproductor.php`).
  - El parámetro GET de ese reproductor viene ofuscado en Base64 con codificación URL adicional (`%3D` al final).
  - Ejemplos extraídos:
    - `data-video="https://www.tubepelis.com/reproductor.php?v=aHR0cHM6Ly9ieXNlcWVrYWhvLmNvbS9lL2V1b3kybXRueXFoMi8%3D"` -> `atob("aHR0cHM6Ly9ieXNlcWVrYWhvLmNvbS9lL2V1b3kybXRueXFoMi8=")` resulta en el iframe real de destino: `https://byseqekaho.com/e/euoy2mtnyqh2/`
    - `data-video="https://www.tubepelis.com/reproductor.php?v=aHR0cHM6Ly9wbGF5bW9nby5jb20vZS8xNzhwN255Nmh3N2s%3D"` -> resulta en `https://playmogo.com/e/178p7ny6hw7k`

## 10. Hackstore (hackstore2.com)
- **Bloqueo a Nivel Red:** Restricciones duras de Cloudflare a peticiones programáticas.
- **Reproductor de Video (Obfuscación):** Es conocido por enlazar a archivos en plataformas externas a través de acortadores y recaptchas. Los embeds suelen estar ofuscados detrás de scripts JS fuertemente minificados.

## 11. Cinecalidad (cinecalidad.am)
- **Catálogo (Selector):** Arquitectura tipo Single Page Application basada en anclas.
- **Metadatos (SEO):**
  - Descubierto: Las imágenes del catálogo no las alojan localmente, se obtienen dinámicamente (y se referencian en atributos data) desde TMDb, ej: `data-src="https://image.tmdb.org/t/p/w342//oa67yugnWstYxJDHvGS0XTN0aSL.jpg"`
- **Reproductor de Video (Obfuscación):**
  - **Estructura Exacta:** Todo el ruteo a las películas/reproductores usa Base64 en el ancla (hash) de la URL.
  - Ejemplo extraído: El link de navegación en el home es `/#aHR0cHM6Ly9hZHNhbmFseXRpY3Mub3JnL2MveHVyaTd5eTV6cm54a2FjY3lnZTVjMml0N2drejFlMTA=`
  - Al desencriptar la cadena (Base64), se obtiene el endpoint que sirve el reproductor: `https://adsanalytics.org/c/xuri7yy5zrnxkaccyge5c2it7gkz1e10`
  - Utilizan una implementación altamente modificada del framework Dooplay (WordPress), donde la inyección del HTML del reproductor ocurre en el contenedor `#dooplay_player_response` ejecutado a través de una función asíncrona anónima `(function(){ for(let a of document.querySelectorAll('#dooplay_player_response')){ ... } })();`

## 12. GnulaSeries (gnulaseries.nu)
- **Bloqueo a Nivel Red:** Peticiones bloqueadas por WAF/Cloudflare de manera inmediata si no hay entorno de navegador.
- **Reproductor de Video (Obfuscación):** Infraestructura basada en WordPress (Dooplay/Toroplay). El payload del reproductor típicamente no está en el DOM; se carga mediante un HTTP POST a `/wp-admin/admin-ajax.php` pasando variables de sesión y el ID del post, y el servidor retorna un snippet HTML con el iframe (a menudo re-ofuscado en Base64).
