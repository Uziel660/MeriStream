import { prisma, normalizeTitle } from '../server/db';
import { getPublicCatalogDetail } from '../server/publicCatalog';

const TMDB_API_KEY = process.env.TMDB_API_KEY || "15d2ea6d0dc1d476efbca3eba2b9bbfb";

interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  genre_ids?: number[];
  media_type?: string;
}

function extractPosterPath(posterUrl?: string | null): string | null {
  if (!posterUrl) return null;
  const match = posterUrl.match(/\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)/i);
  return match ? match[0] : null;
}

function cleanTitleForSearch(title: string): string {
  return title
    .replace(/^Ver\s+/i, '')
    .replace(/\s+Online\s*(Gratis)?\s*(HD|Latino|Castellano|Sub Español)?.*$/i, '')
    .replace(/\s+sub\s+español\s+online.*$/i, '')
    .replace(/\s*📽.*$/, '')
    .replace(/\s*🎦.*$/, '')
    .replace(/\s*\[.*?\]|\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchTmdb(query: string, kind: 'movie' | 'tv' | 'multi', year?: number | null): Promise<TmdbSearchResult[]> {
  const cleanQ = cleanTitleForSearch(query);
  if (!cleanQ) return [];

  const endpoint = kind === 'movie' ? 'movie' : kind === 'tv' ? 'tv' : 'multi';
  let url = `https://api.themoviedb.org/3/search/${endpoint}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanQ)}&language=es-MX&include_adult=false`;
  if (year && year > 1900) {
    if (kind === 'movie') url += `&primary_release_year=${year}`;
    else if (kind === 'tv') url += `&first_air_date_year=${year}`;
    else url += `&year=${year}`;
  }

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch {
    return [];
  }
}

async function fetchExternalIds(tmdbId: number, kind: 'movie' | 'tv'): Promise<{ imdb_id?: string | null; tvdb_id?: number | null }> {
  try {
    const url = `https://api.themoviedb.org/3/${kind}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return {};
    const data = await res.json();
    return {
      imdb_id: typeof data.imdb_id === 'string' && /^tt\d+$/i.test(data.imdb_id) ? data.imdb_id : null,
      tvdb_id: typeof data.tvdb_id === 'number' && data.tvdb_id > 0 ? data.tvdb_id : null,
    };
  } catch {
    return {};
  }
}

async function run() {
  console.log('--- Starting TMDB Missing Identity Backfill ---');

  const showsMissingTmdb = await prisma.show.findMany({
    where: { tmdb_id: null },
    select: {
      id: true,
      title: true,
      category: true,
      year: true,
      poster_url: true,
      description: true,
      imdb_id: true,
    },
    orderBy: { created_at: 'desc' },
  });

  console.log(`Total shows missing tmdb_id: ${showsMissingTmdb.length}`);

  let matchedCount = 0;
  let skippedAmbiguous = 0;
  let noResultsCount = 0;

  for (let i = 0; i < showsMissingTmdb.length; i++) {
    const show = showsMissingTmdb[i];
    const showPosterPath = extractPosterPath(show.poster_url);
    const kind = show.category === 'movie' ? 'movie' : 'tv';

    let candidates = await searchTmdb(show.title, kind, show.year && show.year > 1900 ? show.year : null);
    if (candidates.length === 0 && show.year && show.year > 1900) {
      // Re-search without year constraint in case scraper year was slightly off
      candidates = await searchTmdb(show.title, kind, null);
    }
    if (candidates.length === 0) {
      // Re-search multi
      candidates = await searchTmdb(show.title, 'multi', null);
    }

    if (candidates.length === 0) {
      noResultsCount++;
      continue;
    }

    let exactMatch: TmdbSearchResult | null = null;

    // 1. Poster path match (100% ground truth match)
    if (showPosterPath) {
      const posterMatch = candidates.find(c => c.poster_path && c.poster_path.toLowerCase().endsWith(showPosterPath.toLowerCase()));
      if (posterMatch) {
        exactMatch = posterMatch;
      }
    }

    // 2. Exact normalized title + release year match
    if (!exactMatch) {
      const normShowTitle = normalizeTitle(cleanTitleForSearch(show.title));
      const filtered = candidates.filter(c => {
        const cTitle = c.title || c.name || '';
        const cOriginal = c.original_title || c.original_name || '';
        const normCTitle = normalizeTitle(cTitle);
        const normCOriginal = normalizeTitle(cOriginal);
        const titleMatches = normShowTitle === normCTitle || normShowTitle === normCOriginal;
        if (!titleMatches) return false;

        if (show.year && show.year > 1900) {
          const cYearStr = c.release_date || c.first_air_date || '';
          const cYear = parseInt(cYearStr.slice(0, 4), 10);
          if (cYear > 1900 && Math.abs(cYear - show.year) > 1) {
            return false;
          }
        }
        return true;
      });

      if (filtered.length === 1) {
        exactMatch = filtered[0];
      } else if (filtered.length > 1 && show.year && show.year > 1900) {
        // Find exact year match
        const exactYear = filtered.find(c => {
          const cYearStr = c.release_date || c.first_air_date || '';
          const cYear = parseInt(cYearStr.slice(0, 4), 10);
          return cYear === show.year;
        });
        if (exactYear) {
          exactMatch = exactYear;
        }
      }
    }

    if (!exactMatch) {
      skippedAmbiguous++;
      continue;
    }

    const matchedKind = exactMatch.media_type === 'tv' || exactMatch.first_air_date || show.category === 'series' || show.category === 'anime' ? 'tv' : 'movie';
    const externalIds = await fetchExternalIds(exactMatch.id, matchedKind === 'tv' ? 'tv' : 'movie');

    const updateData: any = {
      tmdb_id: exactMatch.id,
    };

    if (externalIds.imdb_id && !show.imdb_id) {
      updateData.imdb_id = externalIds.imdb_id;
    }
    if (externalIds.tvdb_id) {
      updateData.tvdb_id = externalIds.tvdb_id;
    }
    if (exactMatch.poster_path && (!show.poster_url || !show.poster_url.includes('tmdb.org'))) {
      updateData.poster_url = `https://image.tmdb.org/t/p/w780${exactMatch.poster_path}`;
    }
    if (exactMatch.backdrop_path) {
      updateData.banner_url = `https://image.tmdb.org/t/p/w1280${exactMatch.backdrop_path}`;
    }
    if (exactMatch.overview && (!show.description || show.description.length < 20 || show.description.includes('Ver dorama') || show.description.includes('Ver pelicula'))) {
      updateData.description = exactMatch.overview;
    }
    if (matchedKind === 'tv' && show.category === 'movie') {
      updateData.category = 'series';
    }

    await prisma.show.update({
      where: { id: show.id },
      data: updateData,
    });

    matchedCount++;
    if (matchedCount % 100 === 0 || matchedCount <= 5) {
      console.log(`[${matchedCount}] Matched "${show.title}" -> TMDB ${exactMatch.id} (${exactMatch.title || exactMatch.name}) | IMDb: ${externalIds.imdb_id || 'none'}`);
    }

    // Rate limiting to respect TMDB API
    if (i % 20 === 0) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log('\n--- TMDB Backfill Completed ---');
  console.log(`Matched with 100% confidence: ${matchedCount}`);
  console.log(`Skipped ambiguous / unverified: ${skippedAmbiguous}`);
  console.log(`No TMDB results: ${noResultsCount}`);
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
