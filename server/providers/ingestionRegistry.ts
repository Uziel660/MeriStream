import { getProviderPolicy } from "./providerPolicy";

export interface ProviderIngestionTarget {
  providerId: string;
  targetUrl: string;
  name: string;
  enabled?: boolean;
  notes?: string;
}

/**
 * Single source of truth for full-catalog ingestion entrypoints.
 * Provider policy controls priority/lifecycle; this registry only describes
 * concrete catalog roots that the crawler can traverse.
 */
export const PROVIDER_INGESTION_TARGETS: ProviderIngestionTarget[] = [
  { providerId: "cinecalidad", targetUrl: "https://www.cinecalidad.am/", name: "Cinecalidad (ES-LATAM · principal)" },
  // Gnula mantiene índices separados para películas y series. Importarlos
  // por separado evita que la portada (un carrusel de novedades) se confunda
  // con el catálogo completo y permite reanudar cada sección de forma aislada.
  { providerId: "gnula", targetUrl: "https://ww3.gnulahd.nu/ver/peliculas/", name: "GnulaHD Películas (ES-LATAM · principal)" },
  { providerId: "gnula", targetUrl: "https://ww3.gnulahd.nu/ver/series/", name: "GnulaHD Series (ES-LATAM · principal)" },
  { providerId: "gnula", targetUrl: "https://ww3.gnulahd.nu/ver/anime/", name: "GnulaHD Anime (ES-LATAM · principal)" },
  { providerId: "latanime", targetUrl: "https://latanime.org/animes?p=1", name: "LatAnime (ES-LATAM · principal)" },
  { providerId: "tioanime", targetUrl: "https://tioanime.com/directorio", name: "TioAnime (anime · principal)" },
  { providerId: "doramasflix", targetUrl: "https://doramasflix.io/doramas", name: "Doramasflix Doramas (mantenido · secundario)" },
  { providerId: "doramasflix", targetUrl: "https://doramasflix.io/peliculas", name: "Doramasflix Películas (mantenido · secundario)" },
  { providerId: "doramasflix", targetUrl: "https://doramasflix.io/variedades", name: "Doramasflix Variedades (mantenido · secundario)" },
  { providerId: "doramasia", targetUrl: "https://doramasia.com/doramas", name: "Doramasia Doramas (GraphQL · principal)" },
  { providerId: "doramasia", targetUrl: "https://doramasia.com/peliculas", name: "Doramasia Películas (GraphQL · principal)" },
  // Tudorama expone índices WordPress separados por tipo. Las taxonomías de
  // idioma (espanol-latino/sub-espanol) son vistas cruzadas y no se importan
  // como raíces adicionales para no duplicar fichas.
  { providerId: "tudorama", targetUrl: "https://tudorama.com/genero/series/", name: "Tudorama Series (HTML paginado · principal)" },
  { providerId: "tudorama", targetUrl: "https://tudorama.com/genero/cdrama/", name: "Tudorama C-Dramas (HTML paginado · principal)" },
  { providerId: "tudorama", targetUrl: "https://tudorama.com/genero/jdrama/", name: "Tudorama J-Dramas (HTML paginado · principal)" },
  { providerId: "tudorama", targetUrl: "https://tudorama.com/genero/reality-show/", name: "Tudorama Reality Shows (HTML paginado · principal)" },
  { providerId: "tudorama", targetUrl: "https://tudorama.com/genero/peliculas/", name: "Tudorama Películas (HTML paginado · principal)" },
  // TioPlus expone cuatro índices independientes con paginación /N. Las
  // raíces se importan por separado y el guardado deduplica por URL, tipo y
  // año para conservar los solapes legítimos de Doramas/Series.
  { providerId: "tioplus", targetUrl: "https://tioplus.app/peliculas", name: "TioPlus Películas (HTML paginado · principal)" },
  { providerId: "tioplus", targetUrl: "https://tioplus.app/series", name: "TioPlus Series (HTML paginado · principal)" },
  { providerId: "tioplus", targetUrl: "https://tioplus.app/doramas", name: "TioPlus Doramas (HTML paginado · principal)" },
  { providerId: "tioplus", targetUrl: "https://tioplus.app/animes", name: "TioPlus Anime (HTML paginado · principal)" },
  // Archive.org remains an explicit public-domain/open-license source for EN.
  { providerId: "archive-org", targetUrl: "https://archive.org/details/movies", name: "Internet Archive (contenido abierto)" },
];

/**
 * Kept for explicit recovery/maintenance jobs only. These targets are never
 * returned by getEnabledIngestionTargets and cannot feed normal ranking.
 */
export const LEGACY_INGESTION_TARGETS: ProviderIngestionTarget[] = [
  { providerId: "animeav1", targetUrl: "https://animeav1.com/catalogo", name: "AnimeAV1 (legacy)" },
  { providerId: "animeflv", targetUrl: "https://animeflv.or.at/anime/", name: "AnimeFLV (legacy)" },
  { providerId: "jkanime", targetUrl: "https://jkanime.net/directorio/", name: "JKAnime (legacy)" },
  { providerId: "hianimes", targetUrl: "https://hianimes.se/filter?type=All&page=1", name: "HiAnimes (legacy; descubridor de Zoko)" },
  { providerId: "lamovie", targetUrl: "https://lamovie.org/peliculas", name: "LaMovie (legacy)" },
  { providerId: "tioanime", targetUrl: "https://tioanime.com/directorio", name: "TioAnime (fallback de ZokoAnime)" },
  { providerId: "veranimes", targetUrl: "https://wwv.veranimes.net", name: "VerAnimes (legacy)" },
  { providerId: "tubepelis", targetUrl: "https://tubepelis.com/peliculas", name: "TubePelis (legacy)" },
];

export function getEnabledIngestionTargets(): ProviderIngestionTarget[] {
  return PROVIDER_INGESTION_TARGETS
    .filter((target) => target.enabled !== false)
    .filter((target) => {
      const policy = getProviderPolicy(target.providerId);
      return Boolean(policy)
        && policy?.role !== "metadata"
        && (policy?.lifecycle === "active" || policy?.lifecycle === "maintained");
    })
    .sort((a, b) => {
      const pa = getProviderPolicy(a.providerId)?.priority ?? 100;
      const pb = getProviderPolicy(b.providerId)?.priority ?? 100;
      return pa - pb || a.name.localeCompare(b.name);
    });
}
