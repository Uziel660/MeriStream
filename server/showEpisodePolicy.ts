import type { ContentKind } from "./types";
import { getProviderPriority, isProviderAllowedInMainPath, normalizeProviderId } from "./providers/providerPolicy";

export type MainPathKind = Extract<ContentKind, "movie" | "series" | "anime">;

export interface MainPathSourceLink {
  url: string;
  source_site?: string | null;
  host?: string | null;
  link_type?: string | null;
  language?: string | null;
  audio_language?: string | null;
  subtitle_language?: string | null;
  subtitles?: unknown;
}

export interface CanonicalEpisodeForDisplay {
  id: string;
  season_number: number;
  episode_number: number;
  links: MainPathSourceLink[];
}

export interface LegacyEpisodeForDisplay {
  id: string;
  show_id?: string;
  title: string;
  episode_number: number;
  season_number?: number;
  source_url?: string | null;
  created_at?: Date | string;
}

export interface DisplayEpisode extends LegacyEpisodeForDisplay {
  season_number: number;
  source_url: string;
}

export function playbackKindForCategory(category: string | null | undefined): MainPathKind {
  const normalized = String(category || "").trim().toLowerCase();
  if (normalized === "movie" || normalized === "pelicula" || normalized === "película") return "movie";
  if (normalized === "series" || normalized === "tv") return "series";
  return "anime";
}

function providerOf(link: MainPathSourceLink | string): string {
  if (typeof link === "string") return normalizeProviderId(link);
  return normalizeProviderId(link.source_site || link.host || link.url);
}

function sourcePriority(link: MainPathSourceLink, kind: MainPathKind): number {
  const provider = providerOf(link);
  // Use the shared provider registry so primary/secondary roles remain
  // consistent in catalog display and playback. Cinecalidad (10) must precede
  // Gnula (20) even when both expose canonical page locators.
  let priority = getProviderPriority(provider);

  // ZokoAnime exposes both /sub and /dub locators. The requested anime
  // default is Japanese audio with Spanish subtitles, so choose /sub first.
  if (kind === "anime" && provider === "zokoanime") {
    const rendition = `${link.url} ${link.link_type || ""} ${link.audio_language || ""} ${link.subtitle_language || ""}`.toLowerCase();
    if (/sub|subtitle|subtit/.test(rendition)) priority -= 3;
    if (/dub|dobl/.test(rendition)) priority += 2;
  }

  // A catalog page is the stable locator MeriStream can refresh through the
  // site's specialized resolver. Third-party embed URLs are kept as fallback
  // candidates but should never hide the provider page in a ficha.
  const linkType = String(link.link_type || "").toLowerCase();
  if (linkType === "page") priority -= 1;
  if (linkType === "embed") priority += 1;

  return priority;
}

export function filterMainPathLinks(
  links: MainPathSourceLink[] | null | undefined,
  kind: MainPathKind,
): MainPathSourceLink[] {
  const input = Array.isArray(links) ? links.filter((link) => Boolean(link?.url?.trim())) : [];
  const hasZoko = input.some((link) => providerOf(link) === "zokoanime");

  return input
    .filter((link) => {
      const provider = providerOf(link);
      // TioAnime is a documented recovery fallback for ZokoAnime only.
      if (provider === "tioanime") return kind === "anime" && hasZoko;
      return isProviderAllowedInMainPath(provider, kind);
    })
    .sort((a, b) => compareMainPathLinks(a, b, kind));
}

export function compareMainPathLinks(
  a: MainPathSourceLink,
  b: MainPathSourceLink,
  kind: MainPathKind,
): number {
  return sourcePriority(a, kind) - sourcePriority(b, kind) || a.url.localeCompare(b.url);
}

function seasonFromLegacyEpisode(episode: LegacyEpisodeForDisplay): number {
  if (Number.isFinite(episode.season_number) && Number(episode.season_number) > 0) {
    return Number(episode.season_number);
  }
  const raw = String(episode.title || "");
  const match = raw.match(/(?:T|S|TEMPORADA|SEASON)\s*[- ]?(\d{1,3})/i);
  const season = match ? Number(match[1]) : 1;
  return Number.isFinite(season) && season > 0 ? season : 1;
}

function episodeSort(a: DisplayEpisode, b: DisplayEpisode): number {
  return a.season_number - b.season_number ||
    a.episode_number - b.episode_number ||
    a.id.localeCompare(b.id);
}

/**
 * Une episodios equivalentes importados por varias fuentes del mismo título.
 * Las importaciones históricas pueden crear un MediaItem por plataforma; si
 * solo se utiliza una de esas filas, una fuente como ZokoAnime queda oculta
 * detrás de la fila elegida para LatAnime. Conservamos el primer id (la fila
 * canónica elegida por el caller) y unimos sus SourceLinks sin duplicados.
 */
export function mergeCanonicalEpisodes(
  groups: Array<CanonicalEpisodeForDisplay[] | null | undefined>,
): CanonicalEpisodeForDisplay[] {
  const merged = new Map<string, CanonicalEpisodeForDisplay>();
  for (const episodes of groups) {
    for (const episode of episodes || []) {
      const season = Number(episode.season_number) || 1;
      const number = Number(episode.episode_number);
      if (!Number.isFinite(number)) continue;
      const key = `${season}:${number}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...episode,
          season_number: season,
          episode_number: number,
          links: [...(episode.links || [])],
        });
        continue;
      }

      const seen = new Set(existing.links.map((link) =>
        `${String(link.source_site || link.host || "").toLowerCase()}|${String(link.url || "").trim()}`,
      ));
      for (const link of episode.links || []) {
        const keyForLink = `${String(link.source_site || link.host || "").toLowerCase()}|${String(link.url || "").trim()}`;
        if (!link.url || seen.has(keyForLink)) continue;
        seen.add(keyForLink);
        existing.links.push(link);
      }
    }
  }

  return [...merged.values()].sort((a, b) =>
    a.season_number - b.season_number ||
    a.episode_number - b.episode_number ||
    a.id.localeCompare(b.id),
  );
}

/**
 * Produces the episode list shown by a title ficha. Canonical MediaEpisodes
 * win whenever they have a main-path source; legacy rows are only a filtered,
 * deduplicated fallback for titles not yet mirrored into the canonical table.
 */
export function buildDisplayEpisodes(
  legacyEpisodes: LegacyEpisodeForDisplay[] | null | undefined,
  canonicalEpisodes: CanonicalEpisodeForDisplay[] | null | undefined,
  kind: MainPathKind,
  showId?: string,
): DisplayEpisode[] {
  const canonical = (canonicalEpisodes || [])
    .map((episode) => {
      const links = filterMainPathLinks(episode.links, kind);
      if (links.length === 0) return null;
      return {
        id: episode.id,
        show_id: showId,
        title: `Episodio ${episode.episode_number}`,
        episode_number: Number(episode.episode_number),
        season_number: Number(episode.season_number) || 1,
        source_url: links[0].url,
      } satisfies DisplayEpisode;
    })
    .filter((episode): episode is DisplayEpisode => Boolean(episode))
    .sort(episodeSort);

  if (canonical.length > 0) return canonical;

  const deduped = new Map<string, DisplayEpisode>();
  for (const episode of legacyEpisodes || []) {
    const links = filterMainPathLinks(
      episode.source_url ? [{ url: episode.source_url }] : [],
      kind,
    );
    if (links.length === 0) continue;

    const number = Number(episode.episode_number);
    if (!Number.isFinite(number)) continue;
    const season = seasonFromLegacyEpisode(episode);
    const normalized: DisplayEpisode = {
      ...episode,
      id: episode.id,
      show_id: episode.show_id || showId,
      episode_number: number,
      season_number: season,
      source_url: links[0].url,
    };
    const key = `${season}:${number}`;
    const previous = deduped.get(key);
    if (!previous || normalized.id.localeCompare(previous.id) < 0) deduped.set(key, normalized);
  }

  return [...deduped.values()].sort(episodeSort);
}

export function countDisplayPlatforms(
  episodes: CanonicalEpisodeForDisplay[] | null | undefined,
  displayEpisodes: DisplayEpisode[],
  kind: MainPathKind,
): Array<{ domain: string; episodes: number }> {
  const counts = new Map<string, number>();
  const canonicalLinks = (episodes || []).flatMap((episode) => filterMainPathLinks(episode.links, kind));
  if (canonicalLinks.length > 0) {
    for (const episode of episodes || []) {
      const links = filterMainPathLinks(episode.links, kind);
      const providers = new Set(links.map((link) => providerOf(link)));
      for (const provider of providers) counts.set(provider, (counts.get(provider) || 0) + 1);
    }
  } else {
    for (const episode of displayEpisodes) {
      const provider = providerOf(episode.source_url);
      if (isProviderAllowedInMainPath(provider, kind)) counts.set(provider, (counts.get(provider) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([domain, episodeCount]) => ({ domain, episodes: episodeCount }))
    .sort((a, b) => b.episodes - a.episodes || a.domain.localeCompare(b.domain));
}
