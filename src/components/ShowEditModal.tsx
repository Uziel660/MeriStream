// src/components/ShowEditModal.tsx
// Editor completo de una obra del catálogo: todos los campos de la BD,
// refresh de streams JIT y plataformas donde está disponible ese título.

import React, { useEffect, useState } from 'react';
import { X, Save, RefreshCw, Globe, Loader2 } from 'lucide-react';
import { api } from '../api/client';

interface ShowEditModalProps {
  show: any;
  onClose: () => void;
  onSaved: (updated: any) => void;
}

const ShowEditModal: React.FC<ShowEditModalProps> = ({ show, onClose, onSaved }) => {
  const [form, setForm] = useState<any>({ ...show });
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [platforms, setPlatforms] = useState<Array<{ site: string; count: number }> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/v1/shows/${show.id}`);
        if (!res.ok) return;
        const fresh = await res.json();
        if (!alive) return;
        setForm((f: any) => ({ ...f, ...fresh }));
        const mid = fresh.media_item_id ?? null;
        if (mid) {
          const pmRes = await fetch(`/api/v1/play-multi/${mid}`);
          if (pmRes.ok) {
            const pm = await pmRes.json();
            const bySite = new Map<string, number>();
            for (const c of pm.cascade || []) {
              const site = String(c.source_site || c.host || 'unknown');
              bySite.set(site, (bySite.get(site) || 0) + 1);
            }
            if (alive) setPlatforms(Array.from(bySite.entries()).map(([site, count]) => ({ site, count })));
          } else if (alive) {
            setPlatforms([]);
          }
        } else if (alive) {
          setPlatforms([]);
        }
      } catch {
        /* silencio */
      }
    })();
    return () => {
      alive = false;
    };
  }, [show.id]);

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    setSavedMsg(null);
    try {
      const updated = await api.updateShow(show.id, {
        title: form.title,
        description: form.description,
        genres: form.genres,
        year: form.year ? Number(form.year) : undefined,
        rating: form.rating !== undefined && form.rating !== null ? Number(form.rating) : undefined,
        status: form.status,
        category: form.category,
        poster_url: form.poster_url,
        banner_url: form.banner_url,
        japanese_title: form.japanese_title,
        english_title: form.english_title,
      });
      setSavedMsg('Cambios guardados');
      onSaved(updated);
    } catch (e: any) {
      setSavedMsg(e?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const refreshStreams = async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const r = await api.refreshShowStreams(show.id);
      setRefreshMsg(r.message || 'Refrescando streams en background...');
    } catch (e: any) {
      setRefreshMsg(e?.message || 'Error al refrescar');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto p-5 rounded-2xl bg-zinc-900 border border-zinc-700 shadow-2xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <h3 className="text-sm font-bold text-white">Editar obra: {show.title}</h3>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition">
            <X size={16} />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="text-xs font-semibold text-zinc-300 block mb-1">Título</label>
            <input
              type="text"
              value={form.title || ''}
              onChange={(e) => set('title', e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-xs font-semibold text-zinc-300 block mb-1">Descripción</label>
            <textarea
              value={form.description || ''}
              onChange={(e) => set('description', e.target.value)}
              rows={4}
              className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60 resize-y"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-zinc-300 block mb-1">Categoría</label>
            <select
              value={form.category || 'anime'}
              onChange={(e) => set('category', e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
            >
              <option value="anime">Anime</option>
              <option value="series">Serie</option>
              <option value="movie">Película</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-zinc-300 block mb-1">Géneros (separados por coma)</label>
            <input
              type="text"
              value={form.genres || ''}
              onChange={(e) => set('genres', e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-zinc-300 block mb-1">Año</label>
            <input
              type="number"
              value={form.year || ''}
              onChange={(e) => set('year', parseInt(e.target.value, 10) || 0)}
              className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-zinc-300 block mb-1">Rating</label>
            <input
              type="number"
              step="0.1"
              value={form.rating ?? ''}
              onChange={(e) => set('rating', parseFloat(e.target.value) || 0)}
              className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-zinc-300 block mb-1">Póster (URL)</label>
            <input
              type="text"
              value={form.poster_url || ''}
              onChange={(e) => set('poster_url', e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-zinc-300 block mb-1">Banner (URL)</label>
            <input
              type="text"
              value={form.banner_url || ''}
              onChange={(e) => set('banner_url', e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-zinc-300 block mb-1">Título japonés</label>
            <input
              type="text"
              value={form.japanese_title || ''}
              onChange={(e) => set('japanese_title', e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-zinc-300 block mb-1">Título inglés</label>
            <input
              type="text"
              value={form.english_title || ''}
              onChange={(e) => set('english_title', e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
            />
          </div>
        </div>

        {/* Plataformas disponibles para ESTE título */}
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800">
          <div className="flex items-center gap-2 text-xs font-bold text-zinc-300 mb-2">
            <Globe size={13} className="text-emerald-400" />
            Plataformas donde está disponible
          </div>
          {platforms === null ? (
            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
              <Loader2 size={12} className="animate-spin" /> Consultando fuentes...
            </div>
          ) : platforms.length === 0 ? (
            <p className="text-[11px] text-zinc-500">Sin fuentes multi-plataforma registradas para este título.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {platforms.map((p) => (
                <span key={p.site} className="text-[10px] px-2 py-1 rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 font-semibold">
                  {p.site} ({p.count} {p.count === 1 ? 'fuente' : 'fuentes'})
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Acciones */}
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
          >
            <Save size={13} />
            {saving ? 'Guardando...' : 'Guardar cambios'}
          </button>
          <button
            type="button"
            onClick={refreshStreams}
            disabled={refreshing}
            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
            title="Re-resuelve los servidores de cada episodio y agrega fuentes nuevas"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Refrescando...' : 'Refrescar streams'}
          </button>
          {savedMsg && <span className="text-[11px] text-emerald-400">{savedMsg}</span>}
          {refreshMsg && <span className="text-[11px] text-sky-400">{refreshMsg}</span>}
        </div>
      </div>
    </div>
  );
};

export default ShowEditModal;
