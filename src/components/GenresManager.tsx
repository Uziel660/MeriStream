import React, { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Loader2, Search } from 'lucide-react';
import { useHiddenGenres } from '../hooks/useHiddenGenres';

interface GenreSummary {
  genre: string;
  count: number;
  hidden: boolean;
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

/** Visibilidad pública basada en todo el catálogo del servidor. */
export const GenresManager: React.FC = () => {
  const { hiddenGenres, toggleGenre, hiddenCount, hiddenShowIds } = useHiddenGenres();
  const [genres, setGenres] = useState<GenreSummary[]>([]);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    fetch('/api/v1/admin/catalog/visibility', { cache: 'no-store' })
      .then(async (response) => {
        const contentType = response.headers.get('content-type') || '';
        if (response.ok && contentType.includes('application/json')) return response.json();
        // Compatibilidad con el backend que ya estaba abierto antes de esta
        // versión: no bloquea el panel y calcula los géneros con todo el
        // catálogo administrativo, no con las 50 filas visibles.
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

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('es');
    return genres.filter((item) => !query || item.genre.toLocaleLowerCase('es').includes(query));
  }, [genres, search]);

  return (
    <section className="space-y-5" aria-labelledby="visibility-title">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Catálogo público</p>
          <h3 id="visibility-title" className="mt-1 text-lg font-semibold text-white">Visibilidad</h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-400">
            Ocultar un género lo quita de los filtros, las filas y la metadata visible. La obra conserva sus géneros originales internamente.
          </p>
        </div>
        <div className="text-right text-xs text-zinc-500">
          <div><span className="text-zinc-200">{genres.length}</span> géneros detectados</div>
          <div><span className="text-zinc-200">{hiddenCount}</span> ocultos · <span className="text-zinc-200">{hiddenShowIds.size}</span> obras ocultas</div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative w-full max-w-md">
          <Search size={14} className="pointer-events-none absolute left-3 top-2.5 text-zinc-500" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar un género del catálogo..."
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-9 py-2 text-xs text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-400"
          />
        </div>
        {isLoading && <Loader2 size={15} className="animate-spin text-zinc-500" aria-label="Cargando géneros" />}
      </div>

      {error ? (
        <div className="border border-red-900/70 bg-red-950/20 px-4 py-3 text-xs text-red-300">{error}</div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-[#0b0f14]">
          <div className="grid grid-cols-[minmax(0,1fr)_100px_108px] border-b border-zinc-800 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
            <span>Género</span><span>Obras</span><span className="text-right">Estado</span>
          </div>
          <div className="max-h-[58vh] overflow-y-auto">
            {filtered.length === 0 && !isLoading ? (
              <p className="px-4 py-10 text-center text-xs text-zinc-500">No hay géneros que coincidan con esa búsqueda.</p>
            ) : filtered.map((item) => {
              const hidden = hiddenGenres.has(item.genre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
              return (
                <div key={item.genre} className="grid grid-cols-[minmax(0,1fr)_100px_108px] items-center border-b border-zinc-900 px-4 py-3 last:border-b-0 hover:bg-zinc-900/50">
                  <span className={hidden ? 'text-xs text-zinc-600 line-through' : 'text-xs text-zinc-200'}>{item.genre}</span>
                  <span className="text-xs tabular-nums text-zinc-500">{item.count.toLocaleString('es-MX')}</span>
                  <button
                    type="button"
                    onClick={() => toggleGenre(item.genre)}
                    className={`ml-auto inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${hidden ? 'border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300' : 'border-zinc-700 text-zinc-300 hover:border-zinc-400 hover:text-white'}`}
                    aria-label={`${hidden ? 'Mostrar' : 'Ocultar'} género ${item.genre}`}
                  >
                    {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    {hidden ? 'Oculto' : 'Visible'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};
