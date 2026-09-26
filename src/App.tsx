// src/App.tsx
import { lazy, Suspense, useEffect, useState, useMemo, useCallback, useRef } from 'react';

import { UnifiedHeader } from './components/UnifiedHeader';
import { HeroBanner } from './components/HeroBanner';
import { MediaRow } from './components/MediaRow';
import { CatalogFilters, type SortMode } from './components/CatalogFilters';
import { MediaCard } from './components/MediaCard';
import { MediaDetailsModal, HLSPlayerModal, AdminPanel, AuthModal, ContinueWatching } from './components/lazy/DeferredOverlays';
import type { WatchProgress } from './components/ContinueWatching';
import { BentoCollection } from './components/BentoCollection';
import { useAuth } from './contexts/AuthContext';
import { useHiddenGenres } from './hooks/useHiddenGenres';
import { thumbBackdropUrl } from './utils/imageSizes';
import { isEmbedUrl } from './utils/streamOptimizer';
import { api } from './api/client';
import { normalizeText, normalizeTextStrict } from './utils/searchUtils';
import { APP_PREFERENCES_EVENT, getAppPreferences } from './utils/appPreferences';
import { displayEpisodeTitle } from './utils/episodeLabels';
import { createPlaybackRequests } from './utils/playbackBootstrap';
import { RefreshCw, Film, Tv, ArrowUpRight, AlertCircle } from 'lucide-react';
import type { Show, Episode } from './types';
import { isNativeShell } from './utils/runtime';

const LazyExploreCatalogView = lazy(() => import('./components/ExploreCatalogView').then((module) => ({ default: module.ExploreCatalogView })));
const LazyMyListsView = lazy(() => import('./components/MyListsView').then((module) => ({ default: module.MyListsView })));
const LazyWatchPartyJoinModal = lazy(() => import('./components/WatchPartyJoinModal').then((module) => ({ default: module.WatchPartyJoinModal })));

const deferredSurfaceFallback = (
  <div className="py-14 text-center text-xs text-zinc-500" role="status" aria-live="polite">Cargando…</div>
);

const getContinueWatchingStorageKey = (userId?: string | null): string =>
  userId ? `meristream_continue_watching_${userId}` : 'meristream_guest_continue_watching_v1';

function loadContinueWatchingFromStorage(userId?: string | null): WatchProgress[] {
  try {
    const key = getContinueWatchingStorageKey(userId);
    const saved = localStorage.getItem(key);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    // Si el usuario está logueado pero no tiene datos en su clave específica, revisar si hay datos en invitado
    if (userId) {
      const guestSaved = localStorage.getItem('meristream_guest_continue_watching_v1');
      if (guestSaved) {
        const parsed = JSON.parse(guestSaved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          try { localStorage.setItem(key, guestSaved); } catch {}
          return parsed;
        }
      }
    }
    // Migración retroactiva: revisar voidstream_continue_watching_v1
    const legacy = localStorage.getItem('voidstream_continue_watching_v1');
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed) && parsed.length > 0) {
        try { localStorage.setItem(key, legacy); } catch {}
        return parsed;
      }
    }
  } catch {}
  return [];
}
// Bumped after the main-path provider cutover so a browser cannot briefly
// render cards that are now admin/legacy-only while the fresh request loads.
// Bumped after the unified TMDB rail started interleaving movie/series/anime;
// profiles with the old movie-only payload must fetch the corrected catalog.
const CATALOG_CACHE_KEY = 'nitiflix_catalog_cache_v5';
const RETIRED_CATALOG_CACHE_KEY = 'nitiflix_catalog_cache_v1';
const CATALOG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const SEARCH_CACHE_KEY = 'meristream_tmdb_search_cache_v1';
const SEARCH_CACHE_FRESH_TTL = 5 * 60 * 1000;
const SEARCH_CACHE_MAX_TTL = 30 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 12;
const PUBLIC_CATALOG_BATCH_SIZE = 60;
const HOME_GRID_INITIAL_SIZE = 48;
const HOME_RAIL_MAX_ITEMS = 12;
const HOME_RAIL_MIN_ITEMS = 8;
const HOME_GENRE_MAX_ITEMS = 12;
// React StrictMode monta la pantalla dos veces en desarrollo para detectar
// efectos no idempotentes. Mantener una promesa por usuario evita que ese
// ciclo (o dos montajes rápidos al volver a Inicio) descargue el mismo bloque
// de recomendaciones varias veces sin cambiar el resultado visible.
type RecommendationsResponse = Awaited<ReturnType<typeof api.getRecommendations>>;
const recommendationInFlight = new Map<string, Promise<RecommendationsResponse>>();
const RECOMMENDATION_CACHE_PREFIX = 'meristream_recommendations_v1:';

function readRecommendationCache(userKey: string): RecommendationsResponse | null {
  try {
    const raw = localStorage.getItem(`${RECOMMENDATION_CACHE_PREFIX}${userKey}`)
      || sessionStorage.getItem(`${RECOMMENDATION_CACHE_PREFIX}${userKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecommendationsResponse;
    return parsed && Array.isArray(parsed.rails) ? parsed : null;
  } catch {
    return null;
  }
}

function writeRecommendationCache(userKey: string, value: RecommendationsResponse): void {
  try {
    localStorage.setItem(`${RECOMMENDATION_CACHE_PREFIX}${userKey}`, JSON.stringify(value));
    sessionStorage.setItem(`${RECOMMENDATION_CACHE_PREFIX}${userKey}`, JSON.stringify(value));
  } catch {
    // A full/private browsing storage must never block the catalog.
  }
}

function requestRecommendationsOnce(userKey: string): Promise<RecommendationsResponse> {
  const existing = recommendationInFlight.get(userKey);
  if (existing) return existing;

  const next = api.getRecommendations().finally(() => {
    if (recommendationInFlight.get(userKey) === next) recommendationInFlight.delete(userKey);
  });
  recommendationInFlight.set(userKey, next);
  return next;
}
// Inicio mantiene suficiente metadata para repartirla entre sus secciones,
// pero las imágenes siguen siendo lazy y solo las cercanas al viewport se
// descargan. La primera respuesta es un snapshot estable de 100 resultados.
const HOME_CATALOG_FIRST_BATCH_SIZE = 100;
// The unified backend batch spans three TMDB pages per kind (20 rows each).
// Advance by that width when loading the next batch so pages do not overlap.
const PUBLIC_CATALOG_PAGE_STEP = 3;
type PublicCatalogKind = 'movie' | 'series' | 'anime';
const PUBLIC_CATALOG_KINDS: PublicCatalogKind[] = ['movie', 'series', 'anime'];
const PUBLIC_GENRE_IDS: Record<string, number> = {
  accion: 28,
  'accion y aventura': 10759,
  animacion: 16,
  aventura: 12,
  belica: 10752,
  'belica y politica': 10768,
  'ciencia ficcion': 878,
  'ciencia ficcion y fantasia': 10765,
  comedia: 35,
  crimen: 80,
  documental: 99,
  drama: 18,
  familia: 10751,
  fantasia: 14,
  guerra: 10768,
  'guerra y politica': 10768,
  historia: 36,
  infantil: 10762,
  kids: 10762,
  isekai: 10765,
  mecha: 878,
  misterio: 9648,
  musica: 10402,
  noticias: 10763,
  news: 10763,
  'pelicula de tv': 10770,
  reality: 10764,
  romance: 10749,
  seinen: 16,
  shounen: 16,
  'slice of life': 35,
  sobrenatural: 9648,
  suspenso: 53,
  suspense: 53,
  telenovela: 10766,
  soap: 10766,
  terror: 27,
  western: 37,
};

function publicGenreKey(value: string): string {
  return normalizeText(value).replace(/\s+/g, ' ');
}

/** Nunca renderizar "Episodio undefined" (#2): fallback al número de episodio. */
function safeEpisodeTitle(episode: { title?: string; episode_number?: number }): string {
  return displayEpisodeTitle(episode.title, episode.episode_number);
}

type AppUrlState = {
  showId: string | null;
  player: boolean;
  episodeId: string | null;
  episodeNumber: number | null;
  kind: string | null;
  partyCode: string | null;
  searchQuery: string;
  filter: string;
  genre: string | null;
};

const APP_ROUTE_QUERY_KEYS = [
  'show_id', 'show', 'view', 'player', 'episode_id', 'episode', 'kind',
  'party', 'room', 'q', 'filter', 'genre',
];

function decodeRoutePart(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readAppUrlState(): AppUrlState {
  if (typeof window === 'undefined') {
    return {
      showId: null,
      player: false,
      episodeId: null,
      episodeNumber: null,
      kind: null,
      partyCode: null,
      searchQuery: '',
      filter: 'all',
      genre: null,
    };
  }

  const url = new URL(window.location.href);
  const segments = url.pathname.split('/').filter(Boolean);
  const route = String(segments[0] || '').toLowerCase();
  const isDetailPath = ['obra', 'show', 'title'].includes(route) && Boolean(segments[1]);
  const isPlayerPath = ['ver', 'watch', 'reproducir', 'player'].includes(route);
  const pathShowId = isDetailPath || isPlayerPath ? decodeRoutePart(segments[1]) : null;
  const pathEpisodeId = isPlayerPath ? decodeRoutePart(segments[2]) : null;
  const showId = pathShowId || url.searchParams.get('show_id') || url.searchParams.get('show');
  const episodeId = pathEpisodeId || url.searchParams.get('episode_id');
  const episodeRaw = url.searchParams.get('episode');
  const episodeNumber = episodeRaw && Number.isFinite(Number(episodeRaw)) ? Number(episodeRaw) : null;
  const partyCode = url.searchParams.get('party') || url.searchParams.get('room');
  const player = isPlayerPath || url.searchParams.get('view') === 'player' || url.searchParams.get('player') === '1' || Boolean(url.searchParams.get('test_player'));

  return {
    showId,
    player,
    episodeId,
    episodeNumber,
    kind: url.searchParams.get('kind'),
    partyCode,
    searchQuery: url.searchParams.get('q') || '',
    filter: url.searchParams.get('filter') || 'all',
    genre: url.searchParams.get('genre'),
  };
}

function navigateAppRoute(
  pathname: string,
  params: Record<string, string | number | null | undefined> = {},
  mode: 'push' | 'replace' = 'push',
  routeName?: 'details' | 'player' | 'catalog',
): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.pathname = pathname;
  for (const key of APP_ROUTE_QUERY_KEYS) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  const state = { ...(window.history.state || {}), meristream_route: routeName || undefined };
  if (mode === 'replace') window.history.replaceState(state, '', next);
  else window.history.pushState(state, '', next);
}

/**
 * Subtitle URLs are issued by our backend proxy. External provider URLs are
 * intentionally dropped at this boundary so the browser never contacts a
 * subtitle host directly.
 */
function internalSubtitleUrl(raw: unknown): string | null {
  const value = String(raw || '').trim();
  const internalPath = /^\/api\/v1\/subtitles\/file\/[a-f0-9]{32}\.vtt(?:\?.*)?$/i;
  if (internalPath.test(value)) return value;
  if (!/^https?:\/\//i.test(value) || typeof window === 'undefined') return null;
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.origin === window.location.origin && internalPath.test(`${parsed.pathname}${parsed.search}`)
      ? `${parsed.pathname}${parsed.search}`
      : null;
  } catch {
    return null;
  }
}

function mapInternalSubtitleTrack(raw: any, id: string): any | null {
  const url = internalSubtitleUrl(raw?.url || raw?.src || raw?.file);
  if (!url) return null;
  return {
    id,
    label: raw?.label || raw?.language || 'Subtítulo',
    language: raw?.language || raw?.lang || 'und',
    url,
    is_default: Boolean(raw?.is_default || raw?.default),
  };
}

function mapCatalogShow(s: any): Show {
  return {
    id: s.id || `show-${Math.random()}`,
    title: s.title || 'Sin Título',
    tmdb_id: s.tmdb_id ?? null,
    imdb_id: s.imdb_id ?? null,
    anilist_id: s.anilist_id ?? null,
    mal_id: s.mal_id ?? null,
    kitsu_id: s.kitsu_id ?? null,
    title_aliases: Array.isArray(s.title_aliases) ? s.title_aliases.filter((value: unknown): value is string => typeof value === 'string') : [],
    kind: s.kind || s.category || undefined,
    original_title: s.original_title || null,
    original_language: s.original_language || null,
    english_title: s.english_title || null,
    japanese_title: s.japanese_title || null,
    description: s.description || s.synopsis || '',
    synopsis: s.description || s.synopsis || '',
    poster_url: s.poster_url || '',
    banner_url: s.banner_url || s.poster_url || '',
    backdrop_url: s.backdrop_url || s.banner_url || '',
    poster_path: s.poster_path ?? null,
    backdrop_path: s.backdrop_path ?? null,
    category: s.category || 'movie',
    rating: Number(s.rating || 0),
    popularity: Number.isFinite(Number(s.popularity)) ? Number(s.popularity) : undefined,
    year: s.year ?? null,
    genres: Array.isArray(s.genres)
      ? s.genres
      : String(s.genres || '').split(',').map((g: string) => g.trim()).filter(Boolean),
    episode_count: s.episode_count || s._count?.episodes || 0,
    is_trending: Boolean(s.is_trending),
    sources: {
      master_m3u8: s.sources?.master_m3u8 || '',
      fallback_mp4: null,
      qualities: [],
      subtitles: [],
    },
  } as Show;
}

function isPublicTmdbShow(show: Show): boolean {
  const tmdbId = Number(show.tmdb_id);
  return Number.isInteger(tmdbId) && tmdbId > 0 && /^tmdb-(?:movie|series|anime)-\d+$/i.test(String(show.id || ''));
}

function recommendationKind(show: Partial<Show>): 'movie' | 'series' | 'anime' {
  const rawCategory = String(show.category || show.kind || '').toLowerCase();
  if (rawCategory.includes('anime')) return 'anime';
  if (rawCategory.includes('movie') || rawCategory.includes('pel') || rawCategory.includes('film')) return 'movie';
  return 'series';
}

function mapRecommendationShow(value: unknown): Show | null {
  if (!value || typeof value !== 'object') return null;
  const mapped = mapCatalogShow(value);
  const tmdbId = Number(mapped.tmdb_id);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const kind = recommendationKind(mapped);
  return {
    ...mapped,
    id: `tmdb-${kind}-${tmdbId}`,
    kind,
    category: kind,
  };
}

function mapPublicCatalogShows(value: unknown): Show[] {
  if (!Array.isArray(value)) return [];
  return dedupeCatalogShows(value.map(mapCatalogShow).filter(isPublicTmdbShow));
}

type SearchCacheEntry = { savedAt: number; data: Show[] };

function readTmdbSearchCache(query: string): { data: Show[]; fresh: boolean } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SEARCH_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw) as Record<string, SearchCacheEntry>;
    const key = normalizeText(query);
    const entry = cache?.[key];
    if (!entry || !Number.isFinite(entry.savedAt) || Date.now() - entry.savedAt > SEARCH_CACHE_MAX_TTL) return null;
    const data = mapPublicCatalogShows(entry.data);
    return { data, fresh: Date.now() - entry.savedAt <= SEARCH_CACHE_FRESH_TTL };
  } catch {
    return null;
  }
}

function writeTmdbSearchCache(query: string, data: Show[]): void {
  if (typeof window === 'undefined') return;
  try {
    const key = normalizeText(query);
    const raw = window.sessionStorage.getItem(SEARCH_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) as Record<string, SearchCacheEntry> : {};
    const now = Date.now();
    const next: Record<string, SearchCacheEntry> = Object.fromEntries(
      Object.entries(cache)
        .filter(([, entry]) => entry && Number.isFinite(entry.savedAt) && now - entry.savedAt <= SEARCH_CACHE_MAX_TTL)
        .sort(([, left], [, right]) => right.savedAt - left.savedAt)
        .slice(0, SEARCH_CACHE_MAX_ENTRIES - 1),
    );
    next[key] = { savedAt: now, data: data.slice(0, 100) };
    window.sessionStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(next));
  } catch {
    // El caché de búsqueda es opcional y nunca debe bloquear la navegación.
  }
}

function catalogIdentityKey(show: Partial<Show>): string {
  const category = String(show.category || show.kind || 'media').toLowerCase();
  const namespace = /movie|pel[ií]cula/.test(category) ? 'movie' : 'tv';
  const canonicalTitle = normalizeTextStrict(String(show.title || show.original_title || ''))
    .replace(/(?:themovie|movie|pelicula|film)$/g, '');
  if (show.tmdb_id) {
    // Local provider rows can label a TMDB film as anime while the public
    // result labels it movie (Jujutsu Kaisen 0 is a common example). The
    // numeric id plus canonical title is safer here than trusting that label.
    return `tmdb:${show.tmdb_id}:${canonicalTitle || namespace}`;
  }
  // Legacy provider imports can contain the same work under different row
  // ids. Keep genuine releases with different years separate, but collapse
  // exact title/year duplicates before they reach a rail or search result.
  const title = canonicalTitle;
  const year = Number((show.year ?? show.release_year) || 0);
  return title
    ? `title:${category}:${title}:${Number.isFinite(year) ? year : 0}`
    : `id:${show.id || ''}`;
}

function dedupeCatalogShows(items: Show[]): Show[] {
  const unique = new Map<string, Show>();
  for (const item of items) {
    const key = catalogIdentityKey(item);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, item);
      continue;
    }
    // Preserve the richer row when duplicate legacy records disagree. This
    // matters for playback because one row may carry the repaired identity or
    // a poster while another only has a bare title.
    const previousScore = Number(Boolean(previous.tmdb_id)) * 4 + Number(Boolean(previous.poster_url)) * 2 + Number(previous.episode_count || 0);
    const currentScore = Number(Boolean(item.tmdb_id)) * 4 + Number(Boolean(item.poster_url)) * 2 + Number(item.episode_count || 0);
    if (currentScore > previousScore) unique.set(key, item);
  }
  return [...unique.values()];
}

function homeIdentityKey(show: Partial<Show>): string {
  const tmdbId = Number(show.tmdb_id);
  if (Number.isInteger(tmdbId) && tmdbId > 0) {
    const category = String(show.category || show.kind || '').toLowerCase();
    const family = /movie|pel[ií]cula|film/.test(category) ? 'movie' : 'tv';
    return `tmdb-home:${family}:${tmdbId}`;
  }
  return `local-home:${catalogIdentityKey(show)}`;
}

function takeUniqueHomeShows(items: Show[], usedKeys: Set<string>, limit = Number.POSITIVE_INFINITY): Show[] {
  const selected: Show[] = [];
  for (const item of items) {
    if (selected.length >= limit) break;
    const key = homeIdentityKey(item);
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    selected.push(item);
  }
  return selected;
}

function searchRelevanceScore(show: Show, query: string): number {
  const needle = normalizeTextStrict(query);
  if (!needle) return 0;
  const fields = [
    { value: show.title, weight: 1000 },
    ...(show.title_aliases || []).map((value) => ({ value, weight: 920 })),
    { value: show.english_title, weight: 880 },
    { value: show.original_title, weight: 840 },
    { value: show.japanese_title, weight: 800 },
  ];
  let best = 0;
  for (const field of fields) {
    const value = normalizeTextStrict(String(field.value || ''));
    if (!value) continue;
    if (value === needle) best = Math.max(best, field.weight);
    else if (value.startsWith(needle)) best = Math.max(best, field.weight - 100);
    else if (value.includes(needle)) best = Math.max(best, field.weight - 220);
  }
  return best;
}

export function searchShowMatchesQuery(show: Show, query: string): boolean {
  const needle = normalizeTextStrict(query);
  if (!needle) return false;
  return [
    show.title,
    ...(show.title_aliases || []),
    show.english_title,
    show.original_title,
    show.japanese_title,
  ].some((value) => normalizeTextStrict(String(value || '')).includes(needle));
}

function sortSearchResults(items: Show[], query = ''): Show[] {
  return [...items].sort((a, b) => {
    if (query) {
      const relevanceA = searchRelevanceScore(a, query);
      const relevanceB = searchRelevanceScore(b, query);
      if (relevanceB !== relevanceA) return relevanceB - relevanceA;
    }
    const popularityA = Number.isFinite(Number(a.popularity)) ? Number(a.popularity) : -1;
    const popularityB = Number.isFinite(Number(b.popularity)) ? Number(b.popularity) : -1;
    if (popularityB !== popularityA) return popularityB - popularityA;

    const ratingA = Number(a.rating || 0);
    const ratingB = Number(b.rating || 0);
    if (ratingB !== ratingA) return ratingB - ratingA;
    return String(a.title || '').localeCompare(String(b.title || ''), 'es', { sensitivity: 'base' });
  });
}

/**
 * A local provider row can have the right TMDB id but stale metadata (for
 * example Polar imported with the year of another film). When the same
 * identity arrives from the live TMDB catalog, keep the local id/episodes for
 * provider playback and overlay the canonical public metadata for the card.
 */
function mergeCanonicalPublicRow(existing: Show, incoming: Show): Show {
  const incomingIsPublic = /^tmdb-(?:movie|series|anime)-\d+$/.test(incoming.id);
  const existingIsPublic = /^tmdb-(?:movie|series|anime)-\d+$/.test(existing.id);
  if (!incomingIsPublic || existingIsPublic) return existing;

  const description = String(incoming.description || incoming.synopsis || '').trim();
  const yearConflict = Boolean(existing.year && incoming.year && existing.year !== incoming.year);
  const incomingPopularity = Number.isFinite(Number(incoming.popularity)) ? Number(incoming.popularity) : undefined;
  const publicIsUsable = Boolean(description || incoming.poster_url || incoming.backdrop_url || incoming.rating);
  if (!publicIsUsable && !yearConflict && incomingPopularity === undefined) return existing;

  return {
    ...existing,
    title: incoming.title || existing.title,
    // The bridge is only allowed for an unambiguous exact-title/type match,
    // so carrying the public identity into a bare local row is safe and keeps
    // subsequent detail/playback requests on the canonical TMDB path.
    tmdb_id: existing.tmdb_id ?? incoming.tmdb_id,
    // Keep the local/provider title as a searchable alias before replacing
    // the display label with TMDB's canonical translation. This preserves
    // searches such as "Shiguang Dailiren" when TMDB displays "Link Click".
    title_aliases: Array.from(new Set([
      ...(existing.title_aliases || []),
      existing.title,
      existing.original_title || '',
      existing.english_title || '',
      existing.japanese_title || '',
      ...(incoming.title_aliases || []),
    ].filter(Boolean))),
    original_title: incoming.original_title || existing.original_title,
    english_title: incoming.english_title || existing.english_title,
    japanese_title: incoming.japanese_title || existing.japanese_title,
    description: description || existing.description,
    synopsis: description || existing.synopsis,
    poster_url: incoming.poster_url || existing.poster_url,
    logo_url: incoming.logo_url || existing.logo_url,
    banner_url: incoming.banner_url || existing.banner_url,
    backdrop_url: incoming.backdrop_url || existing.backdrop_url,
    poster_path: incoming.poster_path || existing.poster_path,
    backdrop_path: incoming.backdrop_path || existing.backdrop_path,
    rating: incoming.rating || existing.rating,
    popularity: incomingPopularity ?? existing.popularity,
    year: incoming.year ?? existing.year,
    release_year: incoming.year ?? existing.release_year,
    episode_count: Math.max(Number(existing.episode_count || 0), Number(incoming.episode_count || 0)),
    status: incoming.status || existing.status,
  };
}

function searchTitleIdentity(show: Partial<Show>): string {
  const title = normalizeTextStrict(String(show.title || show.original_title || ''));
  const category = String(show.category || show.kind || '').toLowerCase();
  const namespace = /movie|pel[ií]cula|film/.test(category) ? 'movie' : 'tv';
  return title ? `${namespace}:${title}` : '';
}

function isBareLegacySearchRow(show: Show): boolean {
  return (
    !show.tmdb_id &&
    !show.mal_id &&
    !show.anilist_id &&
    !show.poster_url &&
    !show.poster_path &&
    !show.backdrop_url &&
    !show.backdrop_path &&
    !String(show.description || show.synopsis || '').trim() &&
    !Number(show.year || show.release_year || 0)
  );
}

/**
 * Search receives two intentionally different datasets: TMDB's public result
 * and local provider rows. A legacy row may have the exact title but no year,
 * identity or artwork, so its regular identity key cannot match TMDB's key.
 * Bridge only an unambiguous, same-type title match; remakes and ambiguous
 * names remain separate instead of being guessed together.
 */
export function mergeSearchCatalogRows(localRows: Show[], publicRows: Show[]): Show[] {
  const publicByTitle = new Map<string, Show[]>();
  for (const row of publicRows) {
    const titleKey = searchTitleIdentity(row);
    if (!titleKey || !row.tmdb_id) continue;
    const list = publicByTitle.get(titleKey) || [];
    list.push(row);
    publicByTitle.set(titleKey, list);
  }

  const merged = new Map<string, Show>();
  for (const local of localRows) {
    const titleKey = searchTitleIdentity(local);
    const candidates = [...new Map(
      (publicByTitle.get(titleKey) || []).map((row) => [row.tmdb_id, row])
    ).values()];
    if (isBareLegacySearchRow(local) && candidates.length === 1) {
      const publicRow = candidates[0];
      merged.set(catalogIdentityKey(publicRow), mergeCanonicalPublicRow(local, publicRow));
      continue;
    }
    merged.set(catalogIdentityKey(local), local);
  }

  for (const publicRow of publicRows) {
    const key = catalogIdentityKey(publicRow);
    const previous = merged.get(key);
    if (!previous) merged.set(key, publicRow);
    else merged.set(key, mergeCanonicalPublicRow(previous, publicRow));
  }

  return [...merged.values()];
}

export function App() {
  const { user, isAuthenticated, openAuthModal } = useAuth();
  const { isGenreHidden, isShowHidden } = useHiddenGenres();
  const nativeShell = isNativeShell();
  const browseGridBatchSize = nativeShell ? 36 : 100;
  const homeGridBatchSize = nativeShell ? 24 : HOME_GRID_INITIAL_SIZE;
  const [shows, setShows] = useState<Show[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(() => readAppUrlState().searchQuery);
  const [serverSearchResults, setServerSearchResults] = useState<Show[]>([]);
  const [activeFilter, setActiveFilter] = useState<string>(() => readAppUrlState().filter);
  const [gridPageSize, setGridPageSize] = useState(() => browseGridBatchSize);
  const [yearFilter, setYearFilter] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortMode>('recientes');
  const [catalogPageSize, setCatalogPageSize] = useState(() => homeGridBatchSize);
  const [publicCatalogPage, setPublicCatalogPage] = useState(1);
  const [hasMorePublicCatalog, setHasMorePublicCatalog] = useState(true);
  const [isLoadingMoreCatalog, setIsLoadingMoreCatalog] = useState(false);
  // Cada familia de TMDB lleva su propio cursor. Así un botón de Películas no
  // consume páginas de Series o Anime ni deja una categoría sin resultados.
  const [publicCatalogPages, setPublicCatalogPages] = useState<Record<PublicCatalogKind, number>>({ movie: 1, series: 1, anime: 1 });
  const [publicCatalogKindLoaded, setPublicCatalogKindLoaded] = useState<Record<PublicCatalogKind, boolean>>({ movie: false, series: false, anime: false });
  const [hasMorePublicCatalogByKind, setHasMorePublicCatalogByKind] = useState<Record<PublicCatalogKind, boolean>>({ movie: true, series: true, anime: true });
  const [isLoadingMoreCatalogByKind, setIsLoadingMoreCatalogByKind] = useState<Record<PublicCatalogKind, boolean>>({ movie: false, series: false, anime: false });
  const [publicGenrePages, setPublicGenrePages] = useState<Record<string, number>>({});
  const [hasMorePublicGenre, setHasMorePublicGenre] = useState<Record<string, boolean>>({});
  const [isLoadingMorePublicGenre, setIsLoadingMorePublicGenre] = useState<Record<string, boolean>>({});
  const [allGenresList, setAllGenresList] = useState<string[]>([]);
  const [exploreGenreFilter, setExploreGenreFilter] = useState<string | null>(() => readAppUrlState().genre);
  const autoLoadSentinelRef = useRef<HTMLDivElement | null>(null);
  const autoLoadInFlightRef = useRef<string | null>(null);

  // Continue Watching State
  const [continueWatchingItems, setContinueWatchingItems] = useState<WatchProgress[]>(() => {
    return loadContinueWatchingFromStorage(user?.id);
  });

  // Recommendation Rails & Ultimate Hero Pick from Backend (inicializados desde caché persistente)
  const [recommendationRails, setRecommendationRails] = useState<Array<{
    id: string;
    title: string;
    subtitle?: string;
    reason?: string;
    shows: Show[];
  }>>(() => {
    const cached = readRecommendationCache('anonymous');
    if (cached?.rails && Array.isArray(cached.rails)) {
      return cached.rails.map((rail) => ({
        ...rail,
        shows: dedupeCatalogShows(
          Array.isArray(rail.shows)
            ? rail.shows.map(mapRecommendationShow).filter((show): show is Show => Boolean(show && isPublicTmdbShow(show)))
            : []
        ).slice(0, HOME_RAIL_MAX_ITEMS),
      }));
    }
    return [];
  });
  const [heroRecommendation, setHeroRecommendation] = useState<Show | null>(() => {
    const cached = readRecommendationCache('anonymous');
    const hero = cached?.hero ? mapRecommendationShow(cached.hero) : null;
    return hero && isPublicTmdbShow(hero) ? hero : null;
  });
  const [isLoadingRecs, setIsLoadingRecs] = useState<boolean>(false);

  // Modal States
  const [selectedShowId, setSelectedShowId] = useState<string | null>(null);
  const [playingStreamData, setPlayingStreamData] = useState<any | null>(null);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [orphanNotice, setOrphanNotice] = useState<string | null>(null);
  const [isGlobalWatchPartyOpen, setIsGlobalWatchPartyOpen] = useState(false);
  const playerReturnToDetailsRef = useRef<string | null>(null);
  const bootstrappedPlayerRef = useRef<string | null>(null);
  const playerClosedToDetailsRef = useRef(false);

  const handleJoinWatchPartyFromHeader = useCallback(async (code: string) => {
    const sanitized = code.toUpperCase().trim();
    if (!sanitized) return;
    try {
      const roomData = await api.getRoomInfo(sanitized);
      if (!roomData || !roomData.media) {
        throw new Error('No se encontró la sala o no tiene contenido activo.');
      }

      setIsGlobalWatchPartyOpen(false);

      const media = roomData.media;
      const tmdbId = media.tmdbId ? Number(media.tmdbId) : null;
      const kind = (media.kind || 'movie').toLowerCase();
      const showId = media.showId || (tmdbId ? `tmdb-${kind}-${tmdbId}` : 'watch-party');
      const episodeId = media.episodeId || null;

      playerReturnToDetailsRef.current = null;
      const currentRoute = readAppUrlState();
      navigateAppRoute(
        episodeId ? `/ver/${encodeURIComponent(showId)}/${encodeURIComponent(String(episodeId))}` : `/ver/${encodeURIComponent(showId)}`,
        {
          episode: media.episodeNumber,
          kind,
          party: sanitized,
        },
        currentRoute.partyCode === sanitized ? 'replace' : 'push',
        'player',
      );

      setPlayingStreamData({
        showId,
        tmdbId,
        kind,
        episodeId,
        episodeNumber: media.episodeNumber || null,
        title: media.title || 'Watch Party',
        streamUrl: media.streamUrl || undefined,
        initialPartyRoomCode: sanitized,
        partyRoomCode: sanitized,
        isLoading: !media.streamUrl,
      });
    } catch (err: any) {
      console.error('[WatchParty Join Error]', err);
      throw err;
    }
  }, []);

  // Apertura directa de fichas, búsquedas, salas y reproducciones desde URL.
  useEffect(() => {
    const applyUrlState = () => {
      const route = readAppUrlState();
      setSearchQuery(route.searchQuery);
      setActiveFilter(route.filter);
      setExploreGenreFilter(route.genre);
      if (route.player) setSelectedShowId(null);
      else if (route.showId) setSelectedShowId(route.showId);
      else setSelectedShowId(null);

      if (route.partyCode && !playingStreamData) {
        void handleJoinWatchPartyFromHeader(route.partyCode);
      }

      if (new URLSearchParams(window.location.search).get('test_player')) {
      setPlayingStreamData({
        title: 'Breaking Bad — S01E01',
        streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
        all_streams: [{ id: 'mock-1', provider: 'Servidor Rápido', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' }],
        ranked_streams: [{ id: 'mock-1', provider: 'Servidor Rápido', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' }],
        showId: 'mock-show',
        showTitle: 'Breaking Bad',
        episodeId: 'mock-ep-1',
        episodeNumber: 1,
        episodeTitle: 'Piloto',
        isLoading: false,
        onNextEpisode: () => console.log('Next episode clicked'),
      });
      }
    };

    applyUrlState();
    window.addEventListener('popstate', applyUrlState);
    return () => window.removeEventListener('popstate', applyUrlState);
  }, [handleJoinWatchPartyFromHeader]);

  // Aplica los ajustes visuales de cada perfil sin forzar un recálculo del
  // catálogo. La clave personal se lee bajo demanda para que cambiarla en
  // Preferencias afecte a la siguiente petición y nunca quede en el bundle.
  useEffect(() => {
    const applyPreferences = () => {
      const preferences = getAppPreferences(user?.id);
      document.documentElement.dataset.msContrast = preferences.contrast;
      document.documentElement.dataset.msReduceMotion = preferences.reduceMotion ? 'true' : 'false';
    };
    applyPreferences();
    window.addEventListener(APP_PREFERENCES_EVENT, applyPreferences);
    return () => window.removeEventListener(APP_PREFERENCES_EVENT, applyPreferences);
  }, [user?.id]);

  const tmdbRequestInit = useCallback((): RequestInit => {
    const preferences = getAppPreferences(user?.id);
    const key = preferences.tmdbApiKeyEnabled ? preferences.tmdbApiKey.trim() : '';
    return key ? { headers: { 'X-TMDB-Personal-Key': key } } : {};
  }, [user?.id]);

  // Arnés local para validar VidSrc directamente en el reproductor interno.
  // Solo se activa en Vite dev mediante ?vidsrc-local-test=1; no forma parte
  // del flujo de producción ni depende del catálogo persistido.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('vidsrc-local-test')) return;

    const kind = params.get('vidsrc-kind') === 'series' ? 'series' : 'movie';
    const tmdbId = Number(params.get('vidsrc-tmdb') || (kind === 'series' ? 1396 : 550));
    const season = Number(params.get('vidsrc-season') || 1);
    const episode = Number(params.get('vidsrc-episode') || 1);
    const title = kind === 'series' ? 'Breaking Bad — S01E01' : 'Fight Club';
    const showId = 'vidsrc-local-' + kind + '-' + tmdbId;
    let cancelled = false;

    setPlayingStreamData({
      title,
      streamUrl: '',
      all_streams: [],
      ranked_streams: [],
      showId,
      showTitle: title,
      episodeId: showId,
      episodeNumber: episode,
      episodeTitle: title,
      isLoading: true,
    });

    const query = new URLSearchParams({
      season: String(season),
      episode: String(episode),
      audio: 'es,en,ja',
      subtitles: 'es,en',
    });
    fetch(`/api/v1/providers/${kind}/${tmdbId}?${query.toString()}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('VidSrc gateway HTTP ' + response.status);
        return response.json();
      })
      .then((data) => {
        const sources = Array.isArray(data?.sources)
          ? data.sources.filter((source: any) => source?.provider === 'vidsrc' && source?.streamType === 'hls' && source?.url)
          : [];
        const fallbackLocator = kind === 'movie'
          ? `https://vidsrc.me/embed/movie/${tmdbId}`
          : `https://vidsrc.me/embed/tv/${tmdbId}/${season}/${episode}`;
        // Para el arnés local preferimos el mirror que ya expone más de una
        // pista de audio. El resto de mirrors sigue disponible como fallback.
        const orderedSources = [
          ...sources.filter((candidate: any) =>
            Array.isArray(candidate.audioTracks) && candidate.audioTracks.length > 1,
          ),
          ...sources,
        ].filter((candidate: any, index: number, all: any[]) =>
          all.findIndex((entry) => entry.canonicalLocator === candidate.canonicalLocator) === index,
        );
        const fallbackSource = {
          provider: 'vidsrc',
          canonicalLocator: fallbackLocator,
          url: '',
          streamType: 'hls',
          audioLanguage: 'en',
          subtitleLanguage: null,
        };
        const sessionSources = orderedSources.length > 0 ? orderedSources : [fallbackSource];
        const source = sessionSources[0];
        const subtitleTracksForSource = (candidate: any) => Array.isArray(candidate.subtitles)
          ? candidate.subtitles.map((track: any, trackIndex: number) => ({
              id: `${candidate.provider || 'vidsrc'}-${track.id || trackIndex}`,
              label: track.label || track.language || 'Subtítulo',
              language: track.language || track.lang || 'und',
              url: track.url || track.src,
              is_default: Boolean(track.is_default || track.default),
            })).filter((track: any) => /^https?:\/\//i.test(String(track.url || '')))
          : [];
        const sessionForSource = async (candidate: any, index: number): Promise<any> => {
          const sessionResponse = await fetch('/api/v1/playback/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ original_url: candidate.canonicalLocator || candidate.url }),
          });
          if (sessionResponse.ok) {
            return {
              sources: [candidate],
              session: await sessionResponse.json(),
              sourceSubtitleTracks: subtitleTracksForSource(candidate),
            };
          }
          if (index + 1 < sessionSources.length) return sessionForSource(sessionSources[index + 1], index + 1);
          throw new Error('VidSrc proxy session HTTP ' + sessionResponse.status);
        };
        return sessionForSource(source, 0);
      })
      .then(({ sources, session, sourceSubtitleTracks }) => {
        if (cancelled) return;
        const playbackUrl = session.playback_url;
        const ranked = sources.slice(0, 1).map((source: any, index: number) => ({
          // El arnés usa la URL opaca local; el HLS firmado queda solo como
          // evidencia del resolver y nunca se expone al navegador.
          url: playbackUrl,
          type: 'direct' as const,
          tier: index,
          provider: source.provider,
          source_site: source.provider,
          original_url: source.canonicalLocator || source.url,
          canonical_locator: source.canonicalLocator || source.url,
          // La URL ya es una sesión proxy local. Sus headers del CDN se
          // aplican server-side y no deben crear un segundo proxy.
          requiredHeaders: undefined,
          is_proxyable: false,
          is_refreshable: false,
          delivery_mode: 'direct' as const,
          rating: 10,
          audio_language: source.audioLanguage || undefined,
          subtitle_language: source.subtitleLanguage || undefined,
          subtitles: sourceSubtitleTracks,
        }));
        setPlayingStreamData((previous: any) => previous
          ? {
              ...previous,
              streamUrl: ranked[0].url,
              all_streams: ranked.map((candidate: any) => candidate.url),
              // Este arnés valida el relay dentro del player sin mezclar el
              // failover de mirrors. La sesión ya es local.
              ranked_streams: ranked,
              subtitleTracks: sourceSubtitleTracks,
              isLoading: false,
            }
          : previous);
      })
      .catch((error: any) => {
        if (cancelled) return;
        setPlayingStreamData((previous: any) => previous
          ? { ...previous, loadError: error?.message || 'No se pudo resolver VidSrc', isLoading: false }
          : previous);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Sincronizar progreso local / servidor según el usuario activo o invitado
  useEffect(() => {
    const key = getContinueWatchingStorageKey(user?.id);
    const local = loadContinueWatchingFromStorage(user?.id);
    if (local.length > 0) {
      setContinueWatchingItems(local);
    }

    if (isAuthenticated && user?.id) {
      api.getProgress().then((res) => {
        if (Array.isArray(res?.items) && res.items.length > 0) {
          const serverItems = res.items as WatchProgress[];
          const mergedMap = new Map<string, WatchProgress>();
          for (const item of serverItems) mergedMap.set(item.episodeId, item);
          for (const item of local) {
            const existing = mergedMap.get(item.episodeId);
            if (!existing || (item.lastWatchedAt || 0) > (existing.lastWatchedAt || 0)) {
              mergedMap.set(item.episodeId, item);
            }
          }
          const mergedList = Array.from(mergedMap.values()).sort((a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0));
          setContinueWatchingItems(mergedList);
          try {
            localStorage.setItem(key, JSON.stringify(mergedList));
          } catch {}
        } else if (local.length > 0) {
          // Si el servidor está vacío pero tenemos progreso local, sincronizar al servidor
          local.forEach((item) => {
            api.saveProgress(item).catch(() => {});
          });
        }
      }).catch((e) => {
        console.warn('Error sincronizando progreso con servidor:', e);
      });
    }
  }, [isAuthenticated, user?.id]);

  // Cargar rieles de recomendación personalizadas del algoritmo y el Hero Pick
  const fetchRecommendations = useCallback(async (forceRefresh = false) => {
    setIsLoadingRecs(true);
    try {
      const recommendationKey = user?.id ? String(user.id) : 'anonymous';
      // Keep one recommendation snapshot for the browser session. The user
      // can explicitly request a new snapshot with “Actualizar”; routine
      // remounts/reloads must not reshuffle visible cards.
      const cached = forceRefresh ? null : readRecommendationCache(recommendationKey);
      const res = cached || await requestRecommendationsOnce(recommendationKey);
      if (!cached) writeRecommendationCache(recommendationKey, res);
      const mappedHero = res?.hero ? mapRecommendationShow(res.hero) : null;
      const nextHero = mappedHero && isPublicTmdbShow(mappedHero) ? mappedHero : null;
      setHeroRecommendation((prev) => (prev?.id === nextHero?.id ? prev : nextHero));
      if (Array.isArray(res?.rails)) {
        const nextRails = res.rails.map((rail) => ({
          ...rail,
          shows: dedupeCatalogShows(
            Array.isArray(rail.shows)
              ? rail.shows
                .map(mapRecommendationShow)
                .filter((show): show is Show => Boolean(show && isPublicTmdbShow(show) && !isShowHidden(show)))
              : [],
          ).slice(0, HOME_RAIL_MAX_ITEMS),
        }));
        setRecommendationRails((prev) => {
          const prevSig = prev.map((r) => `${r.id}:${r.shows.map((s) => s.id).join(',')}`).join('|');
          const nextSig = nextRails.map((r) => `${r.id}:${r.shows.map((s) => s.id).join(',')}`).join('|');
          return prevSig === nextSig ? prev : nextRails;
        });
      }
    } catch (e) {
      console.warn('Error cargando recomendaciones:', e);
    } finally {
      setIsLoadingRecs(false);
    }
  }, [isShowHidden, user?.id]);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations, user]);

  // Eliminar un item de "Seguir Viendo" del estado, storage y servidor
  const removeContinueWatchingItem = useCallback((episodeIdOrShowId: string, showId?: string) => {
    setContinueWatchingItems((prev) => {
      const next = prev.filter((p) => {
        if (p.episodeId === episodeIdOrShowId) return false;
        if (p.showId === episodeIdOrShowId) return false;
        if (showId && p.showId === showId) return false;
        return true;
      });
      try {
        localStorage.setItem(getContinueWatchingStorageKey(user?.id), JSON.stringify(next));
      } catch {}
      return next;
    });

    if (isAuthenticated) {
      if (episodeIdOrShowId) {
        api.deleteProgressItem(episodeIdOrShowId).catch(() => {});
      }
      const targetShow = showId || episodeIdOrShowId;
      if (targetShow) {
        api.deleteProgressShow(targetShow).catch(() => {});
      }
    }
  }, [isAuthenticated, user?.id]);

  // Actualizar en sitio un item de "Seguir Viendo" (reparación de metadatos)
  const updateContinueWatchingItem = useCallback((item: WatchProgress) => {
    setContinueWatchingItems((prev) => {
      const idx = prev.findIndex((p) => p.episodeId === item.episodeId);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = item;
      try {
        localStorage.setItem(getContinueWatchingStorageKey(user?.id), JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [user?.id]);

  // Fetch all genres from server API (Anime & Movies/Series APIs)
  useEffect(() => {
    const fetchGenres = async () => {
      try {
        const res = await fetch('/api/v1/genres');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.genres)) {
            setAllGenresList(data.genres);
          }
        }
      } catch (e) {
        console.error('Error cargando géneros:', e);
      }
    };
    fetchGenres();
  }, []);

  // Búsqueda pública TMDB con debounce. El caché de sesión muestra una consulta
  // reciente al instante y la petición siguiente revalida en segundo plano;
  // las filas privadas de proveedores nunca se mezclan en los resultados.
  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) {
      setServerSearchResults([]);
      return;
    }
    const cached = readTmdbSearchCache(query);
    setServerSearchResults(cached?.data || []);
    const controller = new AbortController();
    let isCancelled = false;
    const fetchServerSearch = async () => {
      try {
        // 40 results consume only two TMDB pages per family instead of the
        // previous 100-result request plus a second PostgreSQL search.
        const publicRes = await fetch(`/api/v1/catalog/search?q=${encodeURIComponent(query)}&limit=40`, { ...tmdbRequestInit(), signal: controller.signal });
        if (isCancelled) return;
        if (!publicRes.ok) return;
        const data = await publicRes.json();
        const list = Array.isArray(data) ? data : data.shows || [];
        const publicShows = mapPublicCatalogShows(list);
        const sorted = sortSearchResults(publicShows, query);
        writeTmdbSearchCache(query, sorted);
        setServerSearchResults(sorted);
      } catch (e: any) {
        if (e?.name !== 'AbortError') console.warn('Error en búsqueda server-side:', e);
      }
    };
    // The header already debounces keystrokes; 260ms avoids issuing a request
    // for every intermediate character on slow keyboards.
    const timer = window.setTimeout(fetchServerSearch, cached?.fresh ? 320 : 260);
    return () => {
      isCancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, tmdbRequestInit]);

  // LIMPIEZA DE METADATOS EN "SEGUIR VIENDO": repara títulos "undefined" sin borrar
  // obras arbitrariamente solo porque no están en las primeras 40 fichas cargadas.
  const purgeOrphanContinueWatching = useCallback(
    async (catalog: Show[]) => {
      const saved = localStorage.getItem(getContinueWatchingStorageKey(user?.id));
      if (!saved) return;
      let items: WatchProgress[];
      try {
        items = JSON.parse(saved);
      } catch {
        return;
      }
      if (!Array.isArray(items) || items.length === 0) return;

      const showById = new Map(catalog.map((s) => [s.id, s]));

      // Solo marcar como corrupto si carece por completo de episodeId o showId
      const isCorrupted = (it: WatchProgress) => !it?.episodeId || !it?.showId;

      let changed = false;
      const validItems: WatchProgress[] = [];

      items.forEach((it) => {
        if (isCorrupted(it)) {
          changed = true;
          removeContinueWatchingItem(it.episodeId);
        } else {
          // Reparar título de episodio o show si dice "undefined"
          const fixed: WatchProgress = { ...it };
          const show = showById.get(it.showId);
          if ((!fixed.showTitle || /^undefined$/i.test(String(fixed.showTitle))) && show?.title) {
            fixed.showTitle = show.title;
          }
          if (
            (!fixed.episodeTitle || /^undefined$/i.test(fixed.episodeTitle) || /^Episodio undefined$/i.test(fixed.episodeTitle)) &&
            typeof fixed.episodeNumber === 'number'
          ) {
            fixed.episodeTitle = `Episodio ${fixed.episodeNumber}`;
          }
          if (fixed.showTitle !== it.showTitle || fixed.episodeTitle !== it.episodeTitle) {
            changed = true;
            updateContinueWatchingItem(fixed);
          }
          validItems.push(fixed);
        }
      });

      if (changed) {
        setContinueWatchingItems(validItems);
      }
    },
    [removeContinueWatchingItem, updateContinueWatchingItem, user?.id]
  );

  // 1. Cargar el catálogo público sin episodios. En Inicio se piden hasta 150
  // filas ligeras desde TMDB; los proveedores solo se resuelven al abrir una
  // ficha/reproducir y nunca entran en el estado público de tarjetas.
  const fetchFreshCatalog = async (
    isBackground = false,
    page = 1,
    append = false,
    requestedLimit = PUBLIC_CATALOG_BATCH_SIZE,
  ): Promise<{ lastFetchedPage: number; hasMore: boolean; usedPublicCatalog: boolean } | null> => {
    try {
      const publicRes = await fetch(`/api/v1/catalog/public?kind=all&mode=trending&limit=${requestedLimit}&page=${page}`, tmdbRequestInit());
      // TMDB is the only public catalog. If it is unavailable, retain the
      // already-rendered TMDB cache instead of showing provider-owned rows with
      // incomplete identity or artwork.
      if (publicRes.ok) {
        if (!isBackground) setCatalogError(null);
        const data = await publicRes.json();
        const list = Array.isArray(data) ? data : data.shows || [];
        if (Array.isArray(list)) {
          const safeShows: Show[] = mapPublicCatalogShows(list);
          // The endpoint aggregates three TMDB pages into one 60-item batch.
          // Keep the real upstream cursor so the next request starts after the
          // whole batch instead of repeating pages 2 and 3.
          const lastFetchedPage = Array.isArray(data)
            ? page
            : Math.max(page, Number(data?.nextPage || page + PUBLIC_CATALOG_PAGE_STEP) - 1);
          const hasMore = safeShows.length > 0 && (
            Array.isArray(data) || !data?.totalPages || lastFetchedPage < Number(data.totalPages)
          );

          if (append) {
            // Merge by the namespaced TMDB id so loading the next public batch
            // cannot reintroduce duplicates from provider or legacy rows.
            setShows((previous) => {
              const merged = new Map(previous.map((show) => [show.id, show]));
              for (const show of safeShows) merged.set(show.id, show);
              return [...merged.values()];
            });
            setPublicCatalogPage(lastFetchedPage);
            setHasMorePublicCatalog(hasMore);
            setPublicCatalogPages((previous) => ({
              movie: Math.max(previous.movie, lastFetchedPage),
              series: Math.max(previous.series, lastFetchedPage),
              anime: Math.max(previous.anime, lastFetchedPage),
            }));
            try {
              const cached = localStorage.getItem(CATALOG_CACHE_KEY);
              const cachedData = cached ? JSON.parse(cached).data : [];
              const merged = new Map<string, Show>(mapPublicCatalogShows(cachedData).map((show) => [show.id, show]));
              for (const show of safeShows) merged.set(show.id, show);
              localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ data: [...merged.values()], timestamp: Date.now() }));
            } catch {}
            return { lastFetchedPage, hasMore, usedPublicCatalog: true };
          }

          setPublicCatalogPage(lastFetchedPage);
          setHasMorePublicCatalog(hasMore);
          setPublicCatalogPages(Object.fromEntries(PUBLIC_CATALOG_KINDS.map((kind) => [kind, lastFetchedPage])) as Record<PublicCatalogKind, number>);

          // Only re-render if catalog actually changed (avoids SmartImage reset)
          if (isBackground) {
            const currentIds = shows.map(s => s.id).join(',');
            const newIds = safeShows.map(s => s.id).join(',');
            if (currentIds === newIds) return { lastFetchedPage, hasMore, usedPublicCatalog: true };
          }

          setShows(safeShows);
          setHasMorePublicCatalogByKind(Object.fromEntries(PUBLIC_CATALOG_KINDS.map((kind) => [kind, true])) as Record<PublicCatalogKind, boolean>);

          // Save to cache
          try {
            localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({
              data: safeShows,
              timestamp: Date.now(),
            }));
          } catch {}
          return { lastFetchedPage, hasMore, usedPublicCatalog: true };
        }
      } else if (!isBackground) {
        setCatalogError(`No se pudo cargar el catálogo (HTTP ${publicRes.status}).`);
      }
    } catch (e) {
      if (!isBackground) console.error('Error cargando catálogo:', e);
      if (!isBackground) setCatalogError('No se pudo conectar con el catálogo. Comprueba el túnel e inténtalo de nuevo.');
    }
    return null;
  };

  const preloadHomeCatalog = async () => {
    const firstBatch = await fetchFreshCatalog(
      false,
      1,
      false,
      HOME_CATALOG_FIRST_BATCH_SIZE,
    );
    if (!firstBatch?.usedPublicCatalog || !firstBatch.hasMore) return;

    // The first response is the complete initial snapshot for Inicio. Do not
    // append a second batch in the background: changing `shows` after the
    // screen is visible makes the hero and recommendation fallbacks move.
    // Additional catalog pages are still loaded explicitly by the catalog's
    // “Cargar más” controls.
  };

  const loadMorePublicCatalog = async () => {
    if (isLoadingMoreCatalog || !hasMorePublicCatalog) return;
    setIsLoadingMoreCatalog(true);
    try {
      // `kind=all&limit=60` consumes three TMDB pages per request. The state
      // stores the last page already consumed, so continue at the next one.
      await fetchFreshCatalog(true, publicCatalogPage + 1, true);
      setCatalogPageSize((previous) => previous + (nativeShell ? homeGridBatchSize : PUBLIC_CATALOG_BATCH_SIZE));
    } finally {
      setIsLoadingMoreCatalog(false);
    }
  };

  const loadMorePublicCatalogKind = async (kind: PublicCatalogKind, reset = false) => {
    if (isLoadingMoreCatalogByKind[kind] || (!reset && !hasMorePublicCatalogByKind[kind])) return;
    setIsLoadingMoreCatalogByKind((previous) => ({ ...previous, [kind]: true }));
    // El cursor guarda la última página de TMDB realmente incluida en el lote.
    // El endpoint agrega tres páginas por llamada, así que la siguiente debe
    // comenzar en la página contigua y nunca saltarse 4/5.
    const nextPage = reset ? 1 : publicCatalogPages[kind] + 1;
    try {
      const response = await fetch(`/api/v1/catalog/public?kind=${kind}&mode=discover&limit=${PUBLIC_CATALOG_BATCH_SIZE}&page=${nextPage}`, tmdbRequestInit());
      if (!response.ok) throw new Error(`TMDB ${kind}: HTTP ${response.status}`);
      const data = await response.json();
      const list = Array.isArray(data) ? data : data.shows || [];
      const safeShows: Show[] = mapPublicCatalogShows(list);
      setShows((previous) => {
        const merged = new Map(previous.map((show) => [show.id, show]));
        for (const show of safeShows) merged.set(show.id, show);
        return [...merged.values()];
      });
      const totalPages = Number(data?.totalPages || 0);
      const consumedPages = Math.max(1, Math.min(PUBLIC_CATALOG_PAGE_STEP, Math.ceil(safeShows.length / 20)));
      const lastFetchedPage = Math.max(nextPage, Number(data?.nextPage || nextPage + consumedPages) - 1);
      setPublicCatalogPages((previous) => ({ ...previous, [kind]: lastFetchedPage }));
      setPublicCatalogKindLoaded((previous) => ({ ...previous, [kind]: true }));
      setHasMorePublicCatalogByKind((previous) => ({
        ...previous,
        [kind]: safeShows.length > 0 && (!totalPages || lastFetchedPage < totalPages),
      }));
      try {
        const cached = localStorage.getItem(CATALOG_CACHE_KEY);
        const cachedData = cached ? JSON.parse(cached).data : [];
        const merged = new Map<string, Show>(mapPublicCatalogShows(cachedData).map((show) => [show.id, show]));
        for (const show of safeShows) merged.set(show.id, show);
        localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ data: [...merged.values()], timestamp: Date.now() }));
      } catch { /* cache is an optional optimization */ }
    } catch (error) {
      console.warn(`No se pudo cargar más ${kind} desde TMDB`, error);
    } finally {
      setIsLoadingMoreCatalogByKind((previous) => ({ ...previous, [kind]: false }));
    }
  };

  const loadMorePublicGenre = async (genre: string, reset = false) => {
    const genreKey = publicGenreKey(genre);
    const genreId = PUBLIC_GENRE_IDS[genreKey];
    if (!genreId || isLoadingMorePublicGenre[genreKey] || (!reset && hasMorePublicGenre[genreKey] === false)) return;

    setIsLoadingMorePublicGenre((previous) => ({ ...previous, [genreKey]: true }));
    const nextPage = reset ? 1 : (publicGenrePages[genreKey] || 0) + 1;
    try {
      const response = await fetch(`/api/v1/catalog/public?kind=all&genre=${genreId}&mode=discover&limit=${PUBLIC_CATALOG_BATCH_SIZE}&page=${nextPage}`, tmdbRequestInit());
      if (!response.ok) throw new Error(`TMDB género ${genreKey}: HTTP ${response.status}`);
      const data = await response.json();
      const list = Array.isArray(data) ? data : data.shows || [];
      const safeShows: Show[] = mapPublicCatalogShows(list);
      setShows((previous) => {
        const merged = new Map(previous.map((show) => [show.id, show]));
        for (const show of safeShows) merged.set(show.id, show);
        return [...merged.values()];
      });

      const consumedPages = Math.max(1, Math.min(PUBLIC_CATALOG_PAGE_STEP, Math.ceil(safeShows.length / 20)));
      const lastFetchedPage = Math.max(nextPage, Number(data?.nextPage || nextPage + consumedPages) - 1);
      const totalPages = Number(data?.totalPages || 0);
      setPublicGenrePages((previous) => ({ ...previous, [genreKey]: lastFetchedPage }));
      setHasMorePublicGenre((previous) => ({
        ...previous,
        [genreKey]: safeShows.length > 0 && (!totalPages || lastFetchedPage < totalPages),
      }));
    } catch (error) {
      console.warn(`No se pudo cargar más del género ${genreKey} desde TMDB`, error);
    } finally {
      setIsLoadingMorePublicGenre((previous) => ({ ...previous, [genreKey]: false }));
    }
  };

  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
    navigateAppRoute('/', { q: query.trim() || null }, 'replace', 'catalog');
  }, []);

  const handleSelectCategory = (filter: string) => {
    setActiveFilter(filter);
    setGridPageSize(browseGridBatchSize);
    if (filter === 'all') setCatalogPageSize(homeGridBatchSize);

    navigateAppRoute(
      '/',
      {
        filter: filter === 'all' ? null : filter,
        genre: null,
        q: null,
      },
      'push',
      'catalog',
    );

    const kind = PUBLIC_CATALOG_KINDS.includes(filter as PublicCatalogKind) ? filter as PublicCatalogKind : null;
    if (kind && !publicCatalogKindLoaded[kind]) void loadMorePublicCatalogKind(kind, true);

    const genreKey = publicGenreKey(filter);
    if (PUBLIC_GENRE_IDS[genreKey] && !Object.prototype.hasOwnProperty.call(publicGenrePages, genreKey)) {
      void loadMorePublicGenre(genreKey, true);
    }
  };

  const handleExploreGenreFilter = (genre: string | null) => {
    setExploreGenreFilter(genre);
    setCatalogPageSize(homeGridBatchSize);
    navigateAppRoute('/', { filter: 'explore', genre: genre || null }, 'replace', 'catalog');
    if (!genre) return;
    const genreKey = publicGenreKey(genre);
    if (PUBLIC_GENRE_IDS[genreKey] && !Object.prototype.hasOwnProperty.call(publicGenrePages, genreKey)) {
      void loadMorePublicGenre(genreKey, true);
    }
  };

  const loadCatalog = async () => {
    try {
      setIsLoading(true);
      setCatalogError(null);

      // 1. Try cache first (instant)
      try {
        // Remove the pre-provider-cutover cache once per browser profile. The
        // old payload may contain legacy-only cards that the public API no
        // longer returns.
        localStorage.removeItem(RETIRED_CATALOG_CACHE_KEY);
        const cached = localStorage.getItem(CATALOG_CACHE_KEY);
        if (cached) {
          const { data, timestamp } = JSON.parse(cached);
          const publicCachedData = mapPublicCatalogShows(data);
          const publicCachedKinds = new Set(
            publicCachedData.map((show) => String(show.category || show.kind || '').toLowerCase()),
          );
          const publicCacheHasAllFamilies = PUBLIC_CATALOG_KINDS.every((kind) => publicCachedKinds.has(kind));
          if (Date.now() - timestamp < CATALOG_CACHE_TTL && publicCachedData.length > 0 && publicCacheHasAllFamilies) {
            setShows(publicCachedData);
            setPublicCatalogPage(1);
            setHasMorePublicCatalog(true);
            setPublicCatalogPages(Object.fromEntries(PUBLIC_CATALOG_KINDS.map((kind) => {
              const count = publicCachedData.filter((show: Show) => String(show.category || show.kind || '').toLowerCase() === kind).length;
              return [kind, Math.max(1, Math.ceil(count / 20))];
            })) as Record<PublicCatalogKind, number>);
            setHasMorePublicCatalogByKind(Object.fromEntries(PUBLIC_CATALOG_KINDS.map((kind) => [kind, true])) as Record<PublicCatalogKind, boolean>);
            setIsLoading(false);
            // Keep the cached snapshot stable. A manual catalog refresh (or
            // an explicit “Cargar más”) is what should replace/extend it.
            return;
          }
        }
      } catch {}

      // 2. No cache or expired: fetch normally
      await preloadHomeCatalog();
    } catch (e) {
      console.error('Error cargando catálogo:', e);
    } finally {
      setIsLoading(false);
    }
  };

  // Cargar UNA VEZ al montar (no re-cargar en cada búsqueda)
  useEffect(() => {
    loadCatalog();
  }, []);

  // Tras cargar el catálogo, purgar las tarjetas de "Seguir Viendo" que
  // apunten a episodios/shows ya borrados (#2/R2).
  useEffect(() => {
    if (shows.length > 0) {
      void purgeOrphanContinueWatching(shows);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shows]);

  const handleOpenDetails = (show: Show) => {
    if (!show?.id) return;
    playerReturnToDetailsRef.current = null;
    playerClosedToDetailsRef.current = false;
    setPlayingStreamData(null);
    setSelectedShowId(show.id);
    navigateAppRoute(`/obra/${encodeURIComponent(show.id)}`, {}, 'push', 'details');
  };

  const handleCloseDetails = () => {
    setSelectedShowId(null);
    const route = readAppUrlState();
    if (route.player) return;
    // Cerrar una ficha justo después de salir del reproductor ya está sobre
    // la entrada correcta de detalles. Reemplazarla evita que el navegador
    // vuelva a mostrar la misma ficha una segunda vez.
    if (playerClosedToDetailsRef.current) {
      playerClosedToDetailsRef.current = false;
      navigateAppRoute('/', {}, 'replace', 'catalog');
      return;
    }
    if (window.history.state?.meristream_route === 'details' && window.history.length > 1) {
      window.history.back();
    } else {
      navigateAppRoute('/', {}, 'replace', 'catalog');
    }
  };

  const handleClosePlayer = () => {
    const route = readAppUrlState();
    const returnShowId = playerReturnToDetailsRef.current;
    setPlayingStreamData(null);
    if (!route.player) {
      playerReturnToDetailsRef.current = null;
      return;
    }
    // Los reproductores abiertos desde la app ya tienen una entrada propia.
    // Volver a ella conserva exactamente la búsqueda/filtro anterior y evita
    // dejar dos fichas iguales consecutivas en el historial.
    if (window.history.state?.meristream_route === 'player' && window.history.length > 1) {
      playerClosedToDetailsRef.current = Boolean(returnShowId);
      window.history.back();
      playerReturnToDetailsRef.current = null;
      return;
    }
    if (returnShowId) {
      setSelectedShowId(returnShowId);
      navigateAppRoute(`/obra/${encodeURIComponent(returnShowId)}`, {}, 'replace', 'details');
    } else {
      setSelectedShowId(null);
      navigateAppRoute('/', {}, 'replace', 'catalog');
    }
    playerReturnToDetailsRef.current = null;
  };

  const handleSelectEpisode = async (episode: Episode, showTitle: string, showOverride?: Show) => {
    const showId = episode.show_id || selectedShowId || 'unknown';
    const route = readAppUrlState();
    const wasPlaying = Boolean(playingStreamData);
    const publicIdentity = /^tmdb-(movie|series|anime)-(\d+)$/i.exec(showId);
    const knownShow = showOverride || shows.find((s) => s.id === showId)
      || serverSearchResults.find((s) => s.id === showId);
    const publicKind = publicIdentity?.[1].toLowerCase();
    const currentShow = publicIdentity
      ? {
        ...knownShow,
        id: showId,
        title: knownShow?.title || showTitle,
        tmdb_id: knownShow?.tmdb_id ?? Number(publicIdentity[2]),
        kind: publicKind,
        category: publicKind,
      } as Show
      : knownShow;
    const sourceHint = String((episode as any)?.source_url || '').toLowerCase();
    const locatorIdentity = /^tmdb:\/\/(movie|series|anime)\/(\d+)/i.exec(sourceHint);
    const rawKindForUrl = String(
      publicKind || showOverride?.kind || showOverride?.category || currentShow?.kind || currentShow?.category
      || locatorIdentity?.[1] || route.kind || '',
    ).toLowerCase();
    const kindForUrl = rawKindForUrl.includes('anime') ? 'anime' : rawKindForUrl.includes('movie') || rawKindForUrl.includes('pel') ? 'movie' : 'series';
    if (!wasPlaying && selectedShowId) playerReturnToDetailsRef.current = selectedShowId;
    else if (!selectedShowId) playerReturnToDetailsRef.current = null;
    setSelectedShowId(null);
    navigateAppRoute(
      `/ver/${encodeURIComponent(showId)}/${encodeURIComponent(String(episode.id))}`,
      {
        episode: episode.episode_number,
        kind: kindForUrl,
      },
      route.player || wasPlaying ? 'replace' : 'push',
      'player',
    );
    // La tarjeta de búsqueda puede proceder del lote server-side y no estar
    // todavía en `shows`; conserva sus IDs canónicos para activar gateway y
    // subtítulos igual que una tarjeta del catálogo principal.
    const existingProgress = continueWatchingItems.find(p => p.showId === showId && p.episodeId === episode.id)
      || continueWatchingItems.find(p => p.showId === showId && p.episodeNumber === episode.episode_number)
      || continueWatchingItems.find(p => (showTitle && p.showTitle && p.showTitle.toLowerCase().trim() === showTitle.toLowerCase().trim()) && (p.episodeId === episode.id || p.episodeNumber === episode.episode_number));
    const initialTime = existingProgress?.currentTime || 0;

    // Abrir el reproductor inmediatamente. El bootstrap de fuentes y la
    // búsqueda externa de subtítulos continúan en paralelo.
    setPlayingStreamData({
      title: `${showTitle} - ${safeEpisodeTitle(episode)}`,
      streamUrl: '',
      all_streams: [],
      initialTime,
      showId,
      showTitle,
      showPoster: (currentShow && thumbBackdropUrl(currentShow)) || undefined,
      episodeId: episode.id,
      episodeNumber: episode.episode_number,
      episodeTitle: safeEpisodeTitle(episode),
      tmdbId: currentShow?.tmdb_id ?? null,
      kind: currentShow?.kind || currentShow?.category || null,
      isLoading: true,
    });

    const resolvedTitle = safeEpisodeTitle(episode);

    try {
      const rawCategory = String((currentShow as any)?.kind || currentShow?.category || '').toLowerCase();
      const gatewayKind = rawCategory.includes('anime') || sourceHint.startsWith('tmdb://anime/')
        ? 'anime'
        : (rawCategory.includes('movie') || rawCategory.includes('pel') || sourceHint.startsWith('tmdb://movie/'))
          ? 'movie'
          : 'series';

      const playbackShow: Show = currentShow || {
        id: showId,
        title: showTitle,
        category: gatewayKind,
        kind: gatewayKind,
      };
      const preferences = getAppPreferences(user?.id);
      const playbackRequests = createPlaybackRequests({
        show: playbackShow,
        episode,
        kind: gatewayKind,
        preferredAudio: preferences.preferredLanguages,
        preferredSubtitles: preferences.preferredSubtitleLanguages,
      });

      // OpenSubtitles y equivalentes no forman parte de la ruta crítica. Si
      // llegan después de iniciar el video se anexan al player sin reiniciarlo.
      void playbackRequests.subtitles
        .then(({ data: subtitleData }) => {
          const externalSubtitles = Array.isArray(subtitleData?.tracks)
            ? subtitleData.tracks
                .map((track: any, index: number) => mapInternalSubtitleTrack(track, String(track.id || `opensubtitles-${index}`)))
                .filter(Boolean)
            : [];
          if (externalSubtitles.length === 0) return;

          setPlayingStreamData((prev: any) => {
            if (!prev || prev.episodeId !== episode.id) return prev;
            const byUrl = new Map<string, any>();
            for (const track of Array.isArray(prev.subtitleTracks) ? prev.subtitleTracks : []) {
              if (track?.url) byUrl.set(track.url, track);
            }
            for (const track of externalSubtitles) {
              if (track?.url && !byUrl.has(track.url)) byUrl.set(track.url, track);
            }
            return { ...prev, subtitleTracks: [...byUrl.values()] };
          });
        })
        .catch(() => undefined);

      const { gatewayData, legacyData, legacyStatus } = await playbackRequests.core;

      // Un gateway puede devolver muchos mirrors del mismo proveedor. Limitar
      // a tres mantiene failover real sin convertir un host caído en tormenta.
      const gatewaySourceCount = new Map<string, number>();
      const gatewaySources = Array.isArray(gatewayData?.sources)
        ? gatewayData.sources.filter((source: any) => {
            const provider = String(source?.provider || 'api').toLowerCase();
            const count = gatewaySourceCount.get(provider) || 0;
            if (count >= 3) return false;
            gatewaySourceCount.set(provider, count + 1);
            return true;
          })
        : [];
      const gatewayRanked = gatewaySources.length > 0
        ? gatewaySources.map((source: any, index: number) => {
            let host: string | null = null;
            try { host = new URL(source.url).hostname.replace(/^www\./, ''); } catch {}
            return {
              url: source.url,
              type: 'direct' as const,
              tier: index,
              host,
              provider: source.provider,
              source_site: source.provider,
              original_url: source.canonicalLocator || source.url,
              canonical_locator: source.canonicalLocator || source.url,
              is_proxyable: true,
              is_refreshable: Boolean(source.canonicalLocator),
              delivery_mode: source.requiredHeaders ? 'proxy_required' as const : 'direct_trial' as const,
              requiredHeaders: source.requiredHeaders,
              rating: 10,
              link_type: source.audioLanguage ? 'audio' : undefined,
              language: source.audioLanguage || undefined,
              audio_language: source.audioLanguage || undefined,
              subtitle_language: source.subtitleLanguage || undefined,
              subtitles: Array.isArray(source.subtitles)
                ? source.subtitles
                    .map((track: any, trackIndex: number) => mapInternalSubtitleTrack(track, `${source.provider || 'api'}-${trackIndex}`))
                    .filter(Boolean)
                : [],
            };
          })
        : [];

      // Los locators canónicos siguen disponibles como fallback porque el
      // HLSPlayerModal los resuelve JIT mediante el adaptador especializado.
      const gatewayFallbacks = Array.isArray(gatewayData?.fallbackCandidates)
        ? gatewayData.fallbackCandidates.map((source: any, index: number) => {
            let host: string | null = null;
            try { host = new URL(source.url).hostname.replace(/^www\./, ''); } catch {}
            return {
              url: source.url,
              type: 'embed' as const,
              tier: gatewayRanked.length + index,
              host,
              provider: source.provider,
              source_site: source.provider,
              canonical_locator: source.canonicalLocator || source.url,
              original_url: source.url,
              delivery_mode: 'embed' as const,
              is_refreshable: true,
              is_proxyable: false,
              requiredHeaders: undefined,
              link_type: source.type,
              language: source.audioLanguage || undefined,
              audio_language: source.audioLanguage || undefined,
              subtitle_language: source.subtitleLanguage || undefined,
              subtitles: Array.isArray(source.subtitles)
                ? source.subtitles
                    .map((track: any, trackIndex: number) => mapInternalSubtitleTrack(track, `${source.provider || 'fallback'}-${index}-${trackIndex}`))
                    .filter(Boolean)
                : [],
            };
          })
        : [];

      const mergedRanked: any[] = [];
      const seenUrls = new Set<string>();
      for (const candidate of [
        ...gatewayRanked,
        ...gatewayFallbacks,
        ...(Array.isArray(legacyData?.ranked_streams) ? legacyData.ranked_streams : []),
      ]) {
        if (!candidate?.url || seenUrls.has(candidate.url)) continue;
        seenUrls.add(candidate.url);
        mergedRanked.push(candidate);
      }

      const mergedStreams = mergedRanked.map((candidate) => candidate.url);
      const primaryStream = mergedStreams[0] || legacyData?.stream_url || '';

      if (!primaryStream) {
        // Las fichas públicas TMDB usan episodios virtuales y no deben borrarse
        // por un 404 de la tabla legacy. Las filas locales sí conservan la
        // limpieza de huérfanos histórica.
        const isPublicVirtualEpisode = /^tmdb-(?:movie|series|anime)-\d+(?:-s\d+-e\d+)?$/i.test(String(episode.id || ''))
          || /^tmdb-(?:movie|series|anime)-\d+$/i.test(String(currentShow?.id || ''));
        if (legacyStatus === 404 && !isPublicVirtualEpisode) {
          removeContinueWatchingItem(episode.id);
          setPlayingStreamData((prev: any) =>
            prev?.episodeId === episode.id ? null : prev
          );
          setOrphanNotice(
            `"${showTitle} — ${resolvedTitle}" ya no está disponible en el catálogo y fue eliminado de Seguir Viendo.`
          );
          return;
        }
        throw new Error('No se encontró un stream directo ni un fallback reproducible');
      }

      setPlayingStreamData((prev: any) => {
        if (!prev || prev.episodeId !== episode.id) return prev;
        return {
          ...prev,
          title: `${showTitle} - ${resolvedTitle}`,
          streamUrl: primaryStream,
          all_streams: mergedStreams.length > 0 ? mergedStreams : [primaryStream],
          ranked_streams: mergedRanked,
          isLoading: false,
        };
      });
    } catch (e: any) {
      setPlayingStreamData((prev: any) => {
        if (!prev || prev.episodeId !== episode.id) return prev;
        return {
          ...prev,
          loadError: e.message || 'Error al iniciar la reproducción',
          isLoading: false,
        };
      });
    }
  };

  // Una URL de reproducción se puede abrir directamente, incluso después de
  // recargar o compartirla. Resolver la ficha y el episodio una sola vez
  // evita duplicar peticiones cuando el catálogo termina de hidratarse.
  useEffect(() => {
    const route = readAppUrlState();
    if (!route.player || !route.showId || !route.episodeId) {
      if (!route.player) bootstrappedPlayerRef.current = null;
      return;
    }

    const routeKey = `${route.showId}:${route.episodeId}:${route.episodeNumber || ''}`;
    if (bootstrappedPlayerRef.current === routeKey) return;
    let cancelled = false;

    const bootstrap = async () => {
      let currentShow: any = shows.find((show) => show.id === route.showId)
        || serverSearchResults.find((show) => show.id === route.showId)
        || null;
      let detail: any = null;

      try {
        const localResponse = await fetch(`/api/v1/shows/${encodeURIComponent(route.showId as string)}`, tmdbRequestInit());
        if (localResponse.ok) detail = await localResponse.json();
      } catch {
        // Una fila pública de TMDB no existe necesariamente en la tabla local.
      }

      if (!detail) {
        const publicMatch = String(route.showId).match(/^tmdb-(movie|series|anime)-(\d+)$/i);
        if (publicMatch) {
          const publicKind = (route.kind || publicMatch[1]).toLowerCase();
          try {
            const publicResponse = await fetch(`/api/v1/catalog/public/${publicKind}/${publicMatch[2]}`, tmdbRequestInit());
            if (publicResponse.ok) detail = await publicResponse.json();
          } catch {
            // El reproductor mostrará el error de resolución si el gateway tampoco responde.
          }
        }
      }

      currentShow = detail || currentShow;
      const episodes = Array.isArray(currentShow?.episodes) ? currentShow.episodes : [];
      let episode: Episode | undefined = episodes.find((candidate: Episode) => String(candidate.id) === String(route.episodeId));
      if (!episode && route.episodeNumber !== null) {
        episode = episodes.find((candidate: Episode) => Number(candidate.episode_number) === route.episodeNumber);
      }

      if (!episode) {
        const publicMatch = String(route.showId).match(/^tmdb-(movie|series|anime)-(\d+)$/i);
        const publicKind = (route.kind || publicMatch?.[1] || currentShow?.kind || currentShow?.category || 'series').toLowerCase();
        episode = {
          id: route.episodeId,
          show_id: route.showId,
          title: currentShow?.title || route.showId,
          episode_number: route.episodeNumber || 1,
          season_number: 1,
          source_url: publicMatch ? `tmdb://${publicKind}/${publicMatch[2]}/1/${route.episodeNumber || 1}` : undefined,
        } as Episode;
      }

      if (cancelled || !episode) return;
      bootstrappedPlayerRef.current = routeKey;
      await handleSelectEpisode(
        { ...episode, show_id: route.showId } as Episode,
        currentShow?.title || route.showId,
        currentShow as Show | undefined,
      );
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
    // handleSelectEpisode is intentionally omitted: it is recreated on every
    // render, while the route key and catalog data are the actual triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSearchResults, shows]);

  // Conteo de shows por género para el modal
  const showsCountByGenre = useMemo(() => {
    const counts: Record<string, number> = {};
    shows.forEach((s) => {
      if (isShowHidden(s)) return;
      const genresStr = Array.isArray(s.genres) ? s.genres.join(', ') : String(s.genres || '');
      genresStr.split(',').forEach((g) => {
        const key = g.trim().toLowerCase();
        if (key && !isGenreHidden(g)) {
          counts[key] = (counts[key] || 0) + 1;
        }
      });
    });
    return counts;
  }, [isGenreHidden, isShowHidden, shows]);

  // Filtrado suave de catálogo por categorías y géneros
  const filteredShows = useMemo(() => {
    let result = shows.filter((show) => !isShowHidden(show));

    // Si hay búsqueda activa, mostrar únicamente resultados canónicos de TMDB.
    if (searchQuery && searchQuery.trim().length >= 2) {
      const visibleServerSearchResults = serverSearchResults.filter((show) => !isShowHidden(show));
      // Keep the canonical TMDB response authoritative, but let a locally
      // imported row be found by its stored/IMDb-era aliases as well. The
      // identity bridge only joins an unambiguous TMDB match; otherwise the
      // local row remains a separate candidate instead of being guessed away.
      const localSearchResults = result
        .filter((show) => searchShowMatchesQuery(show, searchQuery))
        .slice(0, 200);
      const seen = new Set<string>();
      result = mergeSearchCatalogRows(localSearchResults, visibleServerSearchResults).filter((show) => {
        const key = catalogIdentityKey(show);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      result = sortSearchResults(result, searchQuery.trim());
    } else {
      // Filtro por categoría únicamente cuando no hay búsqueda activa
      if (activeFilter !== 'all') {
        const filterKey = activeFilter.toLowerCase();
        result = result.filter((s) => {
          const cat = (s.category || '').toLowerCase();
          const title = (s.title || '').toLowerCase();
          const genresStr = Array.isArray(s.genres) ? s.genres.join(' ').toLowerCase() : String(s.genres || '').toLowerCase();

          if (filterKey === 'anime') return cat === 'anime' || (cat !== 'movie' && cat !== 'series' && genresStr.includes('anime'));
          if (filterKey === 'movie') return cat.includes('pel') || cat.includes('movie');
          if (filterKey === 'series') return cat.includes('serie') || cat.includes('tv');
          if (filterKey === 'terror') return genresStr.includes('terror') || genresStr.includes('horror') || genresStr.includes('misterio');
          if (filterKey === 'horror') return genresStr.includes('terror') || genresStr.includes('horror') || genresStr.includes('misterio');
          if (filterKey === 'acción' || filterKey === 'accion') return genresStr.includes('acci') || genresStr.includes('action');
          if (filterKey === 'fantasía' || filterKey === 'fantasia') return genresStr.includes('fantas') || genresStr.includes('fantasy');
          if (filterKey === 'ciencia ficción' || filterKey === 'sci-fi' || filterKey === 'scifi') return genresStr.includes('sci-fi') || genresStr.includes('ciencia') || genresStr.includes('futuro');
          if (filterKey === 'suspenso') return genresStr.includes('suspen') || genresStr.includes('thriller');
          if (filterKey === 'shounen' || filterKey === 'shonen') return genresStr.includes('shounen') || genresStr.includes('shonen') || title.includes('piece') || title.includes('naruto') || title.includes('dragon');
          if (filterKey === 'seinen') return genresStr.includes('seinen') || genresStr.includes('psicológico') || genresStr.includes('drama');
          if (filterKey === 'romance') return genresStr.includes('romance') || genresStr.includes('amor');
          return genresStr.includes(filterKey) || cat.includes(filterKey) || title.includes(filterKey);
        });
      }
    }

    // Filtro por año
    if (yearFilter !== null) {
      result = result.filter((s) => Number(s.year) === yearFilter);
    }

    // Orden (recientes = orden de ingesta tal cual llega)
    if (sortBy !== 'recientes') {
      const sorted = [...result];
      if (sortBy === 'rating') sorted.sort((a, b) => (b.rating || 0) - (a.rating || 0));
      else if (sortBy === 'anio') sorted.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
      else if (sortBy === 'az') sorted.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'es'));
      result = sorted;
    }

    return result;
  }, [isShowHidden, shows, serverSearchResults, activeFilter, searchQuery, yearFilter, sortBy]);

  // Años disponibles para el filtro (de más nuevo a más viejo)
  const availableYears = useMemo(() => {
    const set = new Set<number>();
    for (const s of shows) {
      const y = Number(s.year);
      if (y >= 1940 && y <= new Date().getFullYear() + 1) set.add(y);
    }
    return [...set].sort((a, b) => b - a);
  }, [shows]);

  // Filas por GÉNERO: los géneros más comunes del catálogo, cada uno ordenado
  // por rating. Reemplaza las viejas filas "por recencia" (anime/internacional).
  const genreRows = useMemo(() => {
    if (shows.length === 0) return [];
    const toList = (g: unknown): string[] =>
      Array.isArray(g) ? g.map(String) : String(g || '').split(',');
    const counts = new Map<string, number>();
    for (const s of shows) {
      if (isShowHidden(s)) continue;
      for (const g of toList(s.genres)) {
        const clean = g.trim();
        if (!clean) continue;
        const low = clean.toLowerCase();
        if (low === 'multimedia' || low === 'anime' || low === 'película' || low === 'serie' || isGenreHidden(clean)) continue;
        counts.set(clean, (counts.get(clean) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([genre]) => ({
        genre,
        items: shows
          .filter((s) => !isShowHidden(s) && toList(s.genres).map((x) => x.trim()).includes(genre))
          .sort((a, b) => (b.rating || 0) - (a.rating || 0))
          .slice(0, 40),
      }))
      .filter((r) => r.items.length >= 8);
  }, [isGenreHidden, isShowHidden, shows]);



  // SELECCIÓN INTELIGENTE DEL HERO BANNER (Máxima Calidad Visual + Máxima Afinidad)
  const featuredShow = useMemo(() => {
    if (shows.length === 0) return null;

    const watchedIds = new Set(continueWatchingItems.map((item) => item.showId).filter(Boolean));
    const visibleShows = shows.filter((show) => !isShowHidden(show));
    const unwatchedShows = visibleShows.filter((show) => !watchedIds.has(show.id));
    const heroPool = unwatchedShows.length > 0 ? unwatchedShows : visibleShows;

    // 1. Si el servidor nos dio un Hero Pick personalizado con buena imagen, usarlo
    if (heroRecommendation) {
      const matchInCatalog = visibleShows.find((s) => s.id === heroRecommendation.id);
      const target = matchInCatalog || heroRecommendation;
      const hasVisuals = Boolean((target as any).backdrop_path || (target as any).banner_url || target.poster_url);
      if (hasVisuals && (heroPool.includes(target) || heroPool.length === 0)) {
        return target;
      }
    }

    // 2. Extraer afinidad de géneros basada en el historial del usuario
    const genreScore: Record<string, number> = {};

    continueWatchingItems.forEach((it, idx) => {
      const show = visibleShows.find((s) => s.id === it.showId);
      if (show && show.genres) {
        const weight = Math.max(1, 5 - idx);
        const list = Array.isArray(show.genres) ? show.genres : String(show.genres).split(/[,/|•]+/);
        list.forEach((g) => {
          const clean = g.trim().toLowerCase();
          if (clean && !/multimedia|general/i.test(clean)) {
            genreScore[clean] = (genreScore[clean] || 0) + weight;
          }
        });
      }
    });

    const topGenres = Object.entries(genreScore)
      .sort((a, b) => b[1] - a[1])
      .map(([g]) => g);

    // 3. Puntuar cada obra para elegir la opción definitiva con backdrop épico
    let bestShow: Show | null = null;
    let bestScore = -Infinity;

    for (const s of heroPool) {
      let score = 0;

      // A. Calidad visual de backdrop / poster
      const hasBackdrop = Boolean((s as any).backdrop_path && (s as any).backdrop_path.startsWith('/'));
      const hasBanner = Boolean((s as any).banner_url && (s as any).banner_url.startsWith('http'));
      const hasPoster = Boolean((s as any).poster_path || (s.poster_url && s.poster_url.startsWith('http')));

      if (!hasBackdrop && !hasBanner && !hasPoster) continue;

      if (hasBackdrop) score += 90; // Backdrop TMDB panorámico en alta definición
      else if (hasBanner) score += 65; // Banner oficial
      else if (hasPoster) score += 25;

      if (s.poster_url && /unsplash|placeholder|default/i.test(s.poster_url)) {
        score -= 120;
      }

      // B. Calidad de sinopsis
      if (s.description && s.description.length > 70 && !/contenido indexado en/i.test(s.description)) {
        score += 40;
      } else if (s.description && s.description.length > 25) {
        score += 15;
      }

      // C. Valoración de la crítica (Rating)
      const rating = typeof s.rating === 'number' ? s.rating : 7.0;
      score += rating * 12; // 8.5 -> +102 pts

      // D. Afinidad de géneros
      if (topGenres.length > 0) {
        const genresStr = Array.isArray(s.genres) ? s.genres.join(' ').toLowerCase() : String(s.genres || '').toLowerCase();
        topGenres.forEach((g, idx) => {
          if (genresStr.includes(g)) {
            score += Math.max(15, 60 - idx * 15);
          }
        });
      }

      // E. Si ya fue visto completamente, aplicar leve penalización para favorecer el descubrimiento
      if (watchedIds.has(s.id)) {
        score -= 30;
      }

      if (score > bestScore) {
        bestScore = score;
        bestShow = s;
      }
    }

    return bestShow || heroPool[0] || null;
  }, [shows, heroRecommendation, continueWatchingItems, isShowHidden]);

  // Inicio es una sola superficie editorial, aunque visualmente esté formada
  // por varias filas. Reservar cada identidad aquí evita que el mismo título
  // aparezca en recomendaciones, recién agregados, destacados y géneros. Las
  // imágenes no participan en esta reserva y siguen siendo cargadas por cada
  // tarjeta de forma diferida.
  const homeSections = useMemo(() => {
    const continueIds = new Set(continueWatchingItems.map((item) => item.showId).filter(Boolean));
    const visibleHomeShows = shows.filter((show) => !isShowHidden(show));

    // Exclusión base para no duplicar Seguir Viendo ni el Hero principal
    const baseExcluded = new Set<string>();
    for (const show of visibleHomeShows) {
      if (continueIds.has(show.id)) baseExcluded.add(homeIdentityKey(show));
    }
    if (featuredShow) baseExcluded.add(homeIdentityKey(featuredShow));

    // Cada riel de recomendación mantiene su conjunto interno sin canibalizar el catálogo general
    const allocateRail = (rail: (typeof recommendationRails)[number]) => {
      const railUsed = new Set<string>(baseExcluded);
      const selected = takeUniqueHomeShows(rail.shows, railUsed, HOME_RAIL_MAX_ITEMS);
      return { ...rail, shows: selected };
    };

    const primaryRails = recommendationRails.slice(0, 2).map(allocateRail).filter((rail) => rail.shows.length > 0);
    const secondaryRails = recommendationRails.slice(2).map(allocateRail).filter((rail) => rail.shows.length > 0);

    // Secciones generales del catálogo: mantienen orden y posición ESTABLES desde el primer render
    const recentShows = takeUniqueHomeShows(visibleHomeShows.slice(0, 50), new Set(baseExcluded), 18);
    const topRatedShows = takeUniqueHomeShows(
      [...visibleHomeShows].sort((a, b) => (b.rating || 0) - (a.rating || 0) || Number(b.year || 0) - Number(a.year || 0)),
      new Set(baseExcluded),
      8,
    );
    const uniqueGenreRows = genreRows
      .map((row) => ({ ...row, items: takeUniqueHomeShows(row.items, new Set(baseExcluded), HOME_GENRE_MAX_ITEMS) }))
      .filter((row) => row.items.length >= HOME_RAIL_MIN_ITEMS);

    return {
      primaryRails,
      recentShows,
      topRatedShows,
      secondaryRails,
      genreRows: uniqueGenreRows,
    };
  }, [continueWatchingItems, featuredShow, genreRows, recommendationRails, shows, isShowHidden]);

  const activePublicKind = PUBLIC_CATALOG_KINDS.includes(activeFilter as PublicCatalogKind)
    ? activeFilter as PublicCatalogKind
    : null;
  const activePublicGenreKey = publicGenreKey(activeFilter);
  const activePublicGenreId = PUBLIC_GENRE_IDS[activePublicGenreKey];
  const activeRemoteLoading = activePublicKind
    ? isLoadingMoreCatalogByKind[activePublicKind]
    : Boolean(activePublicGenreId && isLoadingMorePublicGenre[activePublicGenreKey]);
  const activeRemoteHasMore = activePublicKind
    ? hasMorePublicCatalogByKind[activePublicKind]
    : Boolean(activePublicGenreId && hasMorePublicGenre[activePublicGenreKey] !== false);
  const exploreGenreKey = publicGenreKey(exploreGenreFilter || '');
  const exploreGenreId = PUBLIC_GENRE_IDS[exploreGenreKey];
  const exploreHasMore = Boolean(exploreGenreId
    ? hasMorePublicGenre[exploreGenreKey] !== false
    : hasMorePublicCatalog);
  const exploreIsLoadingMore = Boolean(exploreGenreId
    ? isLoadingMorePublicGenre[exploreGenreKey]
    : isLoadingMoreCatalog);
  const loadMoreExploreCatalog = (hasHiddenItems = false) => {
    setCatalogPageSize((previous) => previous + homeGridBatchSize);
    if (hasHiddenItems) return Promise.resolve();
    return exploreGenreId
      ? loadMorePublicGenre(exploreGenreKey)
      : loadMorePublicCatalog();
  };

  const handlePlayAdminShow = async (show: Show) => {
    try {
      let detail: any = null;
      const localResponse = await fetch(`/api/v1/shows/${encodeURIComponent(show.id)}`);
      if (localResponse.ok) detail = await localResponse.json();

      if (!detail && show.tmdb_id) {
        const rawKind = String(show.kind || show.category || 'series').toLowerCase();
        const kind = rawKind.includes('movie') || rawKind.includes('pel') ? 'movie' : rawKind.includes('anime') ? 'anime' : 'series';
        const publicResponse = await fetch(`/api/v1/catalog/public/${kind}/${show.tmdb_id}`);
        if (publicResponse.ok) detail = await publicResponse.json();
      }

      const firstEpisode = Array.isArray(detail?.episodes) ? detail.episodes[0] : null;
      const episode: Episode | null = firstEpisode || (show.tmdb_id ? {
        id: `tmdb-${String(show.kind || show.category || 'series').toLowerCase()}-${show.tmdb_id}-s1-e1`,
        show_id: show.id,
        title: show.title,
        episode_number: 1,
        season_number: 1,
        source_url: `tmdb://${String(show.kind || show.category || 'series').toLowerCase()}/${show.tmdb_id}/1/1`,
      } : null);
      if (!episode) throw new Error('Esta obra todavía no tiene un episodio o fuente reproducible.');
      await handleSelectEpisode({ ...episode, show_id: show.id }, detail?.title || show.title, show);
    } catch (error: any) {
      setPlayingStreamData({
        title: show.title,
        streamUrl: '',
        all_streams: [],
        loadError: error?.message || 'No se pudo abrir esta obra.',
        isLoading: false,
      });
    }
  };
  // Las pestañas de Anime/Películas/Series ya tienen un buffer local que se
  // muestra por bloques. Al llegar al final, primero revelamos el siguiente
  // bloque; solo cuando ese buffer queda cerca de agotarse pedimos otra página
  // remota. Así el usuario no tiene que pulsar "Cargar más" para continuar.
  const activeCategoryHasHiddenLocal = Boolean(
    activeFilter !== 'all' &&
    activeFilter !== 'explore' &&
    activeFilter !== 'recommendations' &&
    !searchQuery.trim() &&
    filteredShows.length > gridPageSize,
  );

  // La siguiente página se pide antes de que el usuario llegue al final. Un
  // sentinel con IntersectionObserver evita escuchar cada evento de scroll y
  // mantiene el trabajo fuera del hilo de interacción; las tarjetas nuevas
  // siguen usando lazy loading para no descargar imágenes fuera de pantalla.
  useEffect(() => {
    const sentinel = autoLoadSentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    // During the initial render the sentinel is at the top of the empty
    // document, so its generous root margin would otherwise request page 2
    // before page 1 has even arrived.
    if (isLoading || shows.length === 0) return;
    if (searchQuery.trim().length >= 2 || activeFilter === 'recommendations') return;
    // Explore owns a local sentinel because it has its own genre/year slice;
    // the global sentinel cannot know how many filtered cards are hidden.
    if (activeFilter === 'explore') return;

    const mode = activeFilter === 'all'
      ? 'catalog:all'
      : activePublicKind
        ? `catalog:${activePublicKind}`
        : activePublicGenreId
          ? `genre:${activePublicGenreKey}`
          : activeFilter === 'explore'
            ? `explore:${exploreGenreId || 'all'}`
            : null;
    if (!mode) return;

    const hasMore = activeFilter === 'all'
      ? hasMorePublicCatalog
      : activeFilter === 'explore'
        ? exploreHasMore
        : activeCategoryHasHiddenLocal || activeRemoteHasMore;
    const loading = activeFilter === 'all'
      ? isLoadingMoreCatalog
      : activeFilter === 'explore'
        ? exploreIsLoadingMore
        : activeRemoteLoading;
    if (!hasMore || loading) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting || autoLoadInFlightRef.current === mode) return;
      autoLoadInFlightRef.current = mode;

      // No hacemos una petición si todavía hay obras ya descargadas que el
      // usuario aún no ha recorrido: basta con ampliar la ventana renderizada.
      const request = activeCategoryHasHiddenLocal
        ? Promise.resolve(setGridPageSize((previous) => previous + browseGridBatchSize))
        : activeFilter === 'all'
          ? loadMorePublicCatalog()
          : activeFilter === 'explore'
            ? loadMoreExploreCatalog()
            : activePublicKind
              ? loadMorePublicCatalogKind(activePublicKind)
              : loadMorePublicGenre(activePublicGenreKey);

      void Promise.resolve(request).then(() => undefined, () => undefined).finally(() => {
        if (autoLoadInFlightRef.current === mode) autoLoadInFlightRef.current = null;
      });
    }, { rootMargin: '0px 0px 500px 0px' });

    observer.observe(sentinel);
    return () => observer.disconnect();
    // The loader functions are intentionally read from the active render;
    // state changes above recreate the observer with the next cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategoryHasHiddenLocal, activeFilter, activePublicGenreId, activePublicGenreKey, activePublicKind, activeRemoteHasMore, activeRemoteLoading, exploreGenreId, exploreHasMore, exploreIsLoadingMore, filteredShows.length, gridPageSize, hasMorePublicCatalog, isLoading, isLoadingMoreCatalog, searchQuery, shows.length]);

  return (
    <div className="app-shell relative min-h-screen text-zinc-100 flex flex-col">
      {/* 1. DYNAMIC AMBIENT GLOW (RESPONDE AL COLOR DOMINANTE DEL CONTENIDO EN FOCO) */}
      <a className="skip-link" href="#main-content">Ir al contenido</a>

      {/* VISTA DE CATÁLOGO (se oculta cuando el reproductor está activo para que funcione como pantalla propia) */}
      <div className={playingStreamData ? 'hidden' : 'contents'}>
        {/* HEADER UNIFICADO: LOGO, BUSCADOR Y CATEGORÍAS EN LA MISMA BARRA SUPERIOR */}
        <UnifiedHeader
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          activeFilter={activeFilter}
          onSelectCategory={handleSelectCategory}
          onOpenWatchParty={() => setIsGlobalWatchPartyOpen(true)}
        />

        <main id="main-content" tabIndex={-1} className="relative z-10 flex-1 pb-24">
        {/* AVISO DE CONTENIDO HUÉRFANO ELIMINADO DE "SEGUIR VIENDO" (#2/R2) */}
        {orphanNotice && (
          <div className="max-w-7xl mx-auto px-4 sm:px-8 pt-4">
            <div className="mx-auto max-w-2xl rounded-xl border border-zinc-700/70 bg-zinc-900/90 px-4 py-3 text-xs text-zinc-300 shadow-lg backdrop-blur-md flex items-start justify-between gap-3 animate-in fade-in slide-in-from-top-2 duration-200">
              <span>{orphanNotice}</span>
              <button
                type="button"
                onClick={() => setOrphanNotice(null)}
                aria-label="Descartar aviso"
                className="shrink-0 text-zinc-500 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
          </div>
        )}
        {(shows.length > 0 || serverSearchResults.length > 0) ? (
          <>
            {/* HERO BANNER PRINCIPAL (70% VH, KEN BURNS, PILL BUTTONS) */}
            {featuredShow && !searchQuery && activeFilter === 'all' && (
              <HeroBanner
                media={featuredShow}
                onPlay={() => handleOpenDetails(featuredShow)}
                onMoreInfo={() => handleOpenDetails(featuredShow)}
              />
            )}

            <div className={`catalog-content space-y-12 ${activeFilter === 'all' && !searchQuery.trim() ? 'catalog-content-home' : 'catalog-content-browse'}`}>

              {/* CASO 0: SI HAY BÚSQUEDA ACTIVA, MOSTRAR RESULTADOS (TIENE PRIORIDAD SOBRE CUALQUIER PESTAÑA O VISTA) */}
              {searchQuery && searchQuery.trim().length >= 2 ? (
                <section className="search-results-panel">
                  <div className="search-results-heading">
                    <div>
                      <h3>
                        Resultados para <span className="search-query-mark">“{searchQuery}”</span>
                      </h3>
                      <p>Coincidencias ordenadas por popularidad y afinidad.</p>
                    </div>
                    <span className="search-results-count">
                      <strong>{filteredShows.length}</strong> {filteredShows.length === 1 ? 'obra' : 'obras'}
                    </span>
                  </div>

                  <CatalogFilters
                    className="search-filter-bar"
                    years={availableYears}
                    year={yearFilter}
                    onYear={(y) => { setYearFilter(y); setGridPageSize(browseGridBatchSize); }}
                    sort={sortBy}
                    onSort={(s) => { setSortBy(s); setGridPageSize(browseGridBatchSize); }}
                  />

                  {filteredShows.length === 0 ? (
                    <div className="search-empty-state">
                      <div className="search-empty-icon" aria-hidden="true"><Film size={28} /></div>
                      <span className="search-empty-kicker">Sin coincidencias</span>
                      <p>No encontramos títulos para <strong>“{searchQuery}”</strong>.</p>
                      <small>Prueba con otro nombre, género o una búsqueda más corta.</small>
                      <button
                        type="button"
                        onClick={() => {
                          handleSearchChange('');
                          handleSelectCategory('all');
                          setGridPageSize(browseGridBatchSize);
                        }}
                        className="search-empty-reset"
                      >
                        Limpiar búsqueda
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="search-results-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
                        {filteredShows.slice(0, gridPageSize).map((item, index) => (
                          <MediaCard
                            key={item.id}
                            media={item}
                            onSelectMedia={handleOpenDetails}
                            imageLoading={index < 12 ? 'eager' : 'lazy'}
                          />
                        ))}
                      </div>
                      {filteredShows.length > gridPageSize && (
                        <div className="flex justify-center pt-6">
                          <button
                            type="button"
                            onClick={() => setGridPageSize(prev => prev + browseGridBatchSize)}
                            className="px-6 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm font-medium text-zinc-200 border border-zinc-700 transition-colors"
                          >
                            Cargar más ({filteredShows.length - gridPageSize} restantes)
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
              ) : activeFilter === 'my-lists' ? (
                <Suspense fallback={deferredSurfaceFallback}>
                  <LazyMyListsView
                    onSelectMedia={handleOpenDetails}
                    onExploreCatalog={() => {
                      handleSelectCategory('explore');
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                  />
                </Suspense>
              ) : activeFilter === 'recommendations' ? (
                <section className="space-y-10">
                  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800/80 pb-4">
                    <div>
                      <p className="section-kicker">Selección MeriStream</p>
                      <h3 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
                        {isAuthenticated && user ? `Recomendaciones para ${user.username}` : 'Recomendaciones y Tendencias'}
                      </h3>
                      <p className="text-xs sm:text-sm text-zinc-400 mt-1">
                        {isAuthenticated
                          ? 'Historias elegidas a partir de lo que ves.'
                          : 'Inicia sesión para descubrir recomendaciones según tus gustos.'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => fetchRecommendations(true)}
                      className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-300 border border-zinc-800 transition shadow-sm hover:border-zinc-700"
                    >
                      <RefreshCw size={13} className={isLoadingRecs ? 'animate-spin text-amber-400' : ''} />
                      <span>Actualizar Recomendaciones</span>
                    </button>
                  </div>

                  {/* RIELES DE RECOMENDACIÓN GENERADOS POR EL ALGORITMO */}
                  {recommendationRails.map((rail) => (
                    <MediaRow
                      key={rail.id}
                      title={rail.title}
                      subtitle={rail.subtitle}
                      items={rail.shows}
                      onSelectMedia={handleOpenDetails}
                      isLoading={isLoadingRecs}
                    />
                  ))}

                  {recommendationRails.length === 0 && !isLoadingRecs && (
                    <div className="py-16 text-center space-y-3">
                      <Film size={36} className="mx-auto text-zinc-600" />
                      <p className="text-sm text-zinc-400 font-medium">
                        Mira tu primer título para descubrir recomendaciones para ti.
                      </p>
                    </div>
                  )}
                </section>
              ) : activeFilter === 'explore' ? (
                /* CASO B2: VISTA EXPLORAR CATÁLOGO COMPLETO — FILTROS DE GÉNERO + AÑO */
                <Suspense fallback={deferredSurfaceFallback}>
                  <LazyExploreCatalogView
                  shows={shows}
                  allGenresList={allGenresList}
                  showsCountByGenre={showsCountByGenre}
                  genreFilter={exploreGenreFilter}
                  onGenreFilter={handleExploreGenreFilter}
                  yearFilter={yearFilter}
                  onYearFilter={(y) => { setYearFilter(y); setCatalogPageSize(browseGridBatchSize); }}
                  sortBy={sortBy}
                  onSortBy={(s) => { setSortBy(s); setCatalogPageSize(browseGridBatchSize); }}
                  catalogPageSize={catalogPageSize}
                  onLoadMore={loadMoreExploreCatalog}
                  hasMore={exploreHasMore}
                  isLoadingMore={exploreIsLoadingMore}
                  availableYears={availableYears}
                  onSelectMedia={handleOpenDetails}
                  />
                </Suspense>
              ) : activeFilter !== 'all' ? (
                <section className="space-y-4">
                  <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
                    <h3 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight">
                      {({ movie: 'Películas', series: 'Series', anime: 'Anime' } as Record<string, string>)[activeFilter] || activeFilter}
                    </h3>
                    <span className="font-mono text-xs text-zinc-500">
                      {filteredShows.length} {filteredShows.length === 1 ? 'obra' : 'obras'}
                    </span>
                  </div>

                  <CatalogFilters
                    years={availableYears}
                    year={yearFilter}
                    onYear={(y) => { setYearFilter(y); setGridPageSize(browseGridBatchSize); }}
                    sort={sortBy}
                    onSort={(s) => { setSortBy(s); setGridPageSize(browseGridBatchSize); }}
                  />

                  {filteredShows.length === 0 && activeRemoteLoading ? (
                    <div className="py-20 text-center space-y-3" role="status" aria-live="polite">
                      <Film size={36} className="mx-auto text-amber-400/70 animate-pulse" />
                      <p className="text-sm text-zinc-300 font-medium">Cargando títulos populares desde TMDB…</p>
                      <p className="text-xs text-zinc-500">Este filtro está preparando su primer lote.</p>
                    </div>
                  ) : filteredShows.length === 0 ? (
                    <div className="py-20 text-center space-y-3">
                      <Film size={36} className="mx-auto text-zinc-600" />
                      <p className="text-sm text-zinc-400 font-medium">
                        No se encontraron títulos para este criterio.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          handleSearchChange('');
                          handleSelectCategory('all');
                          setGridPageSize(browseGridBatchSize);
                        }}
                        className="text-xs text-amber-400 hover:underline font-semibold"
                      >
                        Restablecer filtros
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
                        {filteredShows.slice(0, gridPageSize).map((item) => (
                          <MediaCard
                            key={item.id}
                            media={item}
                            onSelectMedia={handleOpenDetails}
                          />
                        ))}
                      </div>
                      {activeRemoteLoading && (
                        <p className="catalog-autoload-status" role="status" aria-live="polite">
                          Cargando más títulos…
                        </p>
                      )}
                    </>
                  )}
                </section>
              ) : (
                /* CASO C: VISTA PRINCIPAL CON ESTRUCTURA DIVERSIFICADA (SEGUIR VIENDO + RECOMENDACIONES + BENTO BOX + FILAS) */
                <>
                  {/* SECCIÓN SEGUIR VIENDO (TARJETAS 16:9 HORIZONTALES CON BARRA DE 4PX) */}
                  {continueWatchingItems.length > 0 && (
                    <ContinueWatching
                      items={continueWatchingItems}
                      shows={shows}
                      onPlayEpisode={(_showId, ep, title) => handleSelectEpisode(ep, title)}
                      onSelectShow={(showId) => {
                        const target = shows.find((s) => s.id === showId);
                        if (target) handleOpenDetails(target);
                      }}
                      onRemoveItem={(epId, showId) => removeContinueWatchingItem(epId, showId)}
                    />
                  )}

                  {/* RIELES DE RECOMENDACIÓN PERSONALIZADA INTELIGENTE */}
                  {isLoadingRecs && homeSections.primaryRails.length === 0 && shows.length === 0 && (
                    <MediaRow
                      title="Recomendaciones"
                      subtitle="Preparando tu selección"
                      items={[]}
                      onSelectMedia={handleOpenDetails}
                      isLoading
                    />
                  )}
                  {homeSections.primaryRails.map((rail) => (
                    <MediaRow
                      key={rail.id}
                      title={rail.title}
                      subtitle={rail.subtitle}
                      items={rail.shows}
                      onSelectMedia={handleOpenDetails}
                      isLoading={isLoadingRecs && rail.shows.length === 0}
                    />
                  ))}

                  {/* RECÉN AGREGADOS (por fecha de ingesta, lo más nuevo primero) */}
                  {homeSections.recentShows.length > 0 && (
                    <MediaRow
                      title="Recién agregados"
                      items={homeSections.recentShows}
                      onSelectMedia={handleOpenDetails}
                      isLoading={isLoading}
                    />
                  )}

                  {/* CUADRÍCULA ASIMÉTRICA BENTO BOX */}
                  {homeSections.topRatedShows.length >= 3 && (
                    <BentoCollection
                      title="Destacados por la crítica"
                      items={homeSections.topRatedShows}
                      onSelectMedia={handleOpenDetails}
                    />
                  )}

                  {/* RIELES DE RECOMENDACIÓN RESTANTES (ej. Descubrimientos o Género Favorito) */}
                  {homeSections.secondaryRails.map((rail) => (
                    <MediaRow
                      key={rail.id}
                      title={rail.title}
                      subtitle={rail.subtitle}
                      items={rail.shows}
                      onSelectMedia={handleOpenDetails}
                      isLoading={isLoadingRecs}
                    />
                  ))}

                  {/* FILAS POR GÉNERO (ordenadas por rating dentro de cada una) */}
                  {homeSections.genreRows.map((row) => (
                    <MediaRow
                      key={row.genre}
                      title={row.genre}
                      items={row.items}
                      onSelectMedia={handleOpenDetails}
                      isLoading={isLoading}
                    />
                  ))}

                </>
              )}
            </div>
          </>
        ) : (
          /* Reserva el hero durante la carga para que el catálogo no empuje
             el footer desde el viewport al primer render (CLS). */
          isLoading ? (
            <section className="feature feature-loading" aria-hidden="true">
              <div className="feature-loading-skeleton" />
            </section>
          ) : catalogError ? (
            <div className="max-w-2xl mx-auto px-4 py-20 text-center space-y-5 animate-in fade-in duration-300">
              <div className="relative mx-auto w-20 h-20 flex items-center justify-center rounded-2xl bg-zinc-900 text-rose-300 border border-zinc-800 shadow-xl">
                <AlertCircle size={36} className="stroke-[1.6]" />
              </div>
              <div className="space-y-2">
                <h2 className="font-display text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                  {nativeShell ? 'No pudimos conectar con MeriStream' : 'No se pudo cargar el catálogo'}
                </h2>
                <p className="text-sm text-zinc-400 max-w-lg mx-auto leading-relaxed">
                  {nativeShell
                    ? 'Comprueba tu conexión e inténtalo otra vez. Tu biblioteca y tus preferencias siguen guardadas.'
                    : catalogError}
                </p>
              </div>
              <button type="button" onClick={loadCatalog} className="inline-flex items-center gap-2 rounded-xl bg-amber-400 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-amber-300 transition-colors">
                <RefreshCw size={15} /> Reintentar
              </button>
            </div>
          ) : (
          /* BIENVENIDA SI NO HAY TÍTULOS */
          (
            <div className="max-w-2xl mx-auto px-4 py-20 text-center space-y-8 animate-in fade-in duration-300">
              <div className="relative mx-auto w-20 h-20 flex items-center justify-center rounded-2xl bg-zinc-900 text-amber-400 border border-zinc-800 shadow-xl">
                <Film size={36} className="stroke-[1.6]" />
              </div>

              <div className="space-y-2.5">
                <h2 className="font-display text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                  Videoteca Personal
                </h2>
                <p className="text-sm text-zinc-400 max-w-lg mx-auto leading-relaxed">
                  Tu base de datos está lista. Puedes importar cualquier serie o anime individual o iniciar un rastreo completo desde el panel de control.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 max-w-lg mx-auto text-left">
                <button
                  type="button"
                  onClick={() => {
                    window.location.href = '/admin';
                  }}
                  className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-all group shadow-sm"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="flex items-center gap-1.5 text-xs font-bold text-white group-hover:text-amber-400 transition-colors">
                      <Film size={15} className="text-amber-400" />
                      Importador Rápido
                    </span>
                    <ArrowUpRight size={14} className="text-zinc-500 group-hover:text-amber-400 transition-transform" />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Ingresa el enlace de cualquier título para extraer episodios y servidores.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    window.location.href = '/admin';
                  }}
                  className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-all group shadow-sm"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="flex items-center gap-1.5 text-xs font-bold text-white group-hover:text-amber-400 transition-colors">
                      <Tv size={15} className="text-amber-400" />
                      Rastreador de Catálogo
                    </span>
                    <ArrowUpRight size={14} className="text-zinc-500 group-hover:text-amber-400 transition-transform" />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Descarga catálogos enteros en segundo plano con control de cola.
                  </p>
                </button>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={loadCatalog}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs font-medium border border-zinc-800 transition-colors"
                >
                  <RefreshCw size={13} />
                  Comprobar títulos
                </button>
              </div>
            </div>
          )
          )
        )}
        <div ref={autoLoadSentinelRef} className="catalog-autoload-sentinel" aria-hidden="true" />
      </main>
        <footer className="site-footer"><span className="footer-brand">meristream.</span><span>Cine, series y anime. A tu ritmo.</span></footer>
      </div>

      {/* 3. VISTA DE DETALLES (DRAWER / PANEL LATERAL FLOTANTE QUE SE DESLIZA DESDE LA DERECHA) */}
      <MediaDetailsModal
        showId={selectedShowId}
        isOpen={Boolean(selectedShowId) && !playingStreamData}
        onClose={handleCloseDetails}
        onSelectEpisode={(ep, title) => handleSelectEpisode(ep, title)}
        onSelectShow={handleOpenDetails}
        watchProgress={continueWatchingItems}
        userId={user?.id}
      />

      {/* MODAL GLOBAL DE WATCH PARTY (ACCESIBLE DIRECTAMENTE DESDE EL HEADER) */}
      <Suspense fallback={null}>
        <LazyWatchPartyJoinModal
        isOpen={isGlobalWatchPartyOpen}
        onClose={() => setIsGlobalWatchPartyOpen(false)}
        isAuthenticated={isAuthenticated}
        onRequireAuth={openAuthModal}
        onJoin={handleJoinWatchPartyFromHeader}
      />
      </Suspense>

      {/* REPRODUCTOR HLS Y PROXY DE VIDEO JUST-IN-TIME */}
      {playingStreamData && (
        <HLSPlayerModal
          isOpen={Boolean(playingStreamData)}
          onClose={handleClosePlayer}
          userId={user?.id}
          showId={playingStreamData.showId}
          tmdbId={playingStreamData.tmdbId}
          kind={playingStreamData.kind}
          episodeId={playingStreamData.episodeId}
          episodeNumber={playingStreamData.episodeNumber}
          title={playingStreamData.title}
          streamUrl={playingStreamData.streamUrl}
          all_streams={playingStreamData.all_streams}
          ranked_streams={playingStreamData.ranked_streams}
          subtitleTracks={playingStreamData.subtitleTracks}
          initialTime={playingStreamData.initialTime}
          initialPartyRoomCode={playingStreamData.initialPartyRoomCode}
          partyRoomCode={playingStreamData.partyRoomCode}
          isLoading={playingStreamData.isLoading}
          loadError={playingStreamData.loadError}
          onNextEpisode={Boolean(String(playingStreamData.kind || '').toLowerCase().includes('movie') || String(playingStreamData.kind || '').toLowerCase().includes('pel')) ? undefined : async () => {
            const showId = playingStreamData.showId;
            const currentEpisodeId = playingStreamData.episodeId;
            const currentEpNum = Number(playingStreamData.episodeNumber) || 1;
            const nextEpNum = currentEpNum + 1;

            let currentShow = shows.find((show) => show.id === showId)
              || serverSearchResults.find((show) => show.id === showId);

            let episodes: Episode[] = [...(currentShow?.episodes || [])]
              .filter((ep) => Number.isFinite(Number(ep.episode_number)))
              .sort((a, b) => Number(a.episode_number) - Number(b.episode_number));

            let nextEpisode: Episode | undefined;
            if (episodes.length > 0) {
              const currentIdx = episodes.findIndex((ep) => ep.id === currentEpisodeId || ep.episode_number === currentEpNum);
              if (currentIdx >= 0 && currentIdx + 1 < episodes.length) {
                nextEpisode = episodes[currentIdx + 1];
              }
            }

            // Si los episodios no están en memoria local, resolverlos desde el backend
            if (!nextEpisode) {
              try {
                let detail: any = null;
                const localRes = await fetch(`/api/v1/shows/${encodeURIComponent(showId)}`);
                if (localRes.ok) detail = await localRes.json();
                if (!detail && playingStreamData.tmdbId) {
                  const rawKind = String(playingStreamData.kind || 'series').toLowerCase();
                  const kind = rawKind.includes('anime') ? 'anime' : 'series';
                  const publicRes = await fetch(`/api/v1/catalog/public/${kind}/${playingStreamData.tmdbId}`);
                  if (publicRes.ok) detail = await publicRes.json();
                }
                if (Array.isArray(detail?.episodes) && detail.episodes.length > 0) {
                  episodes = [...detail.episodes]
                    .filter((ep: any) => Number.isFinite(Number(ep.episode_number)))
                    .sort((a: any, b: any) => Number(a.episode_number) - Number(b.episode_number));
                  const currentIdx = episodes.findIndex((ep) => ep.id === currentEpisodeId || ep.episode_number === currentEpNum);
                  if (currentIdx >= 0 && currentIdx + 1 < episodes.length) {
                    nextEpisode = episodes[currentIdx + 1];
                  } else {
                    nextEpisode = episodes.find((ep) => ep.episode_number === nextEpNum);
                  }
                }
              } catch (e) {
                console.warn('Error resolviendo siguiente episodio desde API:', e);
              }
            }

            // Fallback canónico por número de episodio
            if (!nextEpisode) {
              nextEpisode = {
                id: `${showId}-s1-e${nextEpNum}`,
                show_id: showId,
                title: `Episodio ${nextEpNum}`,
                episode_number: nextEpNum,
                created_at: new Date().toISOString(),
              };
            }

            if (nextEpisode) {
              void handleSelectEpisode(nextEpisode, playingStreamData.showTitle || currentShow?.title || 'Serie', currentShow);
            } else {
              handleClosePlayer();
            }
          }}
          onProgressUpdate={(currentTime, duration) => {
            if (duration > 0 && currentTime > 0) {
              const progressPercent = Math.round((currentTime / duration) * 100);

              const newProgress: WatchProgress = {
                showId: playingStreamData.showId,
                showTitle: playingStreamData.showTitle,
                showPoster: playingStreamData.showPoster,
                episodeId: playingStreamData.episodeId,
                episodeNumber: playingStreamData.episodeNumber,
                episodeTitle: playingStreamData.episodeTitle,
                progressPercent,
                currentTime,
                duration,
                lastWatchedAt: Date.now(),
              };

              setContinueWatchingItems((prev) => {
                const filtered = prev.filter((p) => p.episodeId !== playingStreamData.episodeId);
                const updated = [newProgress, ...filtered].slice(0, 50);
                try {
                  localStorage.setItem(getContinueWatchingStorageKey(user?.id), JSON.stringify(updated));
                } catch {}
                return updated;
              });

              // Guardar en base de datos para sincronización y algoritmo de recomendación
              if (isAuthenticated) {
                api.saveProgress({
                  showId: playingStreamData.showId,
                  showTitle: playingStreamData.showTitle,
                  showPoster: playingStreamData.showPoster,
                  episodeId: playingStreamData.episodeId,
                  episodeNumber: playingStreamData.episodeNumber,
                  episodeTitle: playingStreamData.episodeTitle,
                  progressPercent,
                  currentTime,
                  duration,
                }).catch((err) => {
                  console.warn('Error guardando progreso en servidor:', err);
                });
              }
            }
          }}
        />
      )}

      {/* MODAL DE AUTENTICACIÓN / REGISTRO / LOGIN */}
      <AuthModal />

      {/* PANEL DE ADMINISTRACIÓN, INGESTA Y WORKERS */}
      <AdminPanel
        isOpen={isAdminOpen}
        onClose={() => {
          setIsAdminOpen(false);
          loadCatalog();
        }}
        onPlayDirect={(streamResult: any) => {
          const candidates: string[] = (
            streamResult.all_streams ||
            streamResult.all_available_streams ||
            (streamResult.stream_url ? [streamResult.stream_url] : [])
          ).filter(Boolean);
          // Playable = medio directo (.m3u8/.mpd/.mp4/...) o locator conocido;
          // lo demás son páginas web crudas que requieren resolución JIT.
          const isPlayable = (u: string) =>
            /\.(m3u8|mpd|mp4|webm|mkv)(\?|#|$)/i.test(u) || isEmbedUrl(u);
          const playableCandidates = candidates.filter(isPlayable);

          if (playableCandidates.length === 0 && streamResult.stream_url) {
            // Página de episodio sin servidores resueltos (ej. AnimeFLV /ver/...):
            // resolver Just-In-Time contra el backend antes de abrir el player.
            setPlayingStreamData({
              title: streamResult.title,
              streamUrl: '',
              all_streams: [],
              isLoading: true,
            });
            api
              .getEpisodeServers(streamResult.stream_url)
              .then((data) => {
                const streams = data.all_available_streams.filter(isPlayable);
                if (streams.length === 0) throw new Error('El episodio no tiene servidores disponibles.');
                setPlayingStreamData((prev: any) =>
                  prev
                    ? { ...prev, streamUrl: streams[0], all_streams: streams, isLoading: false }
                    : prev
                );
              })
              .catch((e: any) => {
                setPlayingStreamData((prev: any) =>
                  prev
                    ? {
                        ...prev,
                        loadError: e.message || 'No se pudo resolver el video del episodio.',
                        isLoading: false,
                      }
                    : prev
                );
              });
            return;
          }

          setPlayingStreamData({
            title: streamResult.title,
            streamUrl:
              playableCandidates[0] || streamResult.stream_url,
            all_streams:
              playableCandidates.length > 0 ? playableCandidates : candidates,
          });
        }}
        onPlayShow={handlePlayAdminShow}
        onOpenPublicShow={(show: any) => {
          const rawKind = String(show.category || 'movie').toLowerCase();
          const kind = rawKind.includes('movie') || rawKind.includes('pel')
            ? 'movie'
            : rawKind.includes('anime')
              ? 'anime'
              : 'series';
          const publicId = show.tmdb_id ? `tmdb-${kind}-${show.tmdb_id}` : show.id;
          handleOpenDetails({ ...show, id: publicId });
          setIsAdminOpen(false);
        }}
      />
    </div>
  );
}

export default App;
