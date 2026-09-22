import React, { useEffect, useMemo, useState } from 'react';
import {
  Eye,
  EyeOff,
  Loader2,
  Search,
  ChevronDown,
  ChevronRight,
  Film,
  Star,
  RefreshCw,
  X,
  ExternalLink,
  Filter,
} from 'lucide-react';
import { useHiddenGenres } from '../hooks/useHiddenGenres';
import { SmartImage } from './SmartImage';

interface GenreSummary {
  genre: string;
  count: number;
  hidden: boolean;
}

interface GenreWorkItem {
  id: string;
  title: string;
  original_title?: string | null;
  category?: string;
  year?: number;
  rating?: number;
  poster_url?: string | null;
  banner_url?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genres?: string;
  tmdb_id?: number | null;
  status?: string;
}

interface GenresManagerProps {
  onEditShow?: (show: any) => void;
  onOpenPublicShow?: (show: any) => void;
}

function summariesFromShows(shows: any[]): GenreSummary[] {
  const counts = new Map<string, { label: string; count: number }>();
  const seenWorks = new Set<string>();
  for (const show of shows) {
    const identity = String(show?.id || `${show?.category || ''}:${show?.title || ''}`);
    if (seenWorks.has(identity)) continue;
    seenWorks.add(identity);
    const genres = Array.isArray(show?.genres) ? show.genres : String(show?.genres || '').split(/[,/|•]+/);
    const counted = new Set<string>();
    for (const raw of genres) {
      const label = String(raw || '').trim();
      const key = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (!key || counted.has(key)) continue;
      counted.add(key);
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { label, count: 1 });
    }
  }
  return [...counts.values()]
    .map(({ label, count }) => ({ genre: label, count, hidden: false }))
    .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre, 'es'));
}

export const GenresManager: React.FC<GenresManagerProps> = ({ onEditShow, onOpenPublicShow }) => {
  const { hiddenGenres, toggleGenre, hiddenCount, hiddenShowIds, isShowHidden, toggleShow } = useHiddenGenres();
  const [genres, setGenres] = useState<GenreSummary[]>([]);
  const [search, setSearch] = useState('');
  const [genreVisibilityFilter, setGenreVisibilityFilter] = useState<'all' | 'visible' | 'hidden'>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Estado para visualización de catálogo por género
  const [expandedGenre, setExpandedGenre] = useState<string | null>(null);
  const [works, setWorks] = useState<GenreWorkItem[]>([]);
  const [worksTotal, setWorksTotal] = useState(0);
  const [worksPage, setWorksPage] = useState(1);
  const [worksTotalPages, setWorksTotalPages] = useState(1);
  const [isLoadingWorks, setIsLoadingWorks] = useState(false);
  const [worksError, setWorksError] = useState<string | null>(null);
  const [worksSearch, setWorksSearch] = useState('');
  const [worksCategory, setWorksCategory] = useState<string>('all');
  const [worksVisibilityFilter, setWorksVisibilityFilter] = useState<'all' | 'visible' | 'hidden'>('all');

  const WORKS_LIMIT = 24;

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    fetch('/api/v1/admin/catalog/visibility', { cache: 'no-store' })
      .then(async (response) => {
        const contentType = response.headers.get('content-type') || '';
        if (response.ok && contentType.includes('application/json')) return response.json();
        const fallback = await fetch('/api/v1/shows?lite=true&include_legacy=true&page=1&limit=50000', { cache: 'no-store' });
        if (!fallback.ok) throw new Error('No se pudo cargar la visibilidad del catálogo.');
        const fallbackData = await fallback.json();
        return { genres: summariesFromShows(Array.isArray(fallbackData) ? fallbackData : fallbackData.shows || []) };
      })
      .then((data) => {
        if (!active) return;
        setGenres(Array.isArray(data.genres) ? data.genres : []);
        setError(null);
      })
      .catch((reason: any) => {
        if (active) setError(reason?.message || 'No se pudo cargar la visibilidad del catálogo.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => { active = false; };
  }, [hiddenCount]);

  // Cargar obras del género expandido
  useEffect(() => {
    if (!expandedGenre) {
      setWorks([]);
      setWorksTotal(0);
      return;
    }

    let active = true;
    setIsLoadingWorks(true);
    setWorksError(null);

    const queryParams = new URLSearchParams({
      genre: expandedGenre,
      page: String(worksPage),
      limit: String(WORKS_LIMIT),
    });
    if (worksSearch.trim()) {
      queryParams.set('search', worksSearch.trim());
    }
    if (worksCategory && worksCategory !== 'all') {
      queryParams.set('category', worksCategory);
    }
    if (worksVisibilityFilter !== 'all') {
      queryParams.set('visibility', worksVisibilityFilter);
    }

    fetch(`/api/v1/admin/catalog/visibility/shows?${queryParams.toString()}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Error al cargar obras del género.');
        }
        return res.json();
      })
      .then((data) => {
        if (!active) return;
        setWorks(Array.isArray(data.shows) ? data.shows : []);
        setWorksTotal(Number(data.total) || 0);
        setWorksTotalPages(Math.max(1, Number(data.totalPages) || 1));
      })
      .catch((err: any) => {
        if (active) setWorksError(err?.message || 'No se pudieron cargar las obras.');
      })
      .finally(() => {
        if (active) setIsLoadingWorks(false);
      });

    return () => {
      active = false;
    };
  }, [expandedGenre, worksPage, worksSearch, worksCategory, worksVisibilityFilter, hiddenShowIds.size]);

  const handleToggleExpandGenre = (genreName: string) => {
    if (expandedGenre === genreName) {
      setExpandedGenre(null);
    } else {
      setExpandedGenre(genreName);
      setWorksPage(1);
      setWorksSearch('');
      setWorksCategory('all');
      setWorksVisibilityFilter('all');
    }
  };

  const handleOpenPublic = (work: GenreWorkItem) => {
    if (onOpenPublicShow) {
      onOpenPublicShow(work);
      return;
    }
    const rawKind = String(work.category || 'movie').toLowerCase();
    const kind = rawKind.includes('movie') || rawKind.includes('pel')
      ? 'movie'
      : rawKind.includes('anime')
        ? 'anime'
        : 'series';
    const publicId = work.tmdb_id ? `tmdb-${kind}-${work.tmdb_id}` : work.id;
    window.open(`/?show_id=${encodeURIComponent(publicId)}`, '_blank');
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('es');
    return genres.filter((item) => {
      const isHidden = hiddenGenres.has(item.genre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
      if (genreVisibilityFilter === 'visible' && isHidden) return false;
      if (genreVisibilityFilter === 'hidden' && !isHidden) return false;
      return !query || item.genre.toLocaleLowerCase('es').includes(query);
    });
  }, [genres, search, genreVisibilityFilter, hiddenGenres]);

  return (
    <section className="space-y-5" aria-labelledby="visibility-title">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Catálogo público</p>
          <h3 id="visibility-title" className="mt-1 text-lg font-semibold text-white">Visibilidad y Catálogo por Géneros</h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-400">
            Explora las obras agrupadas por cada género, filtra por visibilidad, abre la ficha pública y oculta o muestra géneros completos u obras individuales.
          </p>
        </div>
        <div className="text-right text-xs text-zinc-500">
          <div><span className="text-zinc-200">{genres.length}</span> géneros detectados</div>
          <div><span className="text-zinc-200">{hiddenCount}</span> ocultos · <span className="text-zinc-200">{hiddenShowIds.size}</span> obras ocultas</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative w-full sm:w-80">
            <Search size={14} className="pointer-events-none absolute left-3 top-2.5 text-zinc-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar un género..."
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-9 py-2 text-xs text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-400"
            />
          </div>
          {isLoading && <Loader2 size={15} className="animate-spin text-zinc-500" aria-label="Cargando géneros" />}
        </div>

        {/* Filtro de géneros: Todos / Visibles / Ocultos */}
        <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/80 p-1 text-xs">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 px-2 flex items-center gap-1">
            <Filter size={11} /> Géneros:
          </span>
          <button
            type="button"
            onClick={() => setGenreVisibilityFilter('all')}
            className={`px-2.5 py-1 rounded-md transition-colors text-[11px] ${
              genreVisibilityFilter === 'all'
                ? 'bg-zinc-800 text-white font-semibold shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Todos ({genres.length})
          </button>
          <button
            type="button"
            onClick={() => setGenreVisibilityFilter('visible')}
            className={`px-2.5 py-1 rounded-md transition-colors text-[11px] ${
              genreVisibilityFilter === 'visible'
                ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Visibles ({Math.max(0, genres.length - hiddenCount)})
          </button>
          <button
            type="button"
            onClick={() => setGenreVisibilityFilter('hidden')}
            className={`px-2.5 py-1 rounded-md transition-colors text-[11px] ${
              genreVisibilityFilter === 'hidden'
                ? 'bg-red-500/20 text-red-300 font-semibold border border-red-500/30'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Ocultos ({hiddenCount})
          </button>
        </div>
      </div>

      {error ? (
        <div className="border border-red-900/70 bg-red-950/20 px-4 py-3 text-xs text-red-300">{error}</div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-[#0b0f14]">
          <div className="grid grid-cols-[minmax(0,1fr)_160px_110px] border-b border-zinc-800 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
            <span>Género</span>
            <span>Catálogo de Obras</span>
            <span className="text-right">Visibilidad</span>
          </div>
          <div className="max-h-[65vh] overflow-y-auto divide-y divide-zinc-900">
            {filtered.length === 0 && !isLoading ? (
              <p className="px-4 py-10 text-center text-xs text-zinc-500">No hay géneros que coincidan con los filtros aplicados.</p>
            ) : filtered.map((item) => {
              const hidden = hiddenGenres.has(item.genre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
              const isExpanded = expandedGenre === item.genre;

              return (
                <div key={item.genre} className="transition-colors">
                  <div
                    className={`grid grid-cols-[minmax(0,1fr)_160px_110px] items-center px-4 py-3 cursor-pointer transition-colors ${
                      isExpanded ? 'bg-zinc-800/50' : 'hover:bg-zinc-900/50'
                    }`}
                    onClick={() => handleToggleExpandGenre(item.genre)}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 pr-2">
                      <button
                        type="button"
                        aria-label={isExpanded ? 'Colapsar obras' : 'Ver obras'}
                        className="p-1 rounded text-zinc-400 hover:text-white transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleExpandGenre(item.genre);
                        }}
                      >
                        {isExpanded ? <ChevronDown size={15} className="text-amber-400" /> : <ChevronRight size={15} />}
                      </button>
                      <span className={`font-medium truncate ${hidden ? 'text-xs text-zinc-500 line-through' : 'text-xs text-zinc-200'}`}>
                        {item.genre}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs tabular-nums text-zinc-400 font-mono">
                        {item.count.toLocaleString('es-MX')} obras
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleExpandGenre(item.genre);
                        }}
                        className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                          isExpanded
                            ? 'border-amber-500/40 bg-amber-500/10 text-amber-300 font-semibold'
                            : 'border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {isExpanded ? 'Cerrar' : 'Ver obras'}
                      </button>
                    </div>

                    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => toggleGenre(item.genre)}
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                          hidden
                            ? 'border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'
                            : 'border-zinc-700 text-zinc-300 hover:border-zinc-400 hover:text-white'
                        }`}
                        aria-label={`${hidden ? 'Mostrar' : 'Ocultar'} género ${item.genre}`}
                      >
                        {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                        {hidden ? 'Oculto' : 'Visible'}
                      </button>
                    </div>
                  </div>

                  {/* Panel expandido del catálogo de obras de este género */}
                  {isExpanded && (
                    <div className="border-t border-b border-zinc-800 bg-[#070a0e] p-4 sm:p-5 space-y-4 shadow-inner">
                      {/* Cabecera del panel expandido con filtros */}
                      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-zinc-800/80">
                        <div className="flex items-center gap-2">
                          <Film size={16} className="text-amber-400" />
                          <h4 className="text-xs font-bold text-white tracking-wide">
                            Catálogo de «{item.genre}»
                          </h4>
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700 font-mono">
                            {worksTotal.toLocaleString('es-MX')} obras encontradas
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {/* Filtro de obras: Todas / Visibles / Ocultas */}
                          <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/80 p-0.5 text-[10px]">
                            <button
                              type="button"
                              onClick={() => {
                                setWorksVisibilityFilter('all');
                                setWorksPage(1);
                              }}
                              className={`px-2 py-1 rounded-md transition-colors ${
                                worksVisibilityFilter === 'all'
                                  ? 'bg-zinc-800 text-white font-semibold'
                                  : 'text-zinc-400 hover:text-zinc-200'
                              }`}
                            >
                              Todas
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setWorksVisibilityFilter('visible');
                                setWorksPage(1);
                              }}
                              className={`px-2 py-1 rounded-md transition-colors ${
                                worksVisibilityFilter === 'visible'
                                  ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30'
                                  : 'text-zinc-400 hover:text-zinc-200'
                              }`}
                            >
                              Visibles
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setWorksVisibilityFilter('hidden');
                                setWorksPage(1);
                              }}
                              className={`px-2 py-1 rounded-md transition-colors ${
                                worksVisibilityFilter === 'hidden'
                                  ? 'bg-red-500/20 text-red-300 font-semibold border border-red-500/30'
                                  : 'text-zinc-400 hover:text-zinc-200'
                              }`}
                            >
                              Ocultas
                            </button>
                          </div>

                          {/* Filtro de categoría */}
                          <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/80 p-0.5 text-[10px]">
                            {(['all', 'movie', 'series', 'anime'] as const).map((cat) => (
                              <button
                                key={cat}
                                type="button"
                                onClick={() => {
                                  setWorksCategory(cat);
                                  setWorksPage(1);
                                }}
                                className={`px-2 py-1 rounded-md capitalize transition-colors ${
                                  worksCategory === cat
                                    ? 'bg-amber-500/20 text-amber-300 font-semibold border border-amber-500/30'
                                    : 'text-zinc-400 hover:text-zinc-200'
                                }`}
                              >
                                {cat === 'all' ? 'Todas' : cat === 'movie' ? 'Películas' : cat === 'series' ? 'Series' : 'Anime'}
                              </button>
                            ))}
                          </div>

                          {/* Buscador dentro del género */}
                          <div className="relative">
                            <Search size={12} className="pointer-events-none absolute left-2.5 top-2.5 text-zinc-500" />
                            <input
                              value={worksSearch}
                              onChange={(e) => {
                                setWorksSearch(e.target.value);
                                setWorksPage(1);
                              }}
                              placeholder={`Buscar en ${item.genre}...`}
                              className="w-44 sm:w-56 rounded-lg border border-zinc-800 bg-zinc-900/90 pl-8 pr-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 outline-none"
                            />
                            {worksSearch && (
                              <button
                                type="button"
                                onClick={() => {
                                  setWorksSearch('');
                                  setWorksPage(1);
                                }}
                                className="absolute right-2 top-2 text-zinc-500 hover:text-zinc-300"
                              >
                                <X size={12} />
                              </button>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={() => setExpandedGenre(null)}
                            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                            title="Cerrar catálogo"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>

                      {/* Contenido de obras */}
                      {isLoadingWorks ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-zinc-400">
                          <Loader2 size={24} className="animate-spin text-amber-400" />
                          <p className="text-xs">Cargando obras de {item.genre}...</p>
                        </div>
                      ) : worksError ? (
                        <div className="border border-red-900/70 bg-red-950/20 px-4 py-3 rounded-lg text-xs text-red-300">
                          {worksError}
                        </div>
                      ) : works.length === 0 ? (
                        <div className="text-center py-10 text-xs text-zinc-500">
                          No se encontraron obras con los filtros aplicados en este género.
                        </div>
                      ) : (
                        <>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                            {works.map((work) => {
                              const isHidden = isShowHidden(work);
                              const posterSrc = work.poster_url || work.banner_url || null;

                              return (
                                <div
                                  key={work.id}
                                  className="group relative flex flex-col rounded-xl border border-zinc-800/80 bg-zinc-950/60 overflow-hidden hover:border-zinc-700 transition-all hover:shadow-lg"
                                >
                                  {/* Poster interactivo: clic abre ficha pública */}
                                  <div
                                    onClick={() => handleOpenPublic(work)}
                                    className="relative aspect-[2/3] w-full bg-zinc-900 overflow-hidden cursor-pointer"
                                    title="Haz clic para ver la ficha en el catálogo público"
                                  >
                                    <SmartImage
                                      src={posterSrc}
                                      alt={work.title}
                                      className={`h-full w-full object-cover transition-transform duration-300 group-hover:scale-105 ${
                                        isHidden ? 'opacity-40 grayscale' : ''
                                      }`}
                                      loading="lazy"
                                      decoding="async"
                                      fallback={
                                        <div className="h-full w-full flex flex-col items-center justify-center p-2 text-center text-zinc-600 bg-zinc-900">
                                          <Film size={20} className="mb-1 text-zinc-700" />
                                          <span className="text-[10px] line-clamp-2 leading-tight">{work.title}</span>
                                        </div>
                                      }
                                    />

                                    {/* Hover overlay indicando abrir ficha pública */}
                                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-black/80 text-white text-[10px] font-semibold border border-white/20 shadow-lg">
                                        <ExternalLink size={11} /> Ver ficha
                                      </span>
                                    </div>

                                    {/* Overlay de categoría & año */}
                                    <div className="absolute top-1.5 left-1.5 flex flex-wrap gap-1">
                                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-black/80 backdrop-blur text-amber-400 border border-amber-500/30">
                                        {work.category || 'movie'}
                                      </span>
                                      {Boolean(work.year) && (
                                        <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-black/80 backdrop-blur text-zinc-300 border border-zinc-700/60">
                                          {work.year}
                                        </span>
                                      )}
                                    </div>

                                    {/* Rating badge */}
                                    {Boolean(work.rating && work.rating > 0) && (
                                      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-black/80 backdrop-blur text-yellow-400 border border-yellow-500/30">
                                        <Star size={10} className="fill-yellow-400 text-yellow-400" />
                                        <span>{Number(work.rating).toFixed(1)}</span>
                                      </div>
                                    )}

                                    {/* Badge si la obra individual está oculta */}
                                    {isHidden && (
                                      <div className="absolute inset-x-0 bottom-0 bg-red-950/90 py-1 text-center text-[10px] font-bold text-red-300 border-t border-red-900">
                                        Obra oculta al público
                                      </div>
                                    )}
                                  </div>

                                  {/* Metadatos y acciones */}
                                  <div className="flex flex-1 flex-col justify-between p-2.5">
                                    <div>
                                      <h5
                                        onClick={() => handleOpenPublic(work)}
                                        className="text-xs font-semibold text-white line-clamp-2 group-hover:text-amber-300 transition-colors cursor-pointer"
                                        title={`Ver ficha pública de ${work.title}`}
                                      >
                                        {work.title}
                                      </h5>
                                      {work.original_title && work.original_title !== work.title && (
                                        <p className="text-[10px] text-zinc-500 truncate mt-0.5" title={work.original_title}>
                                          {work.original_title}
                                        </p>
                                      )}
                                    </div>

                                    <div className="mt-2.5 pt-2 border-t border-zinc-800/80 flex items-center justify-between gap-1">
                                      {/* Botón de visibilidad de obra */}
                                      <button
                                        type="button"
                                        onClick={() => toggleShow(work)}
                                        className={`p-1.5 rounded-lg border transition-colors ${
                                          isHidden
                                            ? 'border-red-900/50 bg-red-950/30 text-red-400 hover:bg-red-950/60'
                                            : 'border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                                        }`}
                                        title={isHidden ? 'Hacer visible esta obra' : 'Ocultar esta obra del público'}
                                        aria-label={`${isHidden ? 'Mostrar' : 'Ocultar'} ${work.title}`}
                                      >
                                        {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                                      </button>

                                      <div className="flex items-center gap-1">
                                        {/* Botón de ver ficha pública */}
                                        <button
                                          type="button"
                                          onClick={() => handleOpenPublic(work)}
                                          className="inline-flex items-center gap-1 p-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800 text-[10px] transition-colors"
                                          title="Abrir ficha en el catálogo público"
                                        >
                                          <ExternalLink size={12} />
                                        </button>

                                        {/* Botón de editar obra */}
                                        {onEditShow && (
                                          <button
                                            type="button"
                                            onClick={() => onEditShow(work)}
                                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 text-[10px] font-medium transition-colors"
                                            title="Editar metadatos, IDs y streams de esta obra"
                                          >
                                            <RefreshCw size={11} />
                                            <span>Editar</span>
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                          {/* Paginación */}
                          {worksTotalPages > 1 && (
                            <div className="flex items-center justify-between border-t border-zinc-800 pt-3 text-xs text-zinc-400">
                              <div>
                                Página <span className="text-zinc-200 font-semibold">{worksPage}</span> de{' '}
                                <span className="text-zinc-200 font-semibold">{worksTotalPages}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={worksPage <= 1}
                                  onClick={() => setWorksPage((prev) => Math.max(1, prev - 1))}
                                  className="px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none text-xs text-zinc-200 transition-colors"
                                >
                                  Anterior
                                </button>
                                <button
                                  type="button"
                                  disabled={worksPage >= worksTotalPages}
                                  onClick={() => setWorksPage((prev) => Math.min(worksTotalPages, prev + 1))}
                                  className="px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none text-xs text-zinc-200 transition-colors"
                                >
                                  Siguiente
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};
