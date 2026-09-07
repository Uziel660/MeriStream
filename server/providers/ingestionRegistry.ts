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
  { providerId: "animeav1", targetUrl: "https://animeav1.com/catalogo", name: "AnimeAV1 (Catálogo Completo)" },
  { providerId: "animeflv", targetUrl: "https://animeflv.or.at/anime/", name: "AnimeFLV (Catálogo Completo)" },
  { providerId: "jkanime", targetUrl: "https://jkanime.net/directorio/", name: "JKAnime (Catálogo Completo)" },
  { providerId: "hianimes", targetUrl: "https://hianimes.se/filter?type=All&page=1", name: "HiAnimes (Catálogo Completo)" },
  { providerId: "gnula", targetUrl: "https://ww3.gnulahd.nu/", name: "GNULA (Catálogo Completo)" },
  { providerId: "cinecalidad", targetUrl: "https://cinecalidad.am", name: "Cinecalidad (Catálogo Completo)" },

  { providerId: "lamovie", targetUrl: "https://lamovie.org/peliculas", name: "LaMovie Películas (Catálogo Completo)" },
  { providerId: "lamovie", targetUrl: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=tvshows&postsPerPage=24", name: "LaMovie Series (Catálogo Completo)" },
  { providerId: "lamovie", targetUrl: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=animes&postsPerPage=24", name: "LaMovie Anime (Catálogo Completo)" },

  { providerId: "tubepelis", targetUrl: "https://tubepelis.com/peliculas", name: "TubePelis Películas (Catálogo Completo)" },
  { providerId: "tubepelis", targetUrl: "https://tubepelis.com/series", name: "TubePelis Series (Catálogo Completo)" },

  { providerId: "tioplus", targetUrl: "https://tioplus.app/peliculas", name: "TioPlus Películas (Catálogo Completo)" },
  { providerId: "tioplus", targetUrl: "https://tioplus.app/series", name: "TioPlus Series (Catálogo Completo)" },

  { providerId: "doramasflix", targetUrl: "https://doramasflix.io/doramas", name: "Doramasflix Doramas (Catálogo Completo)" },
  { providerId: "doramasflix", targetUrl: "https://doramasflix.io/peliculas", name: "Doramasflix Películas (Catálogo Completo)" },
  { providerId: "doramasflix", targetUrl: "https://doramasflix.io/variedades", name: "Doramasflix Variedades (Catálogo Completo)" },

  { providerId: "latanime", targetUrl: "https://latanime.org/animes?p=1", name: "LatAnime (Catálogo Completo)" },
  { providerId: "tioanime", targetUrl: "https://tioanime.com/directorio", name: "TioAnime (Catálogo Completo)" },
  { providerId: "veranimes", targetUrl: "https://wwv.veranimes.net", name: "VerAnimes (Catálogo Completo)" },
];

export function getEnabledIngestionTargets(): ProviderIngestionTarget[] {
  return PROVIDER_INGESTION_TARGETS
    .filter((target) => target.enabled !== false)
    .filter((target) => {
      const policy = getProviderPolicy(target.providerId);
      return Boolean(policy) && policy?.role !== "metadata";
    })
    .sort((a, b) => {
      const pa = getProviderPolicy(a.providerId)?.priority ?? 100;
      const pb = getProviderPolicy(b.providerId)?.priority ?? 100;
      return pa - pb || a.name.localeCompare(b.name);
    });
}
