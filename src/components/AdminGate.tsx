// src/components/AdminGate.tsx
// Entrada exclusiva del panel de administración en /admin.
// El backend mantiene la sesión en una cookie HttpOnly; el cliente solo consulta su estado.

import React, { useEffect, useState } from 'react';
import { Shield, Loader2 } from 'lucide-react';
import { AdminPanel } from './AdminPanel';
import { HLSPlayerModal } from './HLSPlayerModal';
import { api, getAuthToken } from '../api/client';
import { isEmbedUrl, isRawWebpageUrl } from '../utils/streamOptimizer';
import type { RankedStream, Show } from '../types';

interface AdminPlayerData {
  title: string;
  streamUrl: string;
  all_streams: string[];
  ranked_streams?: RankedStream[];
  showId?: string;
  showTitle?: string;
  tmdbId?: number | null;
  kind?: string | null;
  episodeId?: string;
  episodeNumber?: number | null;
  episodeTitle?: string;
  isLoading?: boolean;
  loadError?: string;
}

const isNativeMediaUrl = (value: string): boolean =>
  /\.(?:m3u8|mpd|mp4|webm|mkv)(?:[?#]|$)/i.test(value);

function adminKind(show: Partial<Show>): 'movie' | 'series' | 'anime' {
  const value = String(show.kind || show.category || '').toLowerCase();
  if (value.includes('anime')) return 'anime';
  if (value.includes('movie') || value.includes('pel')) return 'movie';
  return 'series';
}

function vidsrcLocator(kind: 'movie' | 'series' | 'anime', tmdbId: number, season = 1, episode = 1): string {
  return kind === 'movie'
    ? `https://vidsrc.me/embed/movie/${tmdbId}`
    : `https://vidsrc.me/embed/tv/${tmdbId}/${season}/${episode}`;
}

export const AdminGate: React.FC = () => {
  const [authed, setAuthed] = useState(false);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [playerData, setPlayerData] = useState<AdminPlayerData | null>(null);

  useEffect(() => {
    const checkSession = async () => {
      try {
        const res = await fetch('/api/v1/admin/session', { credentials: 'same-origin' });
        if (res.ok) {
          setAuthed(true);
          return;
        }
        const token = getAuthToken();
        if (token) {
          const userSession = await fetch('/api/v1/admin/user-session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'same-origin',
          });
          if (userSession.ok) {
            setAuthed(true);
            return;
          }
        }
        if (res.status === 503) setError('La administración no está configurada en el servidor.');
      } catch {
        setError('No se pudo conectar con el servidor');
      } finally {
        setCheckingSession(false);
      }
    };
    void checkSession();
  }, []);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ user, password: pass }),
      });
      if (res.ok) {
        setAuthed(true);
      } else if (res.status === 503) {
        setError('La administración no está configurada en el servidor.');
      } else {
        setError('Usuario o contraseña incorrectos');
      }
    } catch {
      setError('No se pudo conectar con el servidor');
    } finally {
      setChecking(false);
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/v1/admin/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      setAuthed(false);
      window.location.href = '/';
    }
  };

  /**
   * El panel /admin se monta fuera de App, así que antes solo abría la URL
   * cruda en una pestaña nueva y no montaba HLSPlayerModal. Resolvemos aquí las
   * páginas de proveedor y entregamos el resultado al mismo reproductor
   * interno que usa el catálogo público.
   */
  const resolveAdminStream = async (streamResult: any): Promise<AdminPlayerData> => {
    const title = String(streamResult?.title || 'Prueba de reproducción');
    const ranked = Array.isArray(streamResult?.ranked_streams)
      ? streamResult.ranked_streams as RankedStream[]
      : undefined;
    const candidates = Array.from(new Set([
      streamResult?.stream_url,
      ...(Array.isArray(streamResult?.all_streams) ? streamResult.all_streams : []),
      ...(Array.isArray(streamResult?.all_available_streams) ? streamResult.all_available_streams : []),
      ...(ranked || []).map((source) => source?.url),
    ].map((value) => String(value || '').trim()).filter(Boolean)));
    const playable = candidates.filter((url) => isNativeMediaUrl(url) || isEmbedUrl(url));
    const target = playable[0] || candidates[0];
    if (!target) throw new Error('No se encontró una fuente para reproducir.');

    if (!ranked?.length && playable.length === 0 && isRawWebpageUrl(target)) {
      const resolved = await api.getEpisodeServers(target);
      const resolvedRanked = Array.isArray(resolved?.ranked_streams)
        ? resolved.ranked_streams as RankedStream[]
        : undefined;
      const resolvedCandidates = Array.from(new Set([
        resolved?.stream_url,
        ...(Array.isArray(resolved?.all_available_streams) ? resolved.all_available_streams : []),
      ].map((value) => String(value || '').trim()).filter(Boolean)));
      if (!resolvedCandidates.length && !resolvedRanked?.length) {
        const fallbackUrl = String(streamResult?.fallback_url || '').trim();
        if (fallbackUrl && fallbackUrl !== target) {
          return resolveAdminStream({
            ...streamResult,
            stream_url: fallbackUrl,
            all_available_streams: [fallbackUrl],
            ranked_streams: undefined,
            fallback_url: undefined,
          });
        }
        throw new Error('El proveedor no devolvió servidores reproducibles.');
      }
      return {
        title,
        streamUrl: resolvedCandidates[0] || resolvedRanked?.[0]?.url || target,
        all_streams: resolvedCandidates.length > 0 ? resolvedCandidates : [target],
        ranked_streams: resolvedRanked,
        showId: streamResult?.showId,
        showTitle: streamResult?.showTitle,
        tmdbId: streamResult?.tmdbId ?? null,
        kind: streamResult?.kind ?? null,
        episodeId: streamResult?.episodeId,
        episodeNumber: streamResult?.episodeNumber ?? null,
        episodeTitle: streamResult?.episodeTitle,
      };
    }

    return {
      title,
      streamUrl: target,
      all_streams: candidates.length > 0 ? candidates : [target],
      ranked_streams: ranked,
      showId: streamResult?.showId,
      showTitle: streamResult?.showTitle,
      tmdbId: streamResult?.tmdbId ?? null,
      kind: streamResult?.kind ?? null,
      episodeId: streamResult?.episodeId,
      episodeNumber: streamResult?.episodeNumber ?? null,
      episodeTitle: streamResult?.episodeTitle,
    };
  };

  const playAdminStream = async (streamResult: any) => {
    const title = String(streamResult?.title || 'Prueba de reproducción');
    setPlayerData({
      title,
      streamUrl: '',
      all_streams: [],
      showId: streamResult?.showId,
      showTitle: streamResult?.showTitle,
      tmdbId: streamResult?.tmdbId ?? null,
      kind: streamResult?.kind ?? null,
      episodeId: streamResult?.episodeId,
      episodeNumber: streamResult?.episodeNumber ?? null,
      episodeTitle: streamResult?.episodeTitle,
      isLoading: true,
    });
    try {
      const resolved = await resolveAdminStream(streamResult);
      setPlayerData((previous) => previous ? { ...previous, ...resolved, isLoading: false, loadError: undefined } : null);
    } catch (streamError: any) {
      setPlayerData((previous) => previous
        ? { ...previous, isLoading: false, loadError: streamError?.message || 'No se pudo resolver la fuente.' }
        : null);
    }
  };

  const playAdminShow = async (show: Show) => {
    const kind = adminKind(show);
    const tmdbId = Number(show.tmdb_id || 0) || null;
    const initialTitle = show.title || 'Obra';
    // Abrir el reproductor de inmediato. El detalle administrativo puede
    // tardar cuando la base está ocupada y no debe dejar el botón sin respuesta.
    setPlayerData({
      title: initialTitle,
      streamUrl: '',
      all_streams: [],
      showId: show.id,
      showTitle: initialTitle,
      tmdbId,
      kind,
      isLoading: true,
    });
    let detail: any = null;
    let detailTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      detailTimer = setTimeout(() => controller.abort(), 8_000);
      const response = await fetch(`/api/v1/shows/${encodeURIComponent(show.id)}`, { signal: controller.signal });
      if (response.ok) detail = await response.json();
    } catch {
      // Si el detalle local no responde, una ficha con TMDB aún puede usar VidSrc.
    } finally {
      if (detailTimer) clearTimeout(detailTimer);
    }

    const episode = detail?.episodes?.[0] || show.episodes?.[0] || null;
    const season = Number(episode?.season_number || 1) || 1;
    const episodeNumber = Number(episode?.episode_number || 1) || 1;
    const sourceUrl = String(episode?.source_url || '').trim();
    const targetUrl = sourceUrl || (tmdbId ? vidsrcLocator(kind, tmdbId, season, episodeNumber) : '');
    if (!targetUrl) {
      setPlayerData({
        title: initialTitle,
        streamUrl: '',
        all_streams: [],
        isLoading: false,
        loadError: 'Esta obra todavía no tiene un episodio o un identificador reproducible.',
      });
      return;
    }

    await playAdminStream({
      title: `${initialTitle}${episode ? ` - ${episode.title || `Episodio ${episodeNumber}`}` : ''}`,
      stream_url: targetUrl,
      all_available_streams: [targetUrl],
      fallback_url: tmdbId ? vidsrcLocator(kind, tmdbId, season, episodeNumber) : undefined,
      showId: show.id,
      showTitle: initialTitle,
      tmdbId,
      kind,
      episodeId: episode?.id,
      episodeNumber,
      episodeTitle: episode?.title || `Episodio ${episodeNumber}`,
    });
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4 text-xs text-zinc-400">
        <Loader2 size={16} className="mr-2 animate-spin" /> Verificando sesión administrativa…
      </div>
    );
  }

  if (authed) {
    return <>
      <AdminPanel
        isOpen={true}
        onClose={() => {
          void logout();
        }}
        onPlayDirect={(streamResult: any) => { void playAdminStream(streamResult); }}
        onPlayShow={(show: Show) => { void playAdminShow(show); }}
        initialShowId={new URLSearchParams(window.location.search).get('show_id')}
        initialTmdbId={new URLSearchParams(window.location.search).get('tmdb_id')}
        initialKind={new URLSearchParams(window.location.search).get('kind')}
        initialTitle={new URLSearchParams(window.location.search).get('title')}
      />
      {playerData && (
        <HLSPlayerModal
          isOpen={true}
          onClose={() => setPlayerData(null)}
          title={playerData.title}
          streamUrl={playerData.streamUrl}
          all_streams={playerData.all_streams}
          ranked_streams={playerData.ranked_streams}
          showId={playerData.showId}
          tmdbId={playerData.tmdbId}
          kind={playerData.kind}
          episodeId={playerData.episodeId}
          episodeNumber={playerData.episodeNumber}
          isLoading={playerData.isLoading}
          loadError={playerData.loadError}
        />
      )}
    </>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <form
        onSubmit={login}
        className="admin-login-card w-full max-w-sm p-6 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl space-y-4"
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <Shield size={18} />
          </div>
          <div>
            <h1 className="text-sm font-bold text-white">MeriStream · Admin</h1>
            <p className="text-[11px] text-zinc-500">Acceso restringido</p>
          </div>
        </div>

        <div>
          <label htmlFor="admin-user" className="text-xs font-semibold text-zinc-300 block mb-1">Usuario</label>
          <input
            id="admin-user"
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoComplete="username"
            autoFocus
            className="admin-login-input w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
          />
        </div>
        <div>
          <label htmlFor="admin-password" className="text-xs font-semibold text-zinc-300 block mb-1">Contraseña</label>
          <input
            id="admin-password"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete="current-password"
            className="admin-login-input w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
          />
        </div>

        {error && <p className="text-[11px] text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={checking || !user || !pass}
          className="admin-login-submit w-full px-3 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-950 text-xs font-bold flex items-center justify-center gap-2 transition-colors"
        >
          {checking && <Loader2 size={13} className="animate-spin" />}
          Entrar
        </button>
      </form>
    </div>
  );
};
