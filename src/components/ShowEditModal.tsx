// src/components/ShowEditModal.tsx
// Editor completo de una obra del catálogo: todos los campos de la BD,
// refresh de streams JIT y plataformas donde está disponible ese título.

import React, { useEffect, useState } from 'react';
import { X, Save, RefreshCw, Globe, Loader2, AlertTriangle, Plus, Trash2, ExternalLink, Search, GitMerge, CheckCircle2 } from 'lucide-react';
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
  const [forcingTmdb, setForcingTmdb] = useState(false);
  const [platforms, setPlatforms] = useState<Array<{ site: string; count: number }> | null>(null);
  const [serversByPlatform, setServersByPlatform] = useState<Map<string, Map<string, number>> | null>(null);
  const [episodePlatforms, setEpisodePlatforms] = useState<Array<{ domain: string; episodes: number }> | null>(null);
  const [tmdbInput, setTmdbInput] = useState(show.tmdb_id ? String(show.tmdb_id) : '');
  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityConflict, setIdentityConflict] = useState<any | null>(null);
  const [identityMsg, setIdentityMsg] = useState<string | null>(null);
  const [managedStreams, setManagedStreams] = useState<any[]>([]);
  const [legacyEpisodes, setLegacyEpisodes] = useState<any[]>([]);
  const [legacyBusy, setLegacyBusy] = useState<string | null>(null);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const [legacyProviderDrafts, setLegacyProviderDrafts] = useState<Record<string, string>>({});
  const [newStream, setNewStream] = useState({ season_number: '1', episode_number: '1', source_site: '', url: '', link_type: 'direct', language: '', source_status: 'discovered', priority_tier: '' });
  const [streamBusy, setStreamBusy] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [identitySource, setIdentitySource] = useState('tmdb');
  const [identityLookupValue, setIdentityLookupValue] = useState('');
  const [identityLookupBusy, setIdentityLookupBusy] = useState(false);
  const [identityPreview, setIdentityPreview] = useState<any | null>(null);
  const [mergeQuery, setMergeQuery] = useState('');
  const [mergeCandidates, setMergeCandidates] = useState<any[]>([]);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState<number | 'all'>('all');
  const [availabilityScope, setAvailabilityScope] = useState<'both' | 'vidsrc' | 'zokoanime'>('both');
  const [availabilitySeason, setAvailabilitySeason] = useState('1');
  const [availabilityEpisode, setAvailabilityEpisode] = useState('1');
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [availabilityResult, setAvailabilityResult] = useState<any | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Las fichas creadas desde una consulta TMDB atraviesan el buffer de
        // escritura. Reintentar aquí evita abrir un editor vacío mientras el
        // Show/MediaItem canónico termina de persistirse.
        const shouldWaitForCanonical = Boolean(show.__awaitCanonical || (!show.media_item_id && show.tmdb_id));
        let fresh: any = null;
        const attempts = shouldWaitForCanonical ? 12 : 1;
        for (let attempt = 0; attempt < attempts && alive; attempt++) {
          const res = await fetch(`/api/v1/shows/${show.id}`, { credentials: 'same-origin' });
          if (res.ok) {
            fresh = await res.json();
            if (fresh.media_item_id || !shouldWaitForCanonical || attempt === attempts - 1) break;
          }
          if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!fresh) return;
        if (!alive) return;
        setForm((f: any) => ({ ...f, ...fresh }));
        setTmdbInput(fresh.tmdb_id ? String(fresh.tmdb_id) : '');
        setEpisodePlatforms(Array.isArray(fresh.episode_platforms) ? fresh.episode_platforms : []);
        const legacyRes = await fetch(`/api/v1/admin/shows/${encodeURIComponent(show.id)}/legacy-episodes`, { credentials: 'same-origin' });
        if (legacyRes.ok && alive) {
          const legacyData = await legacyRes.json();
          setLegacyEpisodes(Array.isArray(legacyData.episodes) ? legacyData.episodes : []);
        }
        const mid = fresh.media_item_id ?? null;
        if (mid) {
          const pmRes = await fetch(`/api/v1/play-multi/${mid}`, { credentials: 'same-origin' });
          if (pmRes.ok) {
            const pm = await pmRes.json();
            const bySite = new Map<string, number>();
            // Jerarquía plataforma → servidores (host de video dentro de cada plataforma)
            const servers = new Map<string, Map<string, number>>();
            for (const c of pm.cascade || []) {
              const site = String(c.source_site || c.host || 'unknown');
              bySite.set(site, (bySite.get(site) || 0) + 1);
              const host = String(c.host || 'directo');
              if (!servers.has(site)) servers.set(site, new Map());
              const inner = servers.get(site)!;
              inner.set(host, (inner.get(host) || 0) + 1);
            }
            if (alive) {
              setPlatforms(Array.from(bySite.entries()).map(([site, count]) => ({ site, count })));
              setServersByPlatform(servers);
            }
          } else if (alive) {
            setPlatforms([]);
            setServersByPlatform(new Map());
          }
          const sourcesRes = await fetch(`/api/v1/admin/media-items/${encodeURIComponent(mid)}/streams`, { credentials: 'same-origin' });
          if (sourcesRes.ok && alive) {
            const sourceData = await sourcesRes.json();
            setManagedStreams((sourceData.episodes || []).flatMap((episode: any) => (episode.links || []).map((link: any) => ({ ...link, season_number: episode.season_number, episode_number: episode.episode_number }))));
          }
        } else if (alive) {
          setPlatforms([]);
          setServersByPlatform(new Map());
          setManagedStreams([]);
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

  const updateLegacyDraft = (episodeId: string, patch: Record<string, unknown>) => {
    setLegacyEpisodes((current) => current.map((episode) => episode.id === episodeId ? { ...episode, ...patch } : episode));
  };

  const saveLegacyEpisode = async (episode: any) => {
    setLegacyBusy(episode.id);
    setLegacyError(null);
    try {
      const response = await fetch(`/api/v1/admin/shows/${encodeURIComponent(show.id)}/legacy-episodes/${encodeURIComponent(episode.id)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: episode.title, episode_number: Number(episode.episode_number), source_url: episode.source_url || '' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'No se pudo guardar la fuente legacy.');
      if (payload.episode) updateLegacyDraft(episode.id, payload.episode);
    } catch (e: any) {
      setLegacyError(e?.message || 'No se pudo guardar la fuente legacy.');
    } finally {
      setLegacyBusy(null);
    }
  };

  const deleteLegacyEpisode = async (episode: any) => {
    if (!window.confirm(`¿Eliminar la fuente legacy del episodio ${episode.episode_number}?`)) return;
    setLegacyBusy(episode.id);
    setLegacyError(null);
    try {
      const response = await fetch(`/api/v1/admin/shows/${encodeURIComponent(show.id)}/legacy-episodes/${encodeURIComponent(episode.id)}`, { method: 'DELETE', credentials: 'same-origin' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'No se pudo eliminar la fuente legacy.');
      setLegacyEpisodes((current) => current.filter((item) => item.id !== episode.id));
    } catch (e: any) {
      setLegacyError(e?.message || 'No se pudo eliminar la fuente legacy.');
    } finally {
      setLegacyBusy(null);
    }
  };

  const promoteLegacyEpisode = async (episode: any) => {
    const url = String(episode.source_url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      setLegacyError('Guarda primero una URL http(s) válida para promoverla a canónica.');
      return;
    }
    const busyKey = `promote:${episode.id}`;
    setLegacyBusy(busyKey);
    setLegacyError(null);
    try {
      const response = await fetch(`/api/v1/admin/shows/${encodeURIComponent(show.id)}/promote-legacy`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          episode_id: episode.id,
          source_site: legacyProviderDrafts[episode.id]?.trim() || undefined,
          url,
          episode_number: Number(episode.episode_number),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'No se pudo promover la página a fuente canónica.');
      setForm((current: any) => ({ ...current, media_item_id: payload.media_item_id || current.media_item_id }));
      if (payload.link) {
        const promoted = { ...payload.link, season_number: 1, episode_number: Number(episode.episode_number) || 1 };
        setManagedStreams((current) => current.some((item) => item.id === promoted.id)
          ? current.map((item) => item.id === promoted.id ? { ...item, ...promoted } : item)
          : [...current, promoted]);
      }
      setSavedMsg(payload.promoted === false ? 'La página ya era canónica; se actualizó su ruta.' : 'Página copiada al inventario canónico. La referencia legacy se conserva.');
    } catch (e: any) {
      setLegacyError(e?.message || 'No se pudo promover la página a fuente canónica.');
    } finally {
      setLegacyBusy(null);
    }
  };

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
        tmdb_id: form.tmdb_id === '' || form.tmdb_id == null ? null : Number(form.tmdb_id),
        imdb_id: form.imdb_id || null,
        tvdb_id: form.tvdb_id === '' || form.tvdb_id == null ? null : Number(form.tvdb_id),
        mal_id: form.mal_id === '' || form.mal_id == null ? null : Number(form.mal_id),
        anilist_id: form.anilist_id || null,
        kitsu_id: form.kitsu_id || null,
        anidb_id: form.anidb_id || null,
      });
      setSavedMsg('Cambios guardados');
      onSaved(updated);
    } catch (e: any) {
      setSavedMsg(e?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const applyIdentity = async (mergeShowId?: string, allowMediaConflict = false, allowSimilar = false) => {
    const parsed = tmdbInput.trim() === '' ? null : Number(tmdbInput);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed <= 0)) {
      setIdentityMsg('Introduce un TMDB ID entero positivo o deja el campo vacío para quitarlo.');
      return;
    }
    const regenerate = parsed !== null && window.confirm('¿Quieres regenerar ahora título, sinopsis, portada, géneros, año y rating desde TMDB?');
    setIdentityBusy(true);
    setIdentityMsg(null);
    try {
      const response = await fetch(`/api/v1/admin/shows/${encodeURIComponent(show.id)}/identity`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmdb_id: parsed, merge_show_id: mergeShowId, allow_media_conflict: allowMediaConflict, allow_similar: allowSimilar, regenerate_metadata: regenerate }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409 && ['TMDB_CONFLICT', 'TMDB_MEDIA_CONFLICT', 'TMDB_SIMILAR'].includes(payload.code)) {
        setIdentityConflict(payload);
        setIdentityMsg(
          payload.code === 'TMDB_SIMILAR'
            ? 'Encontré títulos parecidos. Revisa las coincidencias y decide si quieres fusionar o conservar ambas fichas.'
            : 'Este ID ya está relacionado con otra información. Revisa las coincidencias antes de continuar.',
        );
        return;
      }
      if (!response.ok) throw new Error(payload.error || 'No se pudo actualizar la identidad.');
      setIdentityConflict(null);
      setForm((current: any) => ({ ...current, ...(payload.show || {}), tmdb_id: parsed }));
      setTmdbInput(parsed ? String(parsed) : '');
      setIdentityMsg(payload.metadata_regenerated ? 'TMDB actualizado y metadatos regenerados.' : 'Identidad TMDB actualizada.');
      onSaved(payload.show || { ...form, tmdb_id: parsed });
    } catch (e: any) {
      setIdentityMsg(e?.message || 'Error actualizando TMDB.');
    } finally {
      setIdentityBusy(false);
    }
  };

  const lookupIdentity = async () => {
    if (!identityLookupValue.trim()) {
      setIdentityPreview(null);
      return;
    }
    setIdentityLookupBusy(true);
    setIdentityPreview(null);
    try {
      const response = await fetch(`/api/v1/admin/shows/${encodeURIComponent(show.id)}/identity-match`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: identitySource, value: identityLookupValue.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'No se pudo consultar el identificador.');
      setIdentityPreview(payload);
    } catch (e: any) {
      setIdentityMsg(e?.message || 'No se pudo consultar el identificador.');
    } finally {
      setIdentityLookupBusy(false);
    }
  };

  const applyIdentityProposal = () => {
    if (!identityPreview?.proposed) return;
    setForm((current: any) => {
      const next = { ...current };
      for (const key of ['tmdb_id', 'imdb_id', 'tvdb_id', 'mal_id', 'anilist_id', 'kitsu_id', 'anidb_id']) {
        if (identityPreview.proposed[key] !== undefined && identityPreview.proposed[key] !== null) next[key] = identityPreview.proposed[key];
      }
      if (identityPreview.title && window.confirm(`Encontré “${identityPreview.title}”. ¿También quieres usar ese título?`)) next.title = identityPreview.title;
      return next;
    });
    setIdentityMsg('Propuesta aplicada al formulario. Pulsa “Guardar cambios” para persistirla.');
  };

  const searchMergeCandidates = async () => {
    if (!mergeQuery.trim()) { setMergeCandidates([]); return; }
    setMergeBusy(true);
    try {
      const response = await fetch(`/api/v1/shows?lite=true&include_legacy=true&limit=20&search=${encodeURIComponent(mergeQuery.trim())}`, { credentials: 'same-origin' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'No se pudieron buscar obras.');
      const rows = Array.isArray(payload) ? payload : payload.shows || payload.items || payload.results || [];
      setMergeCandidates(rows.filter((candidate: any) => candidate.id !== show.id));
    } catch (e: any) {
      setStreamError(e?.message || 'No se pudieron buscar obras.');
    } finally {
      setMergeBusy(false);
    }
  };

  const forceMerge = async (candidate: any) => {
    if (!window.confirm(`¿Fusionar FORZADAMENTE “${candidate.title}” dentro de “${form.title}”? La obra elegida se eliminará y sus fuentes pasarán a esta ficha.`)) return;
    setMergeBusy(true);
    try {
      const response = await fetch('/api/v1/catalog/merge-works', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep_id: show.id, merge_id: candidate.id, dry_run: false }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || payload.error || 'No se pudo fusionar la obra.');
      setSavedMsg(`Fusión completada: ${candidate.title}`);
      setMergeCandidates([]);
      onSaved({ ...form, ...payload.show, id: show.id });
    } catch (e: any) {
      setSavedMsg(e?.message || 'No se pudo fusionar la obra.');
    } finally {
      setMergeBusy(false);
    }
  };

  const seasonNumbers = Array.from(new Set(managedStreams.map((stream: any) => Number(stream.season_number) || 1))).sort((a, b) => a - b);
  const visibleStreams = selectedSeason === 'all' ? managedStreams : managedStreams.filter((stream: any) => (Number(stream.season_number) || 1) === selectedSeason);

  const identityShows = Array.isArray(identityConflict?.conflicts) ? identityConflict.conflicts : [];
  const identityMediaItems = Array.isArray(identityConflict?.media_conflicts) ? identityConflict.media_conflicts : [];
  const identitySimilar = Array.isArray(identityConflict?.similar_candidates) ? identityConflict.similar_candidates : [];
  const hasIdentityReview = identityShows.length > 0 || identityMediaItems.length > 0 || identitySimilar.length > 0;

  const updateStream = async (stream: any, patch: Record<string, unknown>) => {
    setStreamBusy(stream.id);
    setStreamError(null);
    try {
      const response = await fetch(`/api/v1/admin/source-links/${encodeURIComponent(stream.id)}`, { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'No se pudo actualizar la fuente.');
      const payload = await response.json();
      setManagedStreams((current) => current.map((item) => item.id === stream.id ? { ...item, ...(payload.link || patch) } : item));
    } catch (e: any) {
      setStreamError(e?.message || 'No se pudo actualizar la fuente.');
    } finally {
      setStreamBusy(null);
    }
  };

  const deleteStream = async (stream: any) => {
    if (!window.confirm(`¿Eliminar la fuente de ${stream.source_site || 'este servidor'}?`)) return;
    setStreamBusy(stream.id);
    try {
      const response = await fetch(`/api/v1/admin/source-links/${encodeURIComponent(stream.id)}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'No se pudo eliminar la fuente.');
      setManagedStreams((current) => current.filter((item) => item.id !== stream.id));
    } catch (e: any) {
      setStreamError(e?.message || 'No se pudo eliminar la fuente.');
    } finally {
      setStreamBusy(null);
    }
  };

  const addStream = async () => {
    if (!form.media_item_id || !newStream.source_site.trim() || !newStream.url.trim()) {
      setStreamError('Necesitas una obra canónica, plataforma y URL.');
      return;
    }
    setStreamBusy('new');
    setStreamError(null);
    try {
      const response = await fetch(`/api/v1/admin/media-items/${encodeURIComponent(form.media_item_id)}/streams`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newStream) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'No se pudo añadir la fuente.');
      const payload = await response.json();
      setManagedStreams((current) => [...current, { ...(payload.link || {}), season_number: Number(newStream.season_number) || 1, episode_number: Number(newStream.episode_number) || 1 }]);
      setNewStream((current) => ({ ...current, source_site: '', url: '' }));
    } catch (e: any) {
      setStreamError(e?.message || 'No se pudo añadir la fuente.');
    } finally {
      setStreamBusy(null);
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

  const checkSourceAvailability = async () => {
    // Usa el campo visible primero para poder probar un TMDB recién escrito
    // sin obligar a guardarlo antes en la ficha.
    const tmdbId = Number(String(tmdbInput || form.tmdb_id || '').trim());
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
      setAvailabilityResult(null);
      setAvailabilityError('Añade un TMDB ID válido para comprobar VidSrc.');
      return;
    }
    const rawCategory = String(form.category || form.kind || 'movie').toLowerCase();
    const kind = rawCategory === 'anime' || rawCategory === 'series' ? rawCategory : 'movie';
    const season = Math.max(1, Math.round(Number(availabilitySeason) || 1));
    const episode = Math.max(1, Math.round(Number(availabilityEpisode) || 1));
    setAvailabilityBusy(true);
    setAvailabilityError(null);
    setAvailabilityResult(null);
    try {
      const response = await fetch('/api/v1/admin/source-availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ kind, tmdb_id: tmdbId, season, episode }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'No se pudo comprobar la disponibilidad.');
      setAvailabilityResult(payload);
    } catch (e: any) {
      setAvailabilityError(e?.message || 'No se pudo comprobar la disponibilidad.');
    } finally {
      setAvailabilityBusy(false);
    }
  };

  const forceTmdbMatch = async () => {
    const customTitle = window.prompt('Introduce el título exacto a buscar en TMDB:', form.title);
    if (!customTitle) return;

    setForcingTmdb(true);
    setSavedMsg(null);
    try {
      const res = await fetch(`/api/v1/shows/${show.id}/force-metadata`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: customTitle })
      });
      if (res.ok) {
        const data = await res.json();
        setForm((f: any) => ({ ...f, ...data.updated_show }));
        setSavedMsg('Metadatos forzados desde TMDB con éxito.');
        if (onSaved) onSaved(data.updated_show);
      } else {
        const err = await res.json().catch(() => ({}));
        setSavedMsg(err.detail || err.error || 'Error al forzar metadatos');
      }
    } catch (e: any) {
      setSavedMsg(e?.message || 'Error al forzar metadatos');
    } finally {
      setForcingTmdb(false);
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

        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold text-amber-200">Identidad TMDB</p>
              <p className="mt-1 max-w-xl text-[10px] leading-relaxed text-zinc-500">Asigna el ID manualmente. Si ya pertenece a otra obra, el panel te mostrará el conflicto antes de fusionar. La regeneración de metadatos siempre se confirma aparte.</p>
            </div>
            <span className="rounded-full border border-zinc-700 bg-zinc-950/70 px-2 py-1 text-[10px] font-mono text-zinc-400">Actual: {form.tmdb_id || 'sin ID'}</span>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input type="number" min="1" value={tmdbInput} onChange={(event) => { setTmdbInput(event.target.value); setIdentityConflict(null); setIdentityMsg(null); }} placeholder="Ej. 550" aria-label="TMDB ID manual" className="min-h-10 min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-xs text-white outline-none focus:border-amber-400/60" />
            <button type="button" onClick={() => void applyIdentity()} disabled={identityBusy} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-amber-500/20 px-3 text-xs font-semibold text-amber-100 ring-1 ring-amber-500/30 hover:bg-amber-500/30 disabled:opacity-50"><Globe size={14} />{identityBusy ? 'Comprobando…' : 'Comprobar y aplicar'}</button>
          </div>
          {identityMsg && <p className="mt-2 text-[11px] leading-relaxed text-amber-200">{identityMsg}</p>}
          {hasIdentityReview && <div className={`mt-3 rounded-lg border p-3 ${identitySimilar.length > 0 && identityShows.length === 0 && identityMediaItems.length === 0 ? 'border-amber-500/30 bg-amber-500/10' : 'border-rose-500/30 bg-rose-500/10'}`}><div className="flex items-start gap-2"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" /><div><p className="text-xs font-semibold text-amber-100">{identityShows.length > 0 ? 'Ya existe una obra con ese TMDB ID' : identityMediaItems.length > 0 ? 'Ya existe un registro canónico con ese TMDB ID' : 'Encontré títulos parecidos'}</p><p className="mt-1 text-[10px] leading-relaxed text-amber-100/70">Fusiona solo cuando ambas fichas representan la misma obra. Si no, puedes conservarlas por separado.</p></div></div>{identityShows.length > 0 && <div className="mt-3 space-y-2">{identityShows.map((candidate: any) => <div key={candidate.id} className="flex flex-col gap-2 rounded-lg border border-rose-500/20 bg-zinc-950/50 p-2 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="truncate text-xs font-semibold text-zinc-100">{candidate.title}</p><p className="text-[10px] text-zinc-500">{candidate.category} · {candidate.year || 'año desconocido'}</p></div><button type="button" onClick={() => { if (window.confirm(`¿Fusionar “${candidate.title}” dentro de “${form.title}”?`)) void applyIdentity(candidate.id); }} disabled={identityBusy} className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-rose-500/15 px-3 text-[11px] font-semibold text-rose-100 ring-1 ring-rose-500/30 hover:bg-rose-500/25 disabled:opacity-50"><AlertTriangle size={12} /> Fusionar y aplicar</button></div>)}</div>}{identityMediaItems.length > 0 && <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3"><p className="text-[10px] text-amber-100">Registro canónico detectado: {identityMediaItems[0]?.title || 'sin título'}.</p><button type="button" onClick={() => { if (window.confirm('¿Aplicar el ID conservando este registro canónico?')) void applyIdentity(undefined, true, identitySimilar.length === 0); }} disabled={identityBusy} className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-2 text-[11px] font-bold text-zinc-950 hover:bg-amber-300 disabled:opacity-50"><Globe size={12} /> Aplicar conservando el registro</button></div>}{identitySimilar.length > 0 && <div className="mt-3 space-y-2"><p className="text-[10px] font-semibold uppercase tracking-wider text-amber-200/80">Posibles coincidencias por título</p>{identitySimilar.map((candidate: any) => <div key={candidate.id} className="flex flex-col gap-2 rounded-lg border border-amber-500/20 bg-zinc-950/50 p-2 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="truncate text-xs font-semibold text-zinc-100">{candidate.title}</p><p className="text-[10px] text-zinc-500">{candidate.category} · {candidate.year || 'año desconocido'} · similitud {Math.round(Number(candidate.similarity || 0) * 100)}%</p></div><button type="button" onClick={() => { if (window.confirm(`¿Fusionar “${candidate.title}” dentro de “${form.title}”?`)) void applyIdentity(candidate.id); }} disabled={identityBusy} className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-amber-500/20 px-3 text-[11px] font-semibold text-amber-100 ring-1 ring-amber-500/30 hover:bg-amber-500/30 disabled:opacity-50"><AlertTriangle size={12} /> Fusionar y aplicar</button></div>)}{identityShows.length === 0 && <button type="button" onClick={() => { if (window.confirm('¿Aplicar el ID sin fusionar estas fichas?')) void applyIdentity(undefined, identityMediaItems.length > 0, true); }} disabled={identityBusy} className="inline-flex min-h-9 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">Aplicar sin fusionar</button>}</div>}</div>}
        </div>

        <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-3">
          <div className="flex items-start justify-between gap-3">
            <div><p className="text-xs font-bold text-violet-200">Identificadores de la obra</p><p className="mt-1 text-[10px] leading-relaxed text-zinc-500">Edita cualquier ID que exista en la base. Las búsquedas externas solo preparan una propuesta; nada se guarda hasta que confirmes.</p></div>
            <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-1 text-[10px] text-violet-200">7 fuentes</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['tmdb_id', 'TMDB', 'Número'], ['imdb_id', 'IMDb', 'tt1234567'], ['tvdb_id', 'TVDB', 'Número'],
              ['mal_id', 'MAL', 'Número'], ['anilist_id', 'AniList', 'Número'], ['kitsu_id', 'Kitsu', 'ID'], ['anidb_id', 'AniDB', 'Número'],
            ].map(([key, label, placeholder]) => <label key={key} className="text-[10px] text-zinc-500">{label}<input value={form[key] ?? ''} onChange={(event) => set(key, event.target.value)} placeholder={placeholder} className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-violet-400/60" /></label>)}
          </div>
          <div className="mt-3 rounded-lg border border-dashed border-violet-500/30 bg-zinc-950/40 p-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-200/80">Buscar y completar desde un ID</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-[8rem_1fr_auto]">
              <select value={identitySource} onChange={(event) => setIdentitySource(event.target.value)} className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[11px] text-zinc-200 outline-none"><option value="tmdb">TMDB</option><option value="imdb">IMDb</option><option value="mal">MAL</option><option value="anilist">AniList</option><option value="kitsu">Kitsu</option><option value="anidb">AniDB</option><option value="tvdb">TVDB</option></select>
              <input value={identityLookupValue} onChange={(event) => setIdentityLookupValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void lookupIdentity(); }} placeholder="Pega el identificador y consulta la ficha externa" className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[11px] text-zinc-200 outline-none focus:border-violet-400/60" />
              <button type="button" onClick={() => void lookupIdentity()} disabled={identityLookupBusy} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-violet-500/20 px-3 text-[11px] font-semibold text-violet-100 ring-1 ring-violet-500/30 hover:bg-violet-500/30 disabled:opacity-50">{identityLookupBusy ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Buscar</button>
            </div>
            {identityPreview && <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/70 p-2.5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold text-zinc-100">{identityPreview.title || (identityPreview.found ? 'Coincidencia local' : 'Sin coincidencia externa')}</p><p className="mt-1 text-[10px] text-zinc-500">{identityPreview.found ? 'Revisa los valores propuestos antes de aplicarlos.' : 'Puedes guardar el ID manualmente si es una referencia privada.'}</p></div>{identityPreview.found && <button type="button" onClick={applyIdentityProposal} className="inline-flex min-h-8 items-center gap-1 rounded-md bg-emerald-500/20 px-2.5 text-[10px] font-semibold text-emerald-100 ring-1 ring-emerald-500/30"><CheckCircle2 size={12} /> Aplicar propuesta</button>}</div>{Object.keys(identityPreview.proposed || {}).length > 0 && <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">{Object.entries(identityPreview.proposed).filter(([, value]) => value !== null && value !== undefined && value !== '').map(([key, value]) => <span key={key} className="rounded bg-zinc-900 px-2 py-1 text-[10px] text-zinc-300"><b className="text-violet-200">{key.replace('_id', '').toUpperCase()}</b>: {String(value)}</span>)}</div>}{(identityPreview.conflicts?.shows?.length > 0 || identityPreview.conflicts?.media_items?.length > 0) && <p className="mt-2 text-[10px] text-amber-200">Hay registros locales que comparten uno de estos IDs. Decide la fusión manualmente antes de guardar.</p>}</div>}
          </div>
        </div>

        {/* Plataformas disponibles para ESTE título */}
        <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800">
          <div className="flex items-center gap-2 text-xs font-bold text-zinc-300 mb-2">
            <Globe size={13} className="text-emerald-400" />
            Plataformas donde está disponible
          </div>
          <div className="mb-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-200/80">Comprobación bajo demanda</p>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">Prueba si esta obra responde en VidSrc, sus mirrors y ZokoAnime. No guarda ni modifica fuentes.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select value={availabilityScope} onChange={(event) => setAvailabilityScope(event.target.value as typeof availabilityScope)} className="min-h-9 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-emerald-400/60" aria-label="Proveedores a comprobar">
                  <option value="both">VidSrc + ZokoAnime</option>
                  <option value="vidsrc">Solo VidSrc</option>
                  <option value="zokoanime">Solo ZokoAnime</option>
                </select>
                <button type="button" onClick={() => void checkSourceAvailability()} disabled={availabilityBusy} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-emerald-500/20 px-3 text-[11px] font-semibold text-emerald-100 ring-1 ring-emerald-500/30 hover:bg-emerald-500/30 disabled:opacity-50">
                  {availabilityBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  {availabilityBusy ? 'Probando…' : 'Probar disponibilidad'}
                </button>
              </div>
            </div>
            {form.category !== 'movie' && <div className="mt-2 grid max-w-xs grid-cols-2 gap-2">
              <label className="text-[10px] text-zinc-500">Temporada<input type="number" min="1" value={availabilitySeason} onChange={(event) => setAvailabilitySeason(event.target.value)} className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-emerald-400/60" /></label>
              <label className="text-[10px] text-zinc-500">Episodio<input type="number" min="1" value={availabilityEpisode} onChange={(event) => setAvailabilityEpisode(event.target.value)} className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-emerald-400/60" /></label>
            </div>}
            {availabilityError && <p className="mt-2 rounded-md border border-rose-500/25 bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-200">{availabilityError}</p>}
            {availabilityResult && (() => {
              const providers = (availabilityResult.providers || []).filter((provider: any) => availabilityScope === 'both' || availabilityScope === 'vidsrc' ? provider.provider === 'vidsrc' || provider.provider === 'vidsrcto' : provider.provider === 'zokoanime');
              return <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-zinc-500"><span>Consulta completada en {Number(availabilityResult.elapsed_ms || 0).toLocaleString()} ms</span><span>TMDB {availabilityResult.tmdb_id}</span></div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {providers.map((provider: any) => {
                    const label = provider.provider === 'zokoanime' ? 'ZokoAnime' : provider.provider === 'vidsrcto' ? 'VidSrc.to (mirror)' : 'VidSrc.me';
                    return <div key={provider.provider} className={`rounded-md border px-2.5 py-2 ${provider.available ? 'border-emerald-500/30 bg-emerald-500/10' : provider.checked === 0 ? 'border-zinc-800 bg-zinc-950/40' : 'border-rose-500/25 bg-rose-500/10'}`}>
                      <div className="flex items-center justify-between gap-2"><span className="text-[11px] font-semibold text-zinc-200">{label}</span><span className={`text-[10px] font-semibold ${provider.available ? 'text-emerald-300' : provider.checked === 0 ? 'text-zinc-500' : 'text-rose-300'}`}>{provider.available ? 'Disponible' : provider.checked === 0 ? 'Sin respuesta' : 'No disponible'}</span></div>
                      <p className="mt-1 text-[10px] text-zinc-500">{provider.checked || 0} comprobación{provider.checked === 1 ? '' : 'es'} · {provider.checks?.find((check: any) => check.ok)?.latency_ms || provider.checks?.[0]?.latency_ms || 0} ms</p>
                    </div>;
                  })}
                </div>
              </div>;
            })()}
          </div>
          {form.source ? (
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-[10px] text-zinc-500">Origen del catálogo:</span>
              <span className="text-[10px] px-2 py-0.5 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/20 font-semibold">
                {form.source}
              </span>
            </div>
          ) : null}
          {episodePlatforms && episodePlatforms.length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] text-zinc-500 mb-1">Por episodios extraídos:</div>
              <div className="flex flex-wrap gap-1.5">
                {episodePlatforms.map((p) => (
                  <span key={p.domain} className="text-[10px] px-2 py-0.5 rounded-lg bg-sky-500/10 text-sky-300 border border-sky-500/20 font-semibold">
                    {p.domain} ({p.episodes} {p.episodes === 1 ? 'episodio' : 'episodios'})
                  </span>
                ))}
              </div>
            </div>
          )}
          {platforms === null ? (
            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
              <Loader2 size={12} className="animate-spin" /> Consultando fuentes...
            </div>
          ) : platforms.length === 0 ? (
            <p className="text-[11px] text-zinc-500">Sin fuentes multi-plataforma registradas para este título.</p>
          ) : (
            <div className="space-y-2">
              {platforms.map((p) => {
                const servers = serversByPlatform?.get(p.site);
                return (
                  <div key={p.site} className="rounded-lg bg-zinc-900/60 border border-zinc-800 p-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] px-2 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 font-semibold">
                        {p.site}
                      </span>
                      <span className="text-[10px] text-zinc-500">{p.count} {p.count === 1 ? 'fuente' : 'fuentes'}</span>
                    </div>
                    {servers && servers.size > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5 pl-2">
                        <span className="text-[10px] text-zinc-600 self-center mr-1">Servers:</span>
                        {Array.from(servers.entries()).map(([host, n]) => (
                          <span key={host} className="text-[9px] px-1.5 py-0.5 rounded-md bg-zinc-800/80 text-zinc-300 border border-zinc-700">
                            {host} ({n})
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-rose-500/25 bg-rose-500/5 p-3">
          <div className="flex items-start gap-2"><GitMerge size={15} className="mt-0.5 text-rose-300" /><div><p className="text-xs font-bold text-rose-200">Fusión manual forzada</p><p className="mt-1 text-[10px] leading-relaxed text-zinc-500">Busca otra ficha por título o ID y elige cuál se conserva. La obra seleccionada se absorbe con sus episodios y fuentes.</p></div></div>
          <div className="mt-3 flex gap-2"><input value={mergeQuery} onChange={(event) => setMergeQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchMergeCandidates(); }} placeholder="Título, TMDB, IMDb, MAL…" className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-[11px] text-zinc-200 outline-none focus:border-rose-400/60" /><button type="button" onClick={() => void searchMergeCandidates()} disabled={mergeBusy} className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-rose-500/20 px-3 text-[11px] font-semibold text-rose-100 ring-1 ring-rose-500/30 hover:bg-rose-500/30 disabled:opacity-50">{mergeBusy ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Buscar</button></div>
          {mergeCandidates.length > 0 && <div className="mt-2 space-y-1.5">{mergeCandidates.map((candidate: any) => <div key={candidate.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 py-2"><div className="min-w-0"><p className="truncate text-[11px] font-semibold text-zinc-100">{candidate.title}</p><p className="text-[10px] text-zinc-500">{candidate.category || candidate.kind || 'obra'} · TMDB {candidate.tmdb_id || 'sin ID'} · {candidate.year || 'sin año'}</p></div><button type="button" onClick={() => void forceMerge(candidate)} disabled={mergeBusy} className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md bg-rose-500/20 px-2.5 text-[10px] font-semibold text-rose-100 ring-1 ring-rose-500/30 hover:bg-rose-500/30 disabled:opacity-50"><GitMerge size={12} /> Fusionar aquí</button></div>)}</div>}
        </div>

        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-xs font-bold text-amber-200">Fuentes legacy</p><p className="mt-1 text-[10px] leading-relaxed text-zinc-500">Estas son las URLs antiguas guardadas en los episodios originales. Puedes corregirlas, dejarlas vacías o eliminarlas sin tocar el inventario canónico. Usa “Pasar a canónica” para copiar una página del proveedor a la ruta normal sin borrar esta referencia.</p></div>
            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] font-mono text-amber-200">{legacyEpisodes.length} episodios</span>
          </div>
          {legacyError && <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">{legacyError}</p>}
          <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
            {legacyEpisodes.length === 0 ? <p className="rounded-lg border border-dashed border-zinc-800 px-3 py-5 text-center text-[11px] text-zinc-500">No hay episodios legacy guardados para esta obra.</p> : legacyEpisodes.map((episode: any) => <div key={episode.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5">
              <div className="grid gap-2 sm:grid-cols-[5rem_1fr]">
                <label className="text-[10px] text-zinc-500">Episodio<input type="number" min="0" step="0.1" value={episode.episode_number ?? 0} onChange={(event) => updateLegacyDraft(episode.id, { episode_number: event.target.value })} className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-amber-400/60" /></label>
                <label className="text-[10px] text-zinc-500">Título<input value={episode.title || ''} onChange={(event) => updateLegacyDraft(episode.id, { title: event.target.value })} className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-amber-400/60" /></label>
              </div>
              <label className="mt-2 block text-[10px] text-zinc-500">URL legacy<input value={episode.source_url || ''} onChange={(event) => updateLegacyDraft(episode.id, { source_url: event.target.value })} placeholder="https://…" className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-[10px] text-zinc-300 outline-none focus:border-amber-400/60" /></label>
              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                <label className="text-[10px] text-zinc-500">Proveedor canónico (opcional; se detecta desde la URL)<input value={legacyProviderDrafts[episode.id] || ''} onChange={(event) => setLegacyProviderDrafts((current) => ({ ...current, [episode.id]: event.target.value }))} placeholder="gnula, cinecalidad…" className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-300 outline-none focus:border-sky-400/60" /></label>
                <button type="button" onClick={() => void promoteLegacyEpisode(episode)} disabled={legacyBusy === `promote:${episode.id}`} className="inline-flex min-h-9 items-center justify-center gap-1.5 self-end rounded-md bg-sky-500/20 px-3 py-2 text-[10px] font-semibold text-sky-100 ring-1 ring-sky-500/30 hover:bg-sky-500/30 disabled:opacity-50">{legacyBusy === `promote:${episode.id}` ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />} Pasar a canónica</button>
              </div>
              <div className="mt-2 flex justify-end gap-1.5">
                <button type="button" onClick={() => void deleteLegacyEpisode(episode)} disabled={legacyBusy === episode.id} className="inline-flex min-h-8 items-center gap-1 rounded-md px-2.5 text-[10px] font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-50"><Trash2 size={12} /> Eliminar</button>
                <button type="button" onClick={() => void saveLegacyEpisode(episode)} disabled={legacyBusy === episode.id} className="inline-flex min-h-8 items-center gap-1 rounded-md bg-amber-500/20 px-2.5 text-[10px] font-semibold text-amber-100 ring-1 ring-amber-500/30 hover:bg-amber-500/30 disabled:opacity-50">{legacyBusy === episode.id ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Guardar legacy</button>
              </div>
            </div>)}
          </div>
        </div>

        <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-xs font-bold text-sky-200">Inventario canónico activo</p><p className="mt-1 text-[10px] leading-relaxed text-zinc-500">Estas son las fuentes que usa la ruta normal. En cada fila puedes elegir si sigue la política global, se fuerza a la ruta normal o se deja en legacy.</p></div>
            <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-1 text-[10px] font-mono text-sky-200">{managedStreams.length} fuentes</span>
          </div>
          {streamError && <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">{streamError}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setSelectedSeason('all')} className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${selectedSeason === 'all' ? 'bg-sky-500/25 text-sky-100 ring-1 ring-sky-500/40' : 'bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800'}`}>Todas ({managedStreams.length})</button>
            {seasonNumbers.map((season) => <button type="button" key={season} onClick={() => setSelectedSeason(season)} className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${selectedSeason === season ? 'bg-sky-500/25 text-sky-100 ring-1 ring-sky-500/40' : 'bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800'}`}>Temporada {season} ({managedStreams.filter((stream: any) => (Number(stream.season_number) || 1) === season).length})</button>)}
          </div>
          <div className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
            {managedStreams.length === 0 ? <p className="rounded-lg border border-dashed border-zinc-800 px-3 py-5 text-center text-[11px] text-zinc-500">No hay SourceLinks canónicos visibles para esta obra.</p> : visibleStreams.map((stream: any) => <div key={stream.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5">
              <div className="grid gap-2 sm:grid-cols-[4.5rem_4.5rem_6.5rem_1fr_7rem_7rem]">
                <label className="text-[10px] text-zinc-500">Temporada<input type="number" min="1" value={stream.season_number || 1} onChange={(event) => setManagedStreams((current) => current.map((item) => item.id === stream.id ? { ...item, season_number: event.target.value } : item))} onBlur={() => void updateStream(stream, { season_number: Number(stream.season_number) || 1 })} className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-sky-400/60" /></label>
                <label className="text-[10px] text-zinc-500">Episodio<input type="number" min="0" step="0.1" value={stream.episode_number ?? 1} onChange={(event) => setManagedStreams((current) => current.map((item) => item.id === stream.id ? { ...item, episode_number: event.target.value } : item))} onBlur={() => void updateStream(stream, { episode_number: Number(stream.episode_number) || 0 })} className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-sky-400/60" /></label>
                <label className="text-[10px] text-zinc-500">Plataforma<input value={stream.source_site || ''} onChange={(event) => setManagedStreams((current) => current.map((item) => item.id === stream.id ? { ...item, source_site: event.target.value } : item))} onBlur={() => void updateStream(stream, { source_site: stream.source_site })} className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-sky-400/60" /></label>
                <label className="min-w-0 text-[10px] text-zinc-500">URL / locator<input value={stream.url || ''} onChange={(event) => setManagedStreams((current) => current.map((item) => item.id === stream.id ? { ...item, url: event.target.value } : item))} onBlur={() => void updateStream(stream, { url: stream.url })} className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-[10px] text-zinc-300 outline-none focus:border-sky-400/60" /></label>
                <label className="text-[10px] text-zinc-500">Estado<select value={stream.source_status || 'discovered'} onChange={(event) => { const value = event.target.value; setManagedStreams((current) => current.map((item) => item.id === stream.id ? { ...item, source_status: value } : item)); void updateStream(stream, { source_status: value }); }} className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-sky-400/60"><option value="discovered">Descubierto</option><option value="verified">Verificado</option><option value="failed">Fallido</option><option value="dead">Muerto</option><option value="disabled">Desactivado</option></select></label>
                <label className="text-[10px] text-zinc-500">Ruta<select value={stream.main_path_override === true ? 'main' : stream.main_path_override === false ? 'legacy' : 'global'} onChange={(event) => { const value = event.target.value; const override = value === 'main' ? true : value === 'legacy' ? false : null; setManagedStreams((current) => current.map((item) => item.id === stream.id ? { ...item, main_path_override: override } : item)); void updateStream(stream, { main_path_override: override }); }} className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-sky-400/60"><option value="global">Política global</option><option value="main">Ruta normal</option><option value="legacy">Legacy</option></select></label>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-[10px] text-zinc-500">{stream.language || stream.audio_language || 'idioma no detectado'}{stream.subtitle_language ? ' · subs ' + stream.subtitle_language : ''}{stream.priority_tier != null ? ' · prioridad ' + stream.priority_tier : ''}</span><span className="flex items-center gap-1">{stream.url && /^https?:/i.test(stream.url) && <a href={stream.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-sky-300" title="Abrir locator en otra pestaña"><ExternalLink size={13} /></a>}<button type="button" onClick={() => void deleteStream(stream)} disabled={streamBusy === stream.id} className="rounded-md p-1.5 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-50" title="Eliminar fuente"><Trash2 size={13} /></button>{streamBusy === stream.id && <Loader2 size={12} className="animate-spin text-sky-300" />}</span></div>
            </div>)}
          </div>
          <div className="mt-3 rounded-lg border border-dashed border-zinc-700 bg-zinc-950/40 p-2.5"><p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Añadir fuente manual</p><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><input value={newStream.season_number} onChange={(event) => setNewStream((current) => ({ ...current, season_number: event.target.value }))} placeholder="Temporada" className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[11px] text-zinc-200 outline-none" /><input value={newStream.episode_number} onChange={(event) => setNewStream((current) => ({ ...current, episode_number: event.target.value }))} placeholder="Episodio" className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[11px] text-zinc-200 outline-none" /><input value={newStream.source_site} onChange={(event) => setNewStream((current) => ({ ...current, source_site: event.target.value }))} placeholder="Plataforma (cinecalidad…)" className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[11px] text-zinc-200 outline-none" /><input value={newStream.url} onChange={(event) => setNewStream((current) => ({ ...current, url: event.target.value }))} placeholder="URL estable del resolver" className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[11px] text-zinc-200 outline-none sm:col-span-2 lg:col-span-3" /><button type="button" onClick={() => void addStream()} disabled={streamBusy === 'new'} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-sky-500/20 px-3 text-[11px] font-semibold text-sky-100 ring-1 ring-sky-500/30 hover:bg-sky-500/30 disabled:opacity-50">{streamBusy === 'new' ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Añadir</button></div></div>
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
          <button
            type="button"
            onClick={forceTmdbMatch}
            disabled={forcingTmdb}
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
            title="Fuerza la coincidencia y relleno de metadatos usando un título específico para TMDB"
          >
            <Globe size={13} className={forcingTmdb ? 'animate-spin' : ''} />
            {forcingTmdb ? 'Buscando...' : 'Forzar TMDB Match'}
          </button>
          {savedMsg && <span className="text-[11px] text-emerald-400">{savedMsg}</span>}
          {refreshMsg && <span className="text-[11px] text-sky-400">{refreshMsg}</span>}
        </div>
      </div>
    </div>
  );
};

export default ShowEditModal;
