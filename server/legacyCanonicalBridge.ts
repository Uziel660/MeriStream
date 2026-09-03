/**
 * Matching helpers used by the legacy Episode/Show playback path.
 *
 * Old catalogue rows point at a page that is later extracted into an
 * ephemeral .m3u8.  When the same title already exists in MediaItem, the
 * playback route should use its canonical SourceLinks instead.  Keeping the
 * matching decision pure makes it cheap to test and prevents a fuzzy match
 * from silently replacing an unrelated title.
 */

export interface LegacyPlaybackIdentity {
  title?: string | null;
  normalized_title?: string | null;
  base_normalized_title?: string | null;
  tmdb_id?: number | null;
  year?: number | null;
  category?: string | null;
  episode_number?: number | null;
}

export interface CanonicalPlaybackCandidate {
  id: string;
  season_number: number;
  episode_number: number;
  media_item: {
    title: string;
    normalized_title: string;
    base_normalized_title?: string | null;
    tmdb_id?: number | null;
    year?: number | null;
    kind?: string | null;
  };
  links: Array<{ url: string; link_type: string }>;
}

type Normalizer = (value: string) => string;

function keyOf(value: unknown, normalize: Normalizer): string {
  return typeof value === "string" ? normalize(value) : "";
}

function sameEpisode(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return true;
  return Number(a) === Number(b);
}

/**
 * Selects the best canonical MediaEpisode for a legacy playback request.
 * Returns null unless there is a title or TMDB identity match and at least one
 * page/embed SourceLink.  Signed direct URLs are deliberately not considered
 * canonical here.
 */
export function selectCanonicalPlaybackCandidate(
  legacyShow: LegacyPlaybackIdentity,
  legacyEpisode: LegacyPlaybackIdentity | null | undefined,
  candidates: CanonicalPlaybackCandidate[],
  normalizeTitle: Normalizer,
  normalizeBaseTitle: Normalizer,
  isCanonicalLocator: (url: string) => boolean,
): CanonicalPlaybackCandidate | null {
  const legacyTitle = legacyShow.title || legacyShow.normalized_title || "";
  const legacyTitleKey = keyOf(legacyTitle, normalizeTitle);
  const legacyBaseKey = keyOf(legacyShow.base_normalized_title || legacyTitle, normalizeBaseTitle);
  const legacyTmdb = legacyShow.tmdb_id ?? null;
  const legacyYear = legacyShow.year ?? null;
  const legacyEpisodeNumber = legacyEpisode?.episode_number ?? legacyShow.episode_number ?? 1;
  const legacyKind = (legacyShow.category || "").toLowerCase();

  const scored = candidates
    .map((candidate) => {
      const item = candidate.media_item;
      const itemTitleKey = keyOf(item.normalized_title || item.title, normalizeTitle);
      const itemBaseKey = keyOf(item.base_normalized_title || item.title, normalizeBaseTitle);
      const tmdbMatch = legacyTmdb != null && item.tmdb_id != null && legacyTmdb === item.tmdb_id;
      const titleMatch = Boolean(legacyTitleKey && (legacyTitleKey === itemTitleKey || legacyTitleKey === keyOf(item.title, normalizeTitle)));
      const baseMatch = Boolean(legacyBaseKey && legacyBaseKey === itemBaseKey);
      const yearDiff = legacyYear != null && item.year != null ? Math.abs(legacyYear - item.year) : null;
      const yearMatch = yearDiff == null || yearDiff <= 1;
      const kindMatch = !legacyKind || !item.kind || legacyKind === item.kind.toLowerCase();
      const episodeMatch = sameEpisode(legacyEpisodeNumber, candidate.episode_number);
      const canonicalLinks = candidate.links.filter((link) =>
        (link.link_type === "page" || link.link_type === "embed") && isCanonicalLocator(link.url),
      );

      // A TMDB match is authoritative; without it require an exact normalized
      // title and a compatible year to avoid cross-title playback.
      if ((!tmdbMatch && !titleMatch && !baseMatch) || !episodeMatch || !yearMatch || !kindMatch || canonicalLinks.length === 0) {
        return null;
      }

      let score = canonicalLinks.length * 2;
      if (tmdbMatch) score += 100;
      if (titleMatch) score += 60;
      if (baseMatch) score += 40;
      if (yearDiff === 0) score += 15;
      else if (yearDiff == null || yearDiff <= 1) score += 5;
      if (kindMatch) score += 3;
      return { candidate, score };
    })
    .filter((entry): entry is { candidate: CanonicalPlaybackCandidate; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.candidate || null;
}

