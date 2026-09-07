// src/components/PlyrPlayerModal.tsx
import { useEffect, useRef, useState, useMemo } from 'react';
import Hls from 'hls.js';
import Plyr from 'plyr';
import 'plyr/dist/plyr.css';
import {
  X,
  Server,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
  Sparkles,
} from 'lucide-react';
import {
  rankAndSortServers,
  type ScoredServer,
} from '../utils/streamOptimizer';

export interface PlyrPlayerMedia {
  id?: string;
  title?: string;
  stream_url?: string;
  all_streams?: string[];
  all_available_streams?: string[];
  sources?: {
    master_m3u8?: string;
    fallback_mp4?: string;
    qualities?: { url: string }[];
  };
}

export interface PlyrPlayerModalProps {
  isOpen?: boolean;
  media?: PlyrPlayerMedia;
  onClose: () => void;
  directSource?: { url: string; protocol: any } | null;
  title?: string;
  streamUrl?: string;
  all_streams?: string[];
  initialTime?: number;
  onProgressUpdate?: (currentTime: number, duration: number) => void;
  [key: string]: any;
}

export function PlyrPlayerModal(props: PlyrPlayerModalProps) {
  const { media, onClose, directSource = null } = props;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const plyrRef = useRef<Plyr | null>(null);
  const lastUpdateRef = useRef<number>(0);

  // Servidores y Estado
  const [servers, setServers] = useState<ScoredServer[]>([]);
  const [activeServerIndex, setActiveServerIndex] = useState<number>(0);
  const [showServerMenu, setShowServerMenu] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const displayTitle =
    props.title ||
    media?.title ||
    props.item?.title ||
    props.result?.title ||
    'Reproduciendo Video';

  // 1. RECOPILACIÓN Y AUTO-ORDENAMIENTO DE SERVIDORES
  useEffect(() => {
    setIsLoading(true);
    setLoadError(null);

    const rawDirect = directSource?.url || props.streamUrl || props.src || media?.stream_url;
    const allCandidateUrls: string[] = Array.from(
      new Set(
        [
          rawDirect,
          ...(props.all_streams || []),
          ...(props.sources?.map((s: any) => (typeof s === 'string' ? s : s?.url)) || []),
          ...(media?.all_streams || []),
          ...(media?.all_available_streams || []),
          media?.sources?.master_m3u8,
          media?.sources?.fallback_mp4,
          ...(media?.sources?.qualities?.map((q: { url: string }) => q.url) || []),
        ].filter(Boolean)
      )
    );

    if (allCandidateUrls.length === 0) {
      setLoadError('No se encontraron fuentes de video disponibles para reproducir.');
      setIsLoading(false);
      return;
    }

    const scored = rankAndSortServers(allCandidateUrls);
    setServers(scored);
    setActiveServerIndex(0);
    setIsLoading(false);
  }, [props.streamUrl, props.all_streams, directSource?.url, media?.stream_url]);

  const activeServer = useMemo(() => {
    if (servers.length === 0) return null;
    return servers[activeServerIndex] || servers[0];
  }, [servers, activeServerIndex]);

  // Manejo de cierre sincronizado con progreso
  const handleClose = () => {
    if (videoRef.current && props.onProgressUpdate) {
      props.onProgressUpdate(videoRef.current.currentTime, videoRef.current.duration || 0);
    }
    onClose();
  };

  // 2. ATAJOS DE TECLADO
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // 3. INICIALIZACIÓN DE HLS.JS + PLYR
  useEffect(() => {
    if (!activeServer || activeServer.isEmbed || !videoRef.current) {
      // Destruir instancias previas si el candidato es un locator no nativo
      if (plyrRef.current) {
        plyrRef.current.destroy();
        plyrRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      return;
    }

    const video = videoRef.current;
    let url = activeServer.url;

    // Destruir instancias anteriores antes de re-inicializar
    if (plyrRef.current) {
      plyrRef.current.destroy();
      plyrRef.current = null;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const setupPlyr = (availableQualities: number[] = []) => {
      const plyrOptions: Plyr.Options = {
        controls: [
          'play-large',
          'restart',
          'rewind',
          'play',
          'fast-forward',
          'progress',
          'current-time',
          'duration',
          'mute',
          'volume',
          'captions',
          'settings',
          'pip',
          'airplay',
          'fullscreen',
        ],
        settings: ['captions', 'quality', 'speed'],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
        tooltips: { controls: true, seek: true },
        keyboard: { focused: true, global: true },
        blankVideo: 'https://cdn.plyr.io/static/blank.mp4',
      };

      if (availableQualities.length > 0) {
        plyrOptions.quality = {
          default: availableQualities[0],
          options: availableQualities,
          forced: true,
          onChange: (newQuality: number) => {
            if (hlsRef.current) {
              hlsRef.current.levels.forEach((level, levelIndex) => {
                if (level.height === newQuality) {
                  hlsRef.current!.currentLevel = levelIndex;
                }
              });
            }
          },
        };
      }

      const player = new Plyr(video, plyrOptions);
      plyrRef.current = player;

      // Eventos de progreso para "Seguir Viendo"
      player.on('timeupdate', () => {
        const now = Date.now();
        if (props.onProgressUpdate && now - lastUpdateRef.current > 5000) {
          props.onProgressUpdate(player.currentTime, player.duration || 0);
          lastUpdateRef.current = now;
        }
      });

      player.on('pause', () => {
        if (props.onProgressUpdate) {
          props.onProgressUpdate(player.currentTime, player.duration || 0);
        }
      });

      // Restaurar tiempo inicial si existe
      if (props.initialTime && props.initialTime > 0) {
        player.once('canplay', () => {
          if (props.initialTime && props.initialTime > 0) {
            player.currentTime = props.initialTime;
          }
        });
      }
    };

    if (Hls.isSupported() && (url.includes('.m3u8') || url.includes('/m3u8/'))) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });
      hlsRef.current = hls;

      hls.loadSource(url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        const availableQualities = Array.from(
          new Set(data.levels.map((l) => l.height).filter((h) => Boolean(h) && h > 0))
        ).sort((a, b) => b - a);

        setupPlyr(availableQualities);
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              // Intentar proxy inverso ante error de CORS o Red
              if (!url.includes('/api/v1/proxy/stream')) {
                const proxyUrl = `/api/v1/proxy/stream?url=${encodeURIComponent(activeServer.url)}`;
                hls.loadSource(proxyUrl);
                hls.startLoad();
              } else {
                hls.destroy();
                // Probar siguiente servidor
                if (activeServerIndex < servers.length - 1) {
                  setActiveServerIndex((prev) => prev + 1);
                } else {
                  setLoadError('No se pudo reproducir con los servidores HLS actuales.');
                }
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Soporte nativo HLS (Safari)
      video.src = url;
      setupPlyr();
    } else {
      // Archivo de video estándar (MP4, WebM)
      video.src = url;
      setupPlyr();
    }

    return () => {
      if (plyrRef.current) {
        plyrRef.current.destroy();
        plyrRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [activeServer, activeServerIndex]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[9999] flex flex-col bg-black/95 backdrop-blur-xl text-white select-none animate-in fade-in duration-200"
    >
      {/* BARRA SUPERIOR ELEGANTE */}
      <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/90 via-black/60 to-transparent z-50">
        <div className="flex items-center gap-3 max-w-[70%] truncate">
          <button
            type="button"
            onClick={handleClose}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700/60 transition shadow-sm shrink-0"
            title="Cerrar reproductor (Esc)"
          >
            <X className="h-5 w-5" />
          </button>
          <div className="truncate">
            <h2 className="text-sm sm:text-base font-bold text-zinc-100 truncate">{displayTitle}</h2>
            {activeServer && (
              <p className="text-xs text-zinc-400 flex items-center gap-1.5 truncate">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {activeServer.provider} • {activeServer.quality}
              </p>
            )}
          </div>
        </div>

        {/* SELECTOR DE SERVIDORES DESPLEGABLE */}
        {servers.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowServerMenu((prev) => !prev)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-700/70 text-xs text-zinc-200 transition shadow-md"
            >
              <Server className="h-3.5 w-3.5 text-red-500" />
              <span className="font-semibold">{activeServer?.label || 'Servidores'}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                {activeServerIndex + 1}/{servers.length}
              </span>
              <ChevronDown className={`h-3 w-3 transition-transform ${showServerMenu ? 'rotate-180' : ''}`} />
            </button>

            {showServerMenu && (
              <div className="absolute right-0 mt-2 w-64 rounded-xl bg-zinc-900/95 border border-zinc-700/80 p-1.5 shadow-2xl backdrop-blur-xl z-50 max-h-80 overflow-y-auto space-y-1">
                <div className="px-2 py-1 text-[11px] font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-red-400" /> Servidores Disponibles
                </div>
                {servers.map((srv, idx) => (
                  <button
                    key={srv.id || idx}
                    type="button"
                    onClick={() => {
                      setActiveServerIndex(idx);
                      setShowServerMenu(false);
                    }}
                    className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs transition ${
                      idx === activeServerIndex
                        ? 'bg-red-600/20 text-red-400 border border-red-500/40 font-bold'
                        : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                    }`}
                  >
                    <div className="flex flex-col items-start truncate">
                      <span className="truncate">{srv.label}</span>
                      <span className="text-[10px] text-zinc-500">
                        {srv.isEmbed ? 'Reproductor Web (Embed)' : 'Transmisión Nativa Ultra HD'}
                      </span>
                    </div>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border uppercase font-mono ${
                        srv.quality.includes('1080') || srv.quality.includes('4K')
                          ? 'border-amber-500/40 text-amber-400 bg-amber-500/10'
                          : 'border-zinc-700 text-zinc-400'
                      }`}
                    >
                      {srv.quality}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ÁREA CENTRAL DE REPRODUCCIÓN */}
      <div className="flex-1 flex items-center justify-center relative overflow-hidden bg-black">
        {isLoading && (
          <div className="flex flex-col items-center gap-3 text-zinc-400">
            <RefreshCw className="h-8 w-8 animate-spin text-red-500" />
            <p className="text-sm">Conectando con el servidor de video...</p>
          </div>
        )}

        {loadError && !isLoading && (
          <div className="flex flex-col items-center gap-3 max-w-md p-6 rounded-2xl bg-zinc-900/90 border border-red-500/30 text-center shadow-2xl">
            <AlertTriangle className="h-10 w-10 text-red-500" />
            <h3 className="font-bold text-white">Error de Reproducción</h3>
            <p className="text-xs text-zinc-400">{loadError}</p>
            {servers.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  setLoadError(null);
                  setActiveServerIndex((prev) => (prev + 1) % servers.length);
                }}
                className="mt-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-bold text-white transition shadow-lg flex items-center gap-2"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Probar siguiente servidor ({servers.length - 1} restantes)
              </button>
            )}
          </div>
        )}

        {!isLoading && !loadError && activeServer && (
          <>
            {activeServer.isEmbed ? (
              <div className="flex flex-col items-center justify-center gap-3 text-center px-6">
                <AlertTriangle className="h-10 w-10 text-amber-400" />
                <p className="text-sm text-zinc-200">Esta fuente no ofrece un stream nativo reproducible.</p>
                {servers.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setActiveServerIndex((prev) => (prev + 1) % servers.length)}
                    className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white transition"
                  >
                    Probar siguiente servidor
                  </button>
                )}
              </div>
            ) : (
              /* REPRODUCTOR PLYR + HLS NATIVO */
              <div className="w-full h-full max-h-screen flex items-center justify-center plyr-container-wrapper">
                <video
                  ref={videoRef}
                  id="player"
                  className="plyr-react plyr w-full h-full object-contain"
                  playsInline
                  crossOrigin="anonymous"
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* ESTILOS CUSTOM PARA INTEGRAR PLYR CON EL TEMA DARK DE NITIFLIX */}
      <style>{`
        .plyr-container-wrapper {
          --plyr-color-main: #e50914;
          --plyr-video-background: #000000;
          --plyr-menu-background: rgba(18, 18, 18, 0.95);
          --plyr-menu-color: #e4e4e7;
          --plyr-menu-border-color: rgba(63, 63, 70, 0.4);
          --plyr-menu-radius: 12px;
          --plyr-control-radius: 8px;
          --plyr-font-family: inherit;
        }
        .plyr--full-ui {
          width: 100%;
          height: 100%;
        }
        .plyr__video-wrapper {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .plyr__menu__container {
          backdrop-filter: blur(16px);
          border: 1px solid rgba(63, 63, 70, 0.5);
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
        }
      `}</style>
    </div>
  );
}
