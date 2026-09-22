import { normalizeTitleKey } from "../server/utils/titleNormalizer";

export type CatalogIdentityExceptionKind = "aggregate" | "event";

export interface CatalogIdentityException {
  kind: CatalogIdentityExceptionKind;
  reason: string;
  action: string;
}

/**
 * Some imported rows are not one work in TMDB/MAL/AniList. They are packs of
 * several movies/specials or a live awards broadcast. Assigning one random
 * ID would make artwork, subtitles and provider lookup point at the wrong
 * work, so the verifier reports these explicitly instead of hiding them.
 */
const EXCEPTIONS: Record<string, CatalogIdentityException> = {
  kimetsunoyaibaespecialesdetv: {
    kind: "aggregate",
    reason: "Pack de varios especiales recapitulativos de Kimetsu no Yaiba; no existe un ID externo único para el pack.",
    action: "Mantener como pack y resolver cada especial por su fuente; no heredar el ID de la serie base automáticamente.",
  },
  saintseiyamovies: {
    kind: "aggregate",
    reason: "La entrada agrupa varias películas de Saint Seiya en una sola obra.",
    action: "Separar por película si se quiere identidad y artwork individual; no asignar una película arbitraria.",
  },
  "83rdgoldenglobeawards": {
    kind: "event",
    reason: "Es una transmisión/evento de premios, no una película o serie catalogada de forma estable en TMDB/MAL/AniList.",
    action: "Conservar como evento fuera del saneamiento de IDs de obras.",
  },
};

export function getCatalogIdentityException(title: string): CatalogIdentityException | null {
  return EXCEPTIONS[normalizeTitleKey(title)] || null;
}

