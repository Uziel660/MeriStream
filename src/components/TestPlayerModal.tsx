// src/components/TestPlayerModal.tsx
// Reproductor dedicado de pruebas externas aislado del player principal.
// Carga y resuelve streams en NUESTRO REPRODUCTOR INTERNO (HLSPlayerModal).

import { useState } from 'react';
import { X, Play, FlaskConical, Loader2 } from 'lucide-react';
import { HLSPlayerModal } from './HLSPlayerModal';
import { api } from '../api/client';
import { proxiedStreamUrl, proxiedImageUrl } from '../utils/proxiedUrl';
import type { RankedStream } from '../types';

interface TestPlayerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TestPlayerModal({ isOpen, onClose }: TestPlayerModalProps) {
  const [activeTab, setActiveTab] = useState<'zoko' | 'anipulse' | 'github_tio' | 'backend_tio'>('zoko');

  // State ZokoAnime
  const [zokoSource, setZokoSource] = useState<'mal' | 'anilist'>('mal');
  const [zokoId, setZokoId] = useState('21'); // Default: One Piece
  const [zokoEp, setZokoEp] = useState(1);
  const [zokoTrack, setZokoTrack] = useState<'sub' | 'dub'>('sub');

  // State AniPulse / HiAnime
  const [aniPulseId, setAniPulseId] = useState('frieren-beyond-journeys-end-18542?ep=107257');

  // State TioAnime (GitHub / Backend)
  const [tioSlug, setTioSlug] = useState('one-piece-1');

  // Player State
  const [loading, setLoading] = useState(false);
  const [playerData, setPlayerData] = useState<{
    title: string;
    streamUrl: string;
    all_streams?: string[];
    ranked_streams?: RankedStream[];
  } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  if (!isOpen) return null;

  const logMessage = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${time}] ${msg}`, ...prev.slice(0, 19)]);
  };

  const handleTestZoko = () => {
    if (!zokoId.trim()) return;
    const url = `https://zokoanime.video/stream/${zokoSource}/${zokoId.trim()}/${zokoEp}/${zokoTrack}?color=35d5bf`;
    logMessage(`[ZokoAnime API] Preparando locator para resolución JIT: ${url}`);
    setPlayerData({
      title: `ZokoAnime — Ep.${zokoEp} (${zokoSource.toUpperCase()} ID ${zokoId})`,
      streamUrl: url,
      all_streams: [url],
      ranked_streams: [
        {
          url,
          type: 'embed',
          tier: 1,
          host: 'zokoanime.video',
          provider: 'ZokoAnime (Embed API)',
          source_site: 'ZOKOANIME',
        },
      ],
    });
  };

  const handleTestAniPulse = async () => {
    if (!aniPulseId.trim()) return;
    const raw = aniPulseId.trim();
    const match = raw.match(/ep=(\d+)/);
    const epId = match ? match[1] : raw.replace(/\D/g, '') || '107257';

    const s1 = `https://megaplay.buzz/stream/s-2/${epId}/sub`;
    setLoading(true);
    logMessage(`[AniPulse API] Solicitando resolución JIT Megaplay a stream .m3u8 nativo para epId: ${epId}...`);

    try {
      const res = await api.resolveEmbed(s1);
      if (res.resolved && res.url && res.type === 'direct') {
        const playUrl = proxiedStreamUrl(res.url, `AniPulse Ep ${epId}`, 'Megaplay');
        const hasSpanishDefault = (res.subtitles || []).some(
          (t: any) =>
            (t.language || t.lang || '').toLowerCase().startsWith('es') ||
            (t.label || '').toLowerCase().includes('spanish') ||
            (t.label || '').toLowerCase().includes('español')
        );

        const formattedSubs = (res.subtitles || []).map((track: any, index: number) => {
          const isSpanish =
            (track.language || track.lang || '').toLowerCase().startsWith('es') ||
            (track.label || '').toLowerCase().includes('spanish') ||
            (track.label || '').toLowerCase().includes('español');
          const isDefault = hasSpanishDefault ? isSpanish : track.is_default || track.default || index === 0;
          return {
            id: track.id || `sub-${index}`,
            label: track.label || track.lang || `Subtítulo ${index + 1}`,
            language: track.language || track.lang || 'es',
            url: proxiedImageUrl(track.src || track.url),
            is_default: isDefault,
          };
        });

        logMessage(`[AniPulse API] ¡Éxito! Stream .m3u8 proxificado HLS: ${playUrl.slice(0, 60)}...`);
        logMessage(`[AniPulse API] Subtítulos en español cargados (${formattedSubs.length} pistas)`);

        setPlayerData({
          title: `AniPulse AnimeAPI — Episode ${epId}`,
          streamUrl: playUrl,
          all_streams: [playUrl],
          ranked_streams: [
            {
              url: playUrl,
              original_url: s1,
              canonical_locator: s1,
              type: 'direct',
              tier: 1,
              host: 'imgnex.top',
              provider: 'AniPulse Megaplay (HLS Nativo HD)',
              source_site: 'ANIPULSE',
              delivery_mode: 'direct_trial',
              is_proxyable: true,
              requiredHeaders: res.requiredHeaders,
              subtitles: formattedSubs as any,
            } as any,
          ],
        });
      } else {
        logMessage(`[AniPulse API] No se pudo extraer .m3u8 nativo; conservando locator para failover`);
        setPlayerData({
          title: `AniPulse AnimeAPI — Episode ${epId}`,
          streamUrl: s1,
          all_streams: [s1],
          ranked_streams: [
            {
              url: s1,
              type: 'embed',
              tier: 1,
              host: 'megaplay.buzz',
              provider: 'AniPulse Megaplay (Embed)',
              source_site: 'ANIPULSE',
            },
          ],
        });
      }
    } catch (err: any) {
      logMessage(`[AniPulse API] Error en resolución: ${err?.message || 'Error de conexión'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleTestGithubTio = async () => {
    if (!tioSlug.trim()) return;
    const clean = tioSlug.trim();
    const targetUrl = clean.startsWith('http') ? clean : `https://tioanime.com/ver/${clean}`;
    setLoading(true);
    logMessage(`[GitHub carlosfdezb/tioanime] Leyendo var videos de: ${targetUrl}`);

    try {
      const res = await api.getEpisodeServers(targetUrl);
      const allExtracted = res.all_available_streams || [targetUrl];
      logMessage(`[GitHub Scraper] Extraídos ${allExtracted.length} enlaces crudos de var videos`);

      const rawRanked: RankedStream[] = allExtracted.map((url, idx) => ({
        url,
        type: 'embed',
        tier: idx + 1,
        host: url.includes('mega.nz') ? 'mega.nz' : url.includes('yourupload') ? 'yourupload.com' : 'tioanime.com',
        provider: `GitHub Raw Embed ${idx + 1}`,
        source_site: 'TIOANIME_GITHUB',
      }));

      setPlayerData({
        title: `GitHub carlosfdezb/tioanime — ${clean}`,
        streamUrl: rawRanked[0]?.url || targetUrl,
        all_streams: allExtracted,
        ranked_streams: rawRanked,
      });
    } catch (err: any) {
      logMessage(`[GitHub Scraper] Error al obtener HTML: ${err?.message || 'Error de conexión'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleTestBackendTio = async () => {
    if (!tioSlug.trim()) return;
    const clean = tioSlug.trim();
    const targetUrl = clean.startsWith('http') ? clean : `https://tioanime.com/ver/${clean}`;
    setLoading(true);
    logMessage(`[MeriStream Backend JIT] Iniciando pipeline TioAnimeAdapter + MediaValidator para: ${targetUrl}`);

    try {
      const res = await api.getEpisodeServers(targetUrl);
      const ranked = (res.ranked_streams || []) as RankedStream[];
      logMessage(`[MeriStream Backend] Procesados ${ranked.length} servidores optimizados (HLS Nativo + Proxy + Locator de respaldo)`);

      setPlayerData({
        title: `MeriStream TioAnimeAdapter — ${clean}`,
        streamUrl: res.stream_url || targetUrl,
        all_streams: res.all_available_streams || [targetUrl],
        ranked_streams: ranked,
      });
    } catch (err: any) {
      logMessage(`[MeriStream Backend] Error en resolución JIT: ${err?.message || 'Error de conexión'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4 backdrop-blur-md animate-in fade-in duration-200">
        <div className="flex flex-col w-full max-w-4xl bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl space-y-0">
          {/* HEADER */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 bg-zinc-900/60">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-5 w-5 text-sky-400" />
              <h3 className="text-sm font-bold text-white tracking-wide">
                Probador Aislado con Nuestro Reproductor Interno
              </h3>
              <span className="text-[10px] bg-sky-500/20 text-sky-300 font-mono font-bold px-2 py-0.5 rounded">
                INTERNAL PLAYER ENGINE
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
            >
              <X size={18} />
            </button>
          </div>

          {/* CONTROLES Y PESTAÑAS */}
          <div className="p-4 border-b border-zinc-800 bg-zinc-900/30 space-y-4">
            <div className="flex items-center gap-2 border-b border-zinc-800/80 pb-2 overflow-x-auto">
              <button
                type="button"
                onClick={() => setActiveTab('zoko')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition shrink-0 ${
                  activeTab === 'zoko' ? 'bg-sky-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'
                }`}
              >
                1. ZokoAnime (MAL/AniList ID)
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('anipulse')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition shrink-0 ${
                  activeTab === 'anipulse' ? 'bg-sky-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'
                }`}
              >
                2. AniPulse API (Episode ID)
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('github_tio')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition shrink-0 ${
                  activeTab === 'github_tio' ? 'bg-sky-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'
                }`}
              >
                3. GitHub Scraper (carlosfdezb)
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('backend_tio')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition shrink-0 ${
                  activeTab === 'backend_tio' ? 'bg-sky-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'
                }`}
              >
                4. MeriStream TioAnime (Backend JIT)
              </button>
            </div>

            {/* FORMULARIO SEGÚN LA PESTAÑA */}
            {activeTab === 'zoko' && (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <select
                  value={zokoSource}
                  onChange={(e) => setZokoSource(e.target.value as any)}
                  className="bg-zinc-900 border border-zinc-700 text-white rounded-lg px-3 py-2"
                >
                  <option value="mal">MAL (MyAnimeList)</option>
                  <option value="anilist">AniList</option>
                </select>
                <input
                  type="text"
                  placeholder="MAL/AniList ID (ej: 21)"
                  value={zokoId}
                  onChange={(e) => setZokoId(e.target.value)}
                  className="bg-zinc-900 border border-zinc-700 text-white rounded-lg px-3 py-2 w-32 font-mono"
                />
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-400 text-xs">Ep:</span>
                  <input
                    type="number"
                    min={1}
                    value={zokoEp}
                    onChange={(e) => setZokoEp(Number(e.target.value) || 1)}
                    className="bg-zinc-900 border border-zinc-700 text-white rounded-lg px-2.5 py-2 w-20"
                  />
                </div>
                <select
                  value={zokoTrack}
                  onChange={(e) => setZokoTrack(e.target.value as any)}
                  className="bg-zinc-900 border border-zinc-700 text-white rounded-lg px-3 py-2"
                >
                  <option value="sub">Subtítulos (SUB)</option>
                  <option value="dub">Doblado (DUB)</option>
                </select>
                <button
                  type="button"
                  onClick={handleTestZoko}
                  className="flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 rounded-lg font-semibold transition"
                >
                  <Play size={14} className="fill-current" /> Abrir en Nuestro Reproductor
                </button>
              </div>
            )}

            {activeTab === 'anipulse' && (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <input
                  type="text"
                  placeholder="ID o Slug del episodio (ej: frieren-beyond-journeys-end-18542?ep=107257)"
                  value={aniPulseId}
                  onChange={(e) => setAniPulseId(e.target.value)}
                  className="flex-1 bg-zinc-900 border border-zinc-700 text-white rounded-lg px-3 py-2 font-mono"
                />
                <button
                  type="button"
                  onClick={handleTestAniPulse}
                  className="flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 rounded-lg font-semibold transition"
                >
                  <Play size={14} className="fill-current" /> Abrir en Nuestro Reproductor
                </button>
              </div>
            )}

            {(activeTab === 'github_tio' || activeTab === 'backend_tio') && (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <input
                  type="text"
                  placeholder="Slug o URL del episodio (ej: one-piece-1)"
                  value={tioSlug}
                  onChange={(e) => setTioSlug(e.target.value)}
                  className="flex-1 bg-zinc-900 border border-zinc-700 text-white rounded-lg px-3 py-2 font-mono"
                />
                <button
                  type="button"
                  disabled={loading}
                  onClick={activeTab === 'github_tio' ? handleTestGithubTio : handleTestBackendTio}
                  className="flex items-center gap-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-semibold transition"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} className="fill-current" />}
                  {loading ? 'Resolviendo con Backend...' : 'Abrir en Nuestro Reproductor'}
                </button>
              </div>
            )}
          </div>

          {/* CONSOLA DE AUDITORÍA Y LOGS */}
          <div className="p-4 bg-zinc-950 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                Consola de Auditoría y Eventos
              </span>
              <span className="text-[10px] text-emerald-400 font-mono">
                {logs.length > 0 ? `${logs.length} eventos` : 'Listo'}
              </span>
            </div>
            <div className="bg-black/80 rounded-xl border border-zinc-800/80 p-3 font-mono text-xs text-zinc-300 max-h-48 overflow-y-auto space-y-1">
              {logs.length === 0 ? (
                <p className="text-zinc-600 italic">Haz clic en "Abrir en Nuestro Reproductor" para iniciar una prueba...</p>
              ) : (
                logs.map((log, i) => (
                  <p key={i} className="text-emerald-400/90 break-all leading-relaxed">
                    {log}
                  </p>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* MONTAJE DE NUESTRO REPRODUCTOR INTERNO (HLSPLAYERMODAL) */}
      {playerData && (
        <HLSPlayerModal
          isOpen={Boolean(playerData)}
          onClose={() => setPlayerData(null)}
          title={playerData.title}
          streamUrl={playerData.streamUrl}
          all_streams={playerData.all_streams}
          ranked_streams={playerData.ranked_streams}
        />
      )}
    </>
  );
}
