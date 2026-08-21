# Contexto de la Sesión - Proyecto Nitiflix

## 1. Problema Principal Resuelto
El objetivo principal era construir extractores directos de `.m3u8` y `.mp4` para evitar que el usuario tenga que lidiar con reproductores de terceros (iframes llenos de publicidad) y usar nuestro propio reproductor nativo en el Frontend (React + Tailwind + Hls.js).
- Se descartó la librería `Plyr` porque causaba problemas de desincronización y cierres forzados con el DOM dinámico de React al cambiar de servidor. Nuestro reproductor nativo en React (`HLSPlayerModal.tsx`) es mucho más estable.

## 2. El Caso de Éxito: LaMovie.org
### A) El Catálogo Masivo (Sitemaps)
- Descubrimos que `lamovie.org` es una SPA (Single Page Application). Al solicitar `/peliculas?page=1` por backend, WordPress devuelve un status `404` con un cascarón HTML vacío porque todo se renderiza por JavaScript en el cliente.
- **La Solución:** Nos conectamos directamente a los sitemaps de WordPress (`/wp-sitemap-posts-movies-1.xml`, `/wp-sitemap-posts-tvshows-1.xml`, `/wp-sitemap-posts-animes-1.xml`).
- **El Resultado:** Logramos extraer **1,000 películas por página** en menos de 1 segundo de forma perfectamente estructurada, saltándonos las limitaciones visuales de 20 películas por página.

### B) Extracción del Video (API Oculta y Desofuscación)
- No buscamos iframes en el HTML estático de las películas porque no existen.
- Extraemos el `postId` del código fuente (ej. `<link rel="shortlink" href="https://lamovie.org/?p=12345" />`).
- Consultamos la API interna: `https://lamovie.org/wp-api/v1/player?postId=12345`.
- Esto devuelve los enlaces de los iframes (vimeos.net, goodstream, voe).

## 3. Infraestructura Backend Añadida
- **JS Unpacker (`server/scrapers/utils/jsUnpacker.ts`)**: Se creó una utilidad pura en TypeScript para decodificar funciones de Dean Edwards (`eval(function(p,a,c,k,e,d)...)`), Base64 y Hex. Fundamental para romper la ofuscación de los iframes piratas.
- **Embed Resolvers (`server/resolvers.ts`)**: Motor especializado que procesa las URLs de iframes (VOE, DoodStream, Mp4Upload, Streamwish) y las convierte en strings `.m3u8` reales para el cliente.

## 4. Tareas Pendientes para los Próximos Adaptadores (Fase Jules)
- **13 Nuevos Sitios:** Se requieren adaptadores para sitios como latanime.org, jkanime.net, tioanime.com, cinecalidad.am, etc.
- **Rendimiento:** El backend NUNCA debe usar Playwright en producción para resolver streams. Se debe usar `fetch`, `cheerio` y los `resolvers`/`jsUnpacker` actuales. Solo se debe usar Playwright para investigar el DOM.
- **UI Frontend (Películas vs Series):** En React (`MediaDetailsModal.tsx`), actualmente las películas muestran listas de episodios. Hay que separar la lógica: si `kind === 'movie'`, mostrar solo la info y el botón de reproducir. Si es serie/anime, mostrar episodios organizados por temporadas.
- **Motor de Metadatos (TMDB):** Las sinopsis de animes (vía Jikan API) llegan en inglés y con basura HTML (`<br></br>`). Hay que limpiar el HTML mediante Regex y conectar TMDB API para forzar traducciones al Español (`es-MX`).
