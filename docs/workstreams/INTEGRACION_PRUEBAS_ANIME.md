# Documentación de Integraciones de Prueba Anime (ZokoAnime, AniPulse & TioAnime)

## 1. ZokoAnime (`https://zokoanime.video/`)
- **Funcionamiento**: Embed directo mediante ID numérico de MAL o AniList.
- **Formato**: `https://zokoanime.video/stream/{source}/{id}/{episode}/{track}?color=35d5bf`

## 2. AniPulse API / HiAnime (`https://github.com/AniPulse/AnimeAPI`)
- **Funcionamiento**: Extrae streams de HiAnime/AniWatch usando `hianimesResolver.ts` de MeriStream.
- **Formato**: Basta con ingresar el ID/Slug del episodio (ej: `frieren-beyond-journeys-end-18542?ep=107257`) y MeriStream lo resuelve JIT automáticamente.

## 3. GitHub Scraper TioAnime (`carlosfdezb/tioanime`)
- **Funcionamiento**: Extrae el array crudo `var videos = [...]` directamente del HTML de TioAnime (`https://tioanime.com/ver/{id}-{episode}`).

## 4. MeriStream TioAnime (`TioAnimeAdapter.ts`)
- **Funcionamiento**: Motor propio de MeriStream con resolución JIT y conversión nativa a `.m3u8` (VOE/Mega).

---
### Probador en Reproductor (`HLSPlayerModal.tsx`)
En el menú **Servidores** -> **Probador de Servidores Anime**:
1. `ZokoAnime`: Pones MAL/AniList ID (ej: `21`).
2. `AniPulse API`: Pones solo el ID del episodio (ej: `frieren-beyond-journeys-end-18542?ep=107257`).
3. `GitHub (carlosfdezb)`: Pones slug/URL de TioAnime (ej: `one-piece-1`).
4. `MeriStream`: Pones slug de TioAnime para motor propio.
