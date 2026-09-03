# Auditoría de adaptadores de catálogo
Generado: 2026-09-03T03:31:04.342Z

Solo lectura; TubePelis fue excluido por configuración del proyecto. Un embed cuenta como extracción encontrada, no como reproducción nativa verificada.

| Preset | Adaptador | Catálogo | Tarjetas únicas | Páginas | Repetidas | Muestras OK | Directos | Embeds | Páginas HTML | Errores |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| doramas-doramasflix | doramasflix | ok | 24 | 2 | 1 | 1/1 | 0 | 0 | 9 |  |
| movies-doramasflix | doramasflix | ok | 24 | 2 | 1 | 1/1 | 0 | 0 | 1 |  |
| variety-doramasflix | doramasflix | ok | 24 | 2 | 1 | 1/1 | 0 | 0 | 7 |  |
| anime-animeflv | animeflv | error | 0 | 0 | 0 | 0/0 | 0 | 0 | 0 | FETCH_FAILED: https://www3.animeflv.net/browse |
| movies-lamovie | lamovie | ok | 48 | 2 | 0 | 1/1 | 0 | 4 | 1 |  |
| series-lamovie | lamovie | ok | 48 | 2 | 0 | 1/1 | 0 | 12 | 131 |  |
| anime-lamovie | lamovie | ok | 48 | 2 | 0 | 1/1 | 0 | 11 | 25 |  |
| movies-cinecalidad | cinecalidad | ok | 24 | 2 | 0 | 1/1 | 0 | 14 | 9 |  |
| movies-tioplus | tioplus | ok | 48 | 2 | 0 | 1/1 | 1 | 1 | 2 |  |
| anime-latanime | latanime | ok | 60 | 2 | 0 | 1/1 | 0 | 5 | 3 |  |
| anime-tioanime | tioanime | ok | 40 | 2 | 0 | 1/1 | 0 | 1 | 2 |  |
| anime-veranimes | veranimes | ok | 40 | 2 | 0 | 1/1 | 0 | 1 | 7 |  |
| series-tvmaze | tvmaze | empty | 0 | 1 | 0 | 0/0 | 0 | 0 | 0 |  |
| archive-org | archive_org | empty | 0 | 1 | 0 | 0/0 | 0 | 0 | 0 |  |

## Detalle

```json
[
  {
    "preset_id": "doramas-doramasflix",
    "adapter_id": "doramasflix",
    "category": "series",
    "catalog_url": "https://doramasflix.io/doramas",
    "catalog_status": "ok",
    "pages_checked": 2,
    "page_errors": 0,
    "repeated_pages": 1,
    "raw_items": 48,
    "unique_items": 24,
    "invalid_items": 0,
    "sample_details": [
      {
        "url": "https://doramasflix.io/doramas/in-my-prime",
        "status": "ok",
        "title": "In My Prime",
        "episode_count": 8,
        "probed_targets": 3,
        "stream_counts": {
          "direct": 0,
          "embed": 0,
          "page": 9,
          "ephemeral": 0
        }
      }
    ],
    "elapsed_ms": 4883
  },
  {
    "preset_id": "movies-doramasflix",
    "adapter_id": "doramasflix",
    "category": "movies",
    "catalog_url": "https://doramasflix.io/peliculas",
    "catalog_status": "ok",
    "pages_checked": 2,
    "page_errors": 0,
    "repeated_pages": 1,
    "raw_items": 48,
    "unique_items": 24,
    "invalid_items": 0,
    "sample_details": [
      {
        "url": "https://doramasflix.io/peliculas/untold-scandal",
        "status": "ok",
        "title": "Untold Scandal",
        "episode_count": 0,
        "probed_targets": 1,
        "stream_counts": {
          "direct": 0,
          "embed": 0,
          "page": 1,
          "ephemeral": 0
        }
      }
    ],
    "elapsed_ms": 2232
  },
  {
    "preset_id": "variety-doramasflix",
    "adapter_id": "doramasflix",
    "category": "series",
    "catalog_url": "https://doramasflix.io/variedades",
    "catalog_status": "ok",
    "pages_checked": 2,
    "page_errors": 0,
    "repeated_pages": 1,
    "raw_items": 48,
    "unique_items": 24,
    "invalid_items": 0,
    "sample_details": [
      {
        "url": "https://doramasflix.io/variedades/my-ai-partner-strange-love",
        "status": "ok",
        "title": "My AI Partner: Strange Love",
        "episode_count": 6,
        "probed_targets": 3,
        "stream_counts": {
          "direct": 0,
          "embed": 0,
          "page": 7,
          "ephemeral": 0
        }
      }
    ],
    "elapsed_ms": 4485
  },
  {
    "preset_id": "anime-animeflv",
    "adapter_id": "animeflv",
    "category": "anime",
    "catalog_url": "https://www3.animeflv.net/browse",
    "catalog_status": "error",
    "raw_items": 0,
    "unique_items": 0,
    "invalid_items": 0,
    "sample_details": [],
    "pages_checked": 0,
    "page_errors": 1,
    "repeated_pages": 0,
    "elapsed_ms": 4313,
    "error": "FETCH_FAILED: https://www3.animeflv.net/browse"
  },
  {
    "preset_id": "movies-lamovie",
    "adapter_id": "lamovie",
    "category": "movies",
    "catalog_url": "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=movies&postsPerPage=24",
    "catalog_status": "ok",
    "pages_checked": 2,
    "page_errors": 0,
    "repeated_pages": 0,
    "raw_items": 48,
    "unique_items": 48,
    "invalid_items": 0,
    "sample_details": [
      {
        "url": "https://lamovie.org/peliculas/the-wrong-babysitter-2017/",
        "status": "ok",
        "title": "The Wrong Babysitter",
        "episode_count": 1,
        "probed_targets": 1,
        "stream_counts": {
          "direct": 0,
          "embed": 4,
          "page": 1,
          "ephemeral": 1
        }
      }
    ],
    "elapsed_ms": 2502
  },
  {
    "preset_id": "series-lamovie",
    "adapter_id": "lamovie",
    "category": "series",
    "catalog_url": "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=tvshows&postsPerPage=24",
    "catalog_status": "ok",
    "pages_checked": 2,
    "page_errors": 0,
    "repeated_pages": 0,
    "raw_items": 48,
    "unique_items": 48,
    "invalid_items": 0,
    "sample_details": [
      {
        "url": "https://lamovie.org/series/thundercats-1985/",
        "status": "ok",
        "title": "ThunderCats",
        "episode_count": 130,
        "probed_targets": 3,
        "stream_counts": {
          "direct": 0,
          "embed": 12,
          "page": 131,
          "ephemeral": 4
        }
      }
    ],
    "elapsed_ms": 7023
  },
  {
    "preset_id": "anime-lamovie",
    "adapter_id": "lamovie",
    "category": "anime",
    "catalog_url": "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=animes&postsPerPage=24",
    "catalog_status": "ok",
    "pages_checked": 2,
    "page_errors": 0,
    "repeated_pages": 0,
    "raw_items": 48,
    "unique_items": 48,
    "invalid_items": 0,
    "sample_details": [
      {
        "url": "https://lamovie.org/animes/the-saints-magic-power-is-omnipotent-2021/",
        "status": "ok",
        "title": "The Saint's Magic Power is Omnipotent",
        "episode_count": 24,
        "probed_targets": 3,
        "stream_counts": {
          "direct": 0,
          "embed": 11,
          "page": 25,
          "ephemeral": 4
        }
      }
    ],
    "elapsed_ms": 5495
  },
  {
    "preset_id": "movies-cinecalidad",
    "adapter_id": "cinecalidad",
    "category": "movies",
    "catalog_url": "https://www.cinecalidad.am/",
    "catalog_status": "ok",
    "pages_checked": 2,
    "page_errors": 0,
    "repeated_pages": 0,
    "raw_items": 24,
    "unique_items": 24,
    "invalid_items": 0,
    "sample_details": [
      {
        "url": "https://www.cinecalidad.am/ver-serie/dopesick-historia-de-una-adiccion/",
        "status": "ok",
        "title": "Serie Dopesick: Historia de una adicción Online Gratis HD",
        "episode_count": 8,
        "probed_targets": 3,
        "stream_counts": {
          "direct": 0,
          "embed": 14,
          "page": 9,
          "ephemeral": 4
        }
      }
    ],
    "elapsed_ms": 8024
  },
  {
    "preset_id": "movies-tioplus",
    "adapter_id": "tioplus",
    "category": "movies",
    "catalog_url": "https://tioplus.app/peliculas",
    "catalog_status": "ok",
    "pages_checked": 2,
    "page_errors": 0,
    "repeated_pages": 0,
    "raw_items": 48,
    "unique_items": 48,
    "invalid_items": 0,
    "sample_details": [
      {
        "url": "https://tioplus.app/pelicula/minions-monsters",
        "status": "ok",
        "title": "Minions & Monsters (2026)",
        "episode_count": 0,
        "probed_targets": 1,
        "stream_counts": {
          "direct": 1,
          "embed": 1,
          "page": 2,
          "ephemeral": 1
        }
      }
    ],
    "elapsed_ms": 3332
  },
  {
    "preset_id": "anime-latanime",
    "adapter_id": "latanime",
    "category": "anime",
    "catalog_url": "https://latanime.org/animes",
    "catalog_status": "ok",
    "pages_checked": 2,
    "page_errors": 0,
    "repeated_pages": 0,
    "raw_items": 60,
    "unique_items": 60,
    "invalid_items": 0,
    "sample_details": [
      {
        "url": "https://latanime.org/anime/mobile-suit-gundam-hathaway-castellano",
        "status": "ok",
        "title": "Mobile Suit Gundam Hathaway Castellano",
        "episode_count": 1,
        "probed_targets": 2,
        "stream_counts": {
          "direct": 0,
          "embed": 5,
          "page": 3,
          "ephemeral": 1
        }
      }
    ],
    "elapsed_ms": 2858
  },
  {
    "preset_id": "anime-tioanime",
    "adapter_id": "tioanime",
    "category": "anime",
    "catalog_url": "https://tioanime.com/directorio",
    "catalog_status": "ok",
    "pages_checked": 2,
    "page_errors": 0,
    "repeated_pages": 0,
    "raw_items": 40,
    "unique_items": 40,
    "invalid_items": 0,
    "sample_details": [
      {
        "url": "https://tioanime.com/anime/gintama-movie-3-yoshiwara-daienjou",
        "status": "ok",
        "title": "Gintama Movie 3: Yoshiwara Daienjou",
        "episode_count": 1,
        "probed_targets": 2,
        "stream_counts": {
          "direct": 0,
          "embed": 1,
          "page": 2,
          "ephemeral": 1
        }
      }
    ],
    "elapsed_ms": 2273
  },
  {
    "preset_id": "anime-veranimes",
    "adapter_id": "veranimes",
    "category": "anime",
    "catalog_url": "https://wwv.veranimes.net/animes",
    "catalog_status": "ok",
    "pages_checked": 2,
    "page_errors": 0,
    "repeated_pages": 0,
    "raw_items": 40,
    "unique_items": 40,
    "invalid_items": 0,
    "sample_details": [
      {
        "url": "https://wwv.veranimes.net/anime/gintama-movie-3-yoshiwara-daienjou",
        "status": "ok",
        "title": "Gintama Movie 3: Yoshiwara Daienjou",
        "episode_count": 1,
        "probed_targets": 2,
        "stream_counts": {
          "direct": 0,
          "embed": 1,
          "page": 7,
          "ephemeral": 1
        }
      }
    ],
    "elapsed_ms": 10427
  },
  {
    "preset_id": "series-tvmaze",
    "adapter_id": "tvmaze",
    "category": "series",
    "catalog_url": "https://www.tvmaze.com/shows/169/breaking-bad",
    "catalog_status": "empty",
    "pages_checked": 1,
    "page_errors": 0,
    "repeated_pages": 0,
    "raw_items": 0,
    "unique_items": 0,
    "invalid_items": 0,
    "sample_details": [],
    "elapsed_ms": 627
  },
  {
    "preset_id": "archive-org",
    "adapter_id": "archive_org",
    "category": "archive",
    "catalog_url": "https://archive.org/details/his_girl_friday",
    "catalog_status": "empty",
    "pages_checked": 1,
    "page_errors": 0,
    "repeated_pages": 0,
    "raw_items": 0,
    "unique_items": 0,
    "invalid_items": 0,
    "sample_details": [],
    "elapsed_ms": 438
  }
]
```
