# Entorno Aislado de Pruebas de Reproducción (`TestPlayerModal.tsx`)

## 1. Funcionamiento del Algoritmo de Extracción
Cada pestaña del probador ejecuta la lógica exacta especificada en los repositorios oficiales de GitHub:

1. **ZokoAnime Embed**:
   - URL: `https://zokoanime.video/stream/{source}/{id}/{episode}/{track}?color=35d5bf`
   - Entrega iframe embed directo con auto-subtítulos y skin personalizada.

2. **AniPulse AnimeAPI (`AniPulse/AnimeAPI`)**:
   - Extracción mediante `decryptSources_v1`: obtiene las URLs de stream directamente de Megaplay (`megaplay.buzz`) y Vidwish (`vidwish.live`) para los episodios (`epId`).
   - Entrega los servidores extraídos `HD-1 Sub`, `HD-2 Sub` y `HD-1 Dub`.

3. **GitHub Scraper (`carlosfdezb/tioanime`)**:
   - Extrae el array `var videos = [...]` directamente del HTML de TioAnime.
   - Entrega los servidores crudos extraídos (`Mega`, `YourUpload`, `Okru`, `Streamtape`, etc.) directamente al reproductor.

4. **MeriStream TioAnimeAdapter (Backend JIT)**:
   - Extrae `var videos`, descarta hosts muertos (`v.tioanime.com`), valida la latencia y resuelve los embeds a HLS nativo `.m3u8`.

## 2. Ejecución en Nuestro Reproductor Interno (`HLSPlayerModal`)
Todas las extracciones envían sus streams a **`HLSPlayerModal`**, permitiendo probar la reproducción real, cambio de servidores y calidad sin alterar el catálogo de producción.
