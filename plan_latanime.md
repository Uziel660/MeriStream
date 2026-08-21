# Plan de Implementación: Adaptador LatAnime.org

Este documento describe la estrategia técnica para construir el adaptador de **LatAnime.org** dentro de Nitiflix.

## 🎯 Objetivo
Crear `LatAnimeAdapter.ts` en `server/scrapers/adapters/` heredando de `BaseAdapter`.

## 🔍 Investigación Técnica Realizada
Tras analizar el HTML de LatAnime.org con Cheerio, la extracción es altamente eficiente:

1. **Página de Catálogo (Home/Paginación):**
   * Los enlaces a los animes están en etiquetas tipo: `a[href^="https://latanime.org/anime/"]`.
   
2. **Página de Detalles:** 
   * Título: `<meta property="og:title">`
   * Portada: `<meta property="og:image">`
   * Sinopsis: Extraída de `.sinopsis`, `p.text-sm` o `p.description`.
   * Lista de Episodios: Búsqueda de etiquetas `a` cuyo atributo `href` contenga el string `/ver/`.

3. **Página del Reproductor (Video / Episodios):** 
   * LatAnime **NO ofusca con JavaScript complejo**. Almacena los enlaces de los iframes de video (VOE, DoodStream, Mp4Upload) directamente en el atributo `data-player` codificados en Base64.
   * Usaremos Node.js para decodificar el Base64 y nuestro motor universal `EmbedResolvers.resolve(iframeUrl)` para obtener los streams `.mp4` y `.m3u8` reales.

## 🛠 Cambios Propuestos

### Componente Principal
#### [NEW] `server/scrapers/adapters/LatAnimeAdapter.ts`
Implementaremos los dos métodos requeridos por la clase base:

* **`analyze(url)`**: 
   * Identifica si la URL es de catálogo o de detalles.
   * Extrae los metadatos usando Cheerio.
   * Si es detalle, construye el array `episodes` extrayendo el número de episodio de la URL.

* **`extractStream(url)`**:
   * Hace un fetch a la página del episodio.
   * Encuentra todos los elementos con el atributo `data-player`.
   * Decodifica el Base64.
   * Pasa cada iframeUrl decodificada por `EmbedResolvers.resolve(iframeUrl)`.
   * Retorna el primer stream exitoso (añadiendo el resto al array `all_available_streams`).

### Configuración
#### [MODIFY] `server/scrapers/ScraperManager.ts`
* Importar e instanciar `LatAnimeAdapter`.
* Añadir la regla de ruteo para el dominio `latanime.org`.

## 🚦 Plan de Verificación
* [ ] Crear y ejecutar un script de prueba (`test_latanime.ts`) que analice el catálogo, extraiga los detalles de un anime y resuelva el video de un episodio hasta obtener el `.m3u8` final.
* [ ] Ejecutar la suite completa `npm test` para asegurar que el `ScraperManager` se compila sin errores.
* [ ] Hacer commit de este archivo y del código generado.
