import type { Episode, Show } from '../types';

export type PlaybackGatewayKind = 'movie' | 'series' | 'anime';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PlaybackBootstrapInput {
  show?: Show | null;
  episode: Episode;
  kind: PlaybackGatewayKind;
  preferredAudio?: readonly string[];
  preferredSubtitles?: readonly string[];
  fetchImpl?: FetchLike;
}

export interface PlaybackProviderResult {
  gatewayData: any | null;
  effectiveTmdbId: number;
  recoveredIdentity: boolean;
}

export interface PlaybackCoreResult extends PlaybackProviderResult {
  legacyData: any | null;
  legacyStatus: number | null;
}

export interface PlaybackSubtitleResult {
  effectiveTmdbId: number;
  data: any | null;
}

export interface PlaybackRequestBundle {
  /** Critical playback path. External subtitles never participate in it. */
  core: Promise<PlaybackCoreResult>;
  /** Provider/recovery request, exposed for optional late enrichment. */
  provider: Promise<PlaybackProviderResult>;
  /** Independent/later subtitle lookup. A failure resolves to data=null and never rejects playback. */
  subtitles: Promise<PlaybackSubtitleResult>;
}

function uniqueStrings(values: readonly unknown[] | undefined, max = 12): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of values || []) {
    const value = String(raw || '').replace(/\s+/g, ' ').trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= max) break;
  }
  return output;
}

function positiveInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function showYear(show?: Show | null): number | null {
  const value = Number(show?.year || show?.release_year || 0);
  return Number.isInteger(value) && value >= 1900 && value <= 2100 ? value : null;
}

function showAliases(show?: Show | null): string[] {
  return uniqueStrings([
    ...(show?.title_aliases || []),
    show?.original_title,
    show?.english_title,
    show?.japanese_title,
  ], 8);
}

async function safeJson(response: Response | null): Promise<any | null> {
  if (!response?.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function safeFetch(fetchImpl: FetchLike, input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetchImpl(input, init);
  } catch {
    return null;
  }
}

function normalizedPreferences(values: readonly string[] | undefined, fallback: readonly string[]): string[] {
  const cleaned = uniqueStrings(values);
  return cleaned.length > 0 ? cleaned : [...fallback];
}

function providerQuery(
  tmdbId: number,
  kind: PlaybackGatewayKind,
  season: number,
  episode: number,
  preferredAudio: readonly string[],
  preferredSubtitles: readonly string[],
): string {
  const query = new URLSearchParams({
    season: String(season),
    episode: String(episode),
    audio: preferredAudio.join(','),
    subtitles: preferredSubtitles.join(','),
  });
  return `/api/v1/providers/${kind}/${tmdbId}?${query.toString()}`;
}

function subtitleQuery(
  tmdbId: number,
  kind: PlaybackGatewayKind,
  season: number,
  episode: number,
  preferredSubtitles: readonly string[],
): string {
  const query = new URLSearchParams({
    tmdb_id: String(tmdbId),
    kind,
    languages: preferredSubtitles.join(','),
  });
  // Movies have no season/episode identity in OpenSubtitles-style APIs.
  if (kind !== 'movie') {
    query.set('season', String(season));
    query.set('episode', String(episode));
  }
  return `/api/v1/subtitles?${query.toString()}`;
}

function hasLegacyPlayback(data: any): boolean {
  if (typeof data?.stream_url === 'string' && data.stream_url.trim()) return true;
  if (Array.isArray(data?.ranked_streams) && data.ranked_streams.some((item: any) => String(item?.url || '').trim())) return true;
  if (Array.isArray(data?.all_available_streams) && data.all_available_streams.some((url: unknown) => String(url || '').trim())) return true;
  return false;
}

/**
 * Starts playback requests with subtitles deliberately outside the critical
 * path. Canonical TMDB cards resolve gateway + legacy exactly as before, but
 * never wait for external subtitles. Legacy cards are even more conservative:
 * a healthy DB stream wins immediately and title recovery stays in background;
 * only when the local path cannot play do we wait for the confidence-gated
 * recovery gateway.
 */
export function createPlaybackRequests(input: PlaybackBootstrapInput): PlaybackRequestBundle {
  const fetchImpl: FetchLike = input.fetchImpl || fetch.bind(globalThis);
  const tmdbId = positiveInt(input.show?.tmdb_id);
  const season = positiveInt(input.episode.season_number, 1);
  const episodeNumber = positiveInt(input.episode.episode_number, 1);
  const preferredAudio = normalizedPreferences(input.preferredAudio, ['es-419', 'es-ES', 'es', 'en', 'ja']);
  const preferredSubtitles = normalizedPreferences(input.preferredSubtitles, ['es-419', 'es-ES', 'es', 'en']);

  const provider: Promise<PlaybackProviderResult> = tmdbId > 0
    ? safeFetch(fetchImpl, providerQuery(tmdbId, input.kind, season, episodeNumber, preferredAudio, preferredSubtitles))
        .then(safeJson)
        .then((gatewayData) => ({ gatewayData, effectiveTmdbId: tmdbId, recoveredIdentity: false }))
    : safeFetch(fetchImpl, '/api/v1/providers/resolve-title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          kind: input.kind,
          title: String(input.show?.title || '').trim(),
          aliases: showAliases(input.show),
          year: showYear(input.show),
          imdbId: input.show?.imdb_id || null,
          season,
          episode: episodeNumber,
          preferredAudio,
          preferredSubtitles,
        }),
      })
        .then(safeJson)
        .then((recovery) => {
          const recoveredTmdbId = recovery?.resolved === true
            ? positiveInt(recovery?.identity?.tmdbId)
            : 0;
          return {
            gatewayData: recoveredTmdbId > 0 ? (recovery?.gateway || null) : null,
            effectiveTmdbId: recoveredTmdbId,
            recoveredIdentity: recoveredTmdbId > 0,
          };
        });

  const legacy = safeFetch(fetchImpl, `/api/v1/play/${encodeURIComponent(input.episode.id)}`)
    .then(async (response) => ({
      legacyStatus: response?.status ?? null,
      legacyData: await safeJson(response),
    }));

  const core: Promise<PlaybackCoreResult> = tmdbId > 0
    ? Promise.all([provider, legacy]).then(([providerResult, legacyResult]) => ({
        ...providerResult,
        ...legacyResult,
      }))
    : legacy.then(async (legacyResult) => {
        // Do not make a known-good imported source wait for a TMDB search and
        // a fresh provider cascade. Recovery still continues independently and
        // can later unlock external subtitles through `subtitles` below.
        if (hasLegacyPlayback(legacyResult.legacyData)) {
          return {
            gatewayData: null,
            effectiveTmdbId: 0,
            recoveredIdentity: false,
            ...legacyResult,
          };
        }
        const providerResult = await provider;
        return { ...providerResult, ...legacyResult };
      });

  // For canonical TMDB cards the subtitle request starts immediately and does
  // not wait for the gateway. Legacy cards chain only to identity recovery,
  // because external providers cannot be queried safely before an ID exists.
  const subtitleIdentity = tmdbId > 0
    ? Promise.resolve(tmdbId)
    : provider.then((result) => result.effectiveTmdbId);

  const subtitles = subtitleIdentity.then(async (effectiveTmdbId): Promise<PlaybackSubtitleResult> => {
    if (effectiveTmdbId <= 0) return { effectiveTmdbId: 0, data: null };
    const response = await safeFetch(
      fetchImpl,
      subtitleQuery(effectiveTmdbId, input.kind, season, episodeNumber, preferredSubtitles),
    );
    return { effectiveTmdbId, data: await safeJson(response) };
  });

  return { core, provider, subtitles };
}
