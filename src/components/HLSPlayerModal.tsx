// src/components/HLSPlayerModal.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import Hls, { Level } from 'hls.js';
import {
  X,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Volume1,
  Maximize,
  Minimize,
  Settings,
  Captions,
  RotateCcw,
  RotateCw,
  Server,
  ExternalLink,
  Loader2,
  Check,
  Languages,
  PictureInPicture,
  ChevronRight,
  Zap,
  Info,
} from 'lucide-react';
import { api } from '../api/client';
import type { MediaStreamOut, SubtitleTrack, MediaStreamVariant } from '../types';
import {
  rankAndSortServers,
  quickProbeServerHealth,
  type ScoredServer,
} from '../utils/streamOptimizer';


export interface HLSPlayerMedia {
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

interface HLSPlayerModalProps {

  isOpen?: boolean;
  media?: HLSPlayerMedia;
  onClose: () => void;
  directSource?: { url: string; protocol: any } | null;
  title?: string;
  streamUrl?: string;
  all_streams?: string[];
  initialTime?: number;
  onProgressUpdate?: (currentTime: number, duration: number) => void;
  [key: string]: any;
}

interface AudioOption {
  id: number;
  name: string;
  lang?: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function HLSPlayerModal(props: HLSPlayerModalProps) {
  const { media, onClose, directSource = null } = props;

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hideControlsTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastUpdateRef = useRef<number>(0);

  // Estados de Servidores y Selección Inteligente
  const [servers, setServers] = useState<ScoredServer[]>([]);
  const [activeServerIndex, setActiveServerIndex] = useState<number>(0);
  const [serverHealthMap, setServerHealthMap] = useState<Record<string, 'online' | 'checking' | 'failed'>>({});
  const [streamInfo, setStreamInfo] = useState<MediaStreamOut | null>(null);
  const [isLoadingStream, setIsLoadingStream] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failoverNotice, setFailoverNotice] = useState<string | null>(null);

  // Estados de Reproducción
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isPipActive, setIsPipActive] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  // Controles de UI & Auto-Hide
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hoverTime, setHoverTime] = useState<{ time: number; posPercent: number } | null>(null);
  const [activeMenu, setActiveMenu] = useState<'none' | 'quality' | 'audio' | 'subtitles' | 'speed' | 'servers'>('none');

  // Menús de Configuración de Video
  const [qualityLevels, setQualityLevels] = useState<{ index: number; label: string; height?: number }[]>([]);
  const [activeQuality, setActiveQuality] = useState<number>(-1); // -1 = Auto
  const [currentResolutionLabel, setCurrentResolutionLabel] = useState<string>('Auto (Máxima Calidad)');
  const [audioTracks, setAudioTracks] = useState<AudioOption[]>([]);
  const [activeAudioTrack, setActiveAudioTrack] = useState<number>(-1);
  const [activeSubtitleId, setActiveSubtitleId] = useState<string | 'off'>('off');

  const displayTitle =
    props.title ||
    media?.title ||
    props.item?.title ||
    props.result?.title ||
    'Reproduciendo Video';

  // Helper para resetear el temporizador de ocultado de controles
  const showControlsTemporarily = useCallback(() => {
    setControlsVisible(true);
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => {
      if (isPlaying && activeMenu === 'none') {
        setControlsVisible(false);
      }
    }, 3200);
  }, [isPlaying, activeMenu]);

  // 1. RECOPILACIÓN, CALIFICACIÓN Y AUTO-SELECCIÓN DEL MEJOR SERVIDOR
  useEffect(() => {
    let cancelled = false;
    setIsLoadingStream(true);
    setLoadError(null);

    const rawDirect = directSource?.url || props.streamUrl || props.src || media?.stream_url;
    const allCandidateUrls: string[] = Array.from(
      new Set(
        [
          rawDirect,
          ...(props.all_streams || []),
          ...(media?.all_streams || []),
          ...(media?.all_available_streams || []),
          media?.sources?.master_m3u8,
          media?.sources?.fallback_mp4,
          ...(media?.sources?.qualities?.map((q: { url: string }) => q.url) || []),
        ].filter(Boolean)
      )
    );

    if (allCandidateUrls.length > 0) {
      // Ordenar inteligentemente por máxima calidad y salud
      const ranked = rankAndSortServers(allCandidateUrls);
      setServers(ranked);
      setActiveServerIndex(0); // El índice 0 es el de mayor calidad y mejor salud por defecto
      setIsLoadingStream(false);

      // Comprobar salud en segundo plano para enriquecer la UI sin retrasar el inicio
      const initialMap: Record<string, 'online' | 'checking' | 'failed'> = {};
      ranked.forEach((s) => {
        initialMap[s.id] = s.isEmbed ? 'online' : 'checking';
      });
      setServerHealthMap(initialMap);

      ranked.forEach((srv, idx) => {
        if (!srv.isEmbed) {
          quickProbeServerHealth(srv, 1500).then((lat) => {
            if (!cancelled) {
              setServerHealthMap((prev) => ({
                ...prev,
                [srv.id]: lat !== null ? 'online' : 'failed',
              }));
              if (lat !== null) {
                setServers((prev) => {
                  const copy = [...prev];
                  if (copy[idx]) {
                    copy[idx] = { ...copy[idx], latencyMs: lat };
                  }
                  return copy;
                });
              }
            }
          });
        }
      });
      return;
    }

    if (media?.id) {
      api
        .getStream(media.id)
        .then((info) => {
          if (cancelled) return;
          setStreamInfo(info);

          const variantUrls = info.variants?.map((v: MediaStreamVariant) => v.url) || [];
          const masterUrl = (info as any).master_m3u8;
          const fallbackUrl = (info as any).fallback_mp4;

          const collected = Array.from(
            new Set([masterUrl, fallbackUrl, ...variantUrls].filter(Boolean))
          );

          const ranked = rankAndSortServers(collected);
          setServers(ranked);
          setActiveServerIndex(0);

          const defaultSub = info.subtitles?.find((s: SubtitleTrack) => s.is_default);
          setActiveSubtitleId(defaultSub?.id ?? 'off');
        })
        .catch((err) => {
          if (cancelled) return;
          setLoadError(err?.message ?? 'No se pudo obtener la información del stream.');
        })
        .finally(() => {
          if (!cancelled) setIsLoadingStream(false);
        });
    } else {
      setIsLoadingStream(false);
      setLoadError('No se encontraron fuentes de video disponibles.');
    }

    return () => {
      cancelled = true;
    };
  }, [media?.id, directSource, props.streamUrl, props.src, props.all_streams]);

  const activeServer = servers[activeServerIndex] || null;

  // 2. CAMBIO DE SERVIDOR MANUAL O POR FAILOVER AUTOMÁTICO
  const handleServerChange = (index: number, isAutoFailover = false) => {
    if (index === activeServerIndex && !isAutoFailover) return;
    if (index >= servers.length || index < 0) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }

    setPlaybackError(null);
    setIsPlaying(false);
    setQualityLevels([]);
    setActiveQuality(-1);
    setAudioTracks([]);
    setActiveAudioTrack(-1);
    setActiveMenu('none');

    if (isAutoFailover) {
      const targetSrv = servers[index];
      setFailoverNotice(`Conectando automáticamente a servidor de respaldo (${targetSrv?.label || 'Respaldo'})...`);
      setTimeout(() => setFailoverNotice(null), 3000);
    }

    setActiveServerIndex(index);
  };

  // 3. CONEXIÓN NATIVA AL STREAM CON HLS.JS (SELECCIONANDO MÁXIMA CALIDAD AL INSTANTE)
  const attachSource = useCallback((url: string) => {
    const video = videoRef.current;
    if (!video || !url || activeServer?.isEmbed) return;

    setPlaybackError(null);
    setQualityLevels([]);
    setActiveQuality(-1);
    setCurrentResolutionLabel(activeServer?.quality || 'Auto HD');

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const isHls = url.includes('.m3u8') || url.includes('/m3u8/');

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        startLevel: -1, // Hls intentará arrancar en la mejor calidad disponible
        capLevelToPlayerSize: false,
      });

      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);

      // Cuando se analiza el manifiesto, extraemos las calidades e iniciamos en la más alta
      hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
        const levels: { index: number; label: string; height?: number }[] = data.levels.map((lvl: Level, idx: number) => ({
          index: idx,
          label: lvl.height ? `${lvl.height}p` : `${Math.round((lvl.bitrate ?? 0) / 1000)} kbps`,
          height: lvl.height,
        }));

        setQualityLevels(levels);

        // Auto-selección por defecto a la máxima resolución disponible (1080p > 720p > 480p)
        if (levels.length > 0) {
          let maxLevelIndex = 0;
          let maxHeight = 0;
          levels.forEach((lvl) => {
            if (lvl.height && lvl.height > maxHeight) {
              maxHeight = lvl.height;
              maxLevelIndex = lvl.index;
            }
          });

          // Ajustar HLS para que solicite inmediatamente la máxima calidad
          hls.nextLevel = maxLevelIndex;
          setCurrentResolutionLabel(`${maxHeight || 1080}p Ultra HD`);
        }

        if (props.initialTime && props.initialTime > 0) {
          video.currentTime = props.initialTime;
        }

        // Reproducir automáticamente de manera fluida
        video.play().catch(() => {
          setIsPlaying(false);
        });
      });

      // Extraer pistas de audio (multiaudio si el contenido lo incluye)
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_evt, data) => {
        if (data.audioTracks && data.audioTracks.length > 1) {
          const audios: AudioOption[] = data.audioTracks.map((track, idx) => ({
            id: idx,
            name: track.name || track.lang || `Pista ${idx + 1}`,
            lang: track.lang,
          }));
          setAudioTracks(audios);
          setActiveAudioTrack(hls.audioTrack);
        }
      });

      // Manejo de cambio dinámico de calidad
      hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
        const lvl = hls.levels[data.level];
        if (lvl && lvl.height) {
          setCurrentResolutionLabel(`${lvl.height}p ${lvl.height >= 1080 ? 'Full HD' : 'HD'}`);
        }
      });

      // FAILOVER SILENCIOSO Y RÁPIDO SI UN SERVIDOR FALLA
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;

        console.warn('HLS Fatal Error:', data.type, data.details);
        if (activeServer) {
          setServerHealthMap((prev) => ({ ...prev, [activeServer.id]: 'failed' }));
        }

        // Si hay más servidores en la lista, pasar automáticamente al siguiente sin interrumpir al usuario
        if (activeServerIndex < servers.length - 1) {
          const nextIdx = activeServerIndex + 1;
          setFailoverNotice(`Cambiando a ${servers[nextIdx]?.label || 'siguiente servidor'}...`);
          setTimeout(() => setFailoverNotice(null), 3000);
          handleServerChange(nextIdx, true);
        } else {
          setPlaybackError('No se pudo reproducir este stream. Puedes probar con otro servidor en la lista superior.');
        }
      });
        } else if (video.canPlayType('application/vnd.apple.mpegurl') || true) { // the || true handles the generic else case
      video.src = url;
      const onLoadedMetadata = () => {
        if (props.initialTime && props.initialTime > 0) {
          video.currentTime = props.initialTime;
        }
        video.play().catch(() => {});
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
      };
      video.addEventListener('loadedmetadata', onLoadedMetadata);
    }
  }, [activeServer, activeServerIndex, servers.length, props.initialTime]);

  useEffect(() => {
    if (activeServer && !activeServer.isEmbed) {
      attachSource(activeServer.url);
    }
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [activeServer, attachSource]);

  // 3.1 INTENTO DE RESOLUCIÓN ON-DEMAND PARA SERVIDORES EMBED
  useEffect(() => {
    let cancelled = false;
    if (!activeServer || !activeServer.isEmbed) return;
    if (activeServer.url.includes("mega.nz/embed")) return;

    api.resolveEmbed(activeServer.url)
      .then((res) => {
        if (cancelled || !res || !res.resolved || !res.url) return;
        
        // ¡El servidor logró extraer el .m3u8 o .mp4 nativo! Actualizamos el servidor a modo nativo
        setServers((prev) => {
          const copy = [...prev];
          if (copy[activeServerIndex]) {
            copy[activeServerIndex] = {
              ...copy[activeServerIndex],
              url: res.url,
              isEmbed: false,
              streamType: 'direct',
              label: `[Direct HD] ${copy[activeServerIndex].provider}`,
            };
          }
          return copy;
        });

        setFailoverNotice(`Stream nativo optimizado con éxito (${res.provider || 'Servidor'})`);
        setTimeout(() => setFailoverNotice(null), 3000);
      })
      .catch(() => {
        // Fallback silencioso: se mantiene como iframe embed normal
      });

    return () => {
      cancelled = true;
    };
  }, [activeServerIndex, activeServer?.url, activeServer?.isEmbed]);

  // 4. EVENT LISTENERS DEL ELEMENTO VIDEO
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeServer || activeServer.isEmbed) return;

    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      // Throttle progress updates to parent every 5 seconds
      const now = Date.now();
      if (props.onProgressUpdate && now - lastUpdateRef.current > 5000) {
        props.onProgressUpdate(video.currentTime, video.duration || 0);
        lastUpdateRef.current = now;
      }
    };
    const onDurationChange = () => setDuration(video.duration || 0);
    const onProgress = () => {
      if (video.buffered.length > 0) {
        setBufferedEnd(video.buffered.end(video.buffered.length - 1));
      }
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => {
      setIsPlaying(false);
      if (props.onProgressUpdate) {
        props.onProgressUpdate(video.currentTime, video.duration || 0);
      }
    };
    const onVolumeChange = () => {
      setVolume(video.volume);
      setIsMuted(video.muted);
    };
    const onError = () => {
      if (activeServerIndex < servers.length - 1) {
        handleServerChange(activeServerIndex + 1, true);
      } else {
        setPlaybackError('Error al decodificar video en este servidor.');
      }
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('progress', onProgress);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('error', onError);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('error', onError);
    };
  }, [activeServer, activeServerIndex, servers.length]);

  // 5. ATAJOS DE TECLADO Y FULLSCREEN
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      showControlsTemporarily();

      if (e.key === 'Escape') {
        if (activeMenu !== 'none') {
          setActiveMenu('none');
        } else {
          handleClose();
        }
      } else if (e.key === ' ' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        toggleMute();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seekOffset(-10);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seekOffset(10);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        changeVolume(0.1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        changeVolume(-0.1);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isPlaying, activeMenu, showControlsTemporarily]);

  const handleClose = () => {
    if (videoRef.current && props.onProgressUpdate) {
      props.onProgressUpdate(videoRef.current.currentTime, videoRef.current.duration || 0);
    }
    onClose();
  };

  // Controles de Acción de Reproducción
  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const seekOffset = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration, video.currentTime + seconds));
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.6;
  };

  const changeVolume = (delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    const newVol = Math.max(0, Math.min(1, video.volume + delta));
    video.volume = newVol;
    video.muted = newVol === 0;
  };

  const handleVolumeSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const val = Number(e.target.value);
    video.volume = val;
    video.muted = val === 0;
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Number(e.target.value);
  };

  const handleScrubberMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverTime({
      time: pos * (duration || 0),
      posPercent: pos * 100,
    });
  };

  const handleScrubberMouseLeave = () => {
    setHoverTime(null);
  };

  const toggleFullscreen = () => {
    const node = containerRef.current;
    if (!node) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      node.requestFullscreen();
    }
  };

  const togglePictureInPicture = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPipActive(false);
      } else if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
        setIsPipActive(true);
      }
    } catch (e) {
      console.warn('PiP error:', e);
    }
  };

  const handleSpeedChange = (rate: number) => {
    const video = videoRef.current;
    if (video) video.playbackRate = rate;
    setPlaybackRate(rate);
    setActiveMenu('none');
  };

  const selectQuality = (levelIndex: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex;
      if (levelIndex === -1) {
        setCurrentResolutionLabel('Auto (Máxima Calidad)');
      } else {
        const lvl = qualityLevels.find((q) => q.index === levelIndex);
        setCurrentResolutionLabel(lvl?.label || 'Manual');
      }
    }
    setActiveQuality(levelIndex);
    setActiveMenu('none');
  };

  const selectAudioTrack = (trackIndex: number) => {
    if (hlsRef.current) hlsRef.current.audioTrack = trackIndex;
    setActiveAudioTrack(trackIndex);
    setActiveMenu('none');
  };

  const selectSubtitle = (track: SubtitleTrack | 'off') => {
    const video = videoRef.current;
    if (!video) return;
    Array.from(video.textTracks).forEach((tt) => {
      tt.mode = 'disabled';
    });
    if (track === 'off') {
      setActiveSubtitleId('off');
    } else {
      const domTrack = Array.from(video.textTracks).find((tt) => tt.label === track.label);
      if (domTrack) domTrack.mode = 'showing';
      setActiveSubtitleId(track.id);
    }
    setActiveMenu('none');
  };

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-xl p-0 sm:p-4 select-none animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      onMouseMove={showControlsTemporarily}
      onMouseDown={showControlsTemporarily}
    >
      <div
        ref={containerRef}
        className={`relative flex h-full w-full flex-col justify-between bg-black sm:h-[92vh] sm:w-[96vw] sm:rounded-2xl sm:border sm:border-zinc-800/80 shadow-2xl overflow-hidden ${
          !controlsVisible && isPlaying ? 'cursor-none' : ''
        }`}
      >
        {/* ========================================================================= */}
        {/* 1. TOP BAR MODERNA Y ELEGANTE (SIN SLOP)                                   */}
        {/* ========================================================================= */}
        <div
          className={`absolute top-0 inset-x-0 z-40 flex items-center justify-between px-4 sm:px-6 py-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-300 ${
            controlsVisible || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* TÍTULO Y BADGE DE CALIDAD */}
          <div className="flex items-center gap-3 max-w-[65%] sm:max-w-[75%] truncate">
            <button
              type="button"
              onClick={handleClose}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700/60 transition shadow-sm shrink-0"
              title="Cerrar reproductor (Esc)"
            >
              <X size={18} />
            </button>

            <div className="flex flex-col truncate">
              <h3 className="text-sm sm:text-base font-semibold text-white truncate tracking-tight">
                {displayTitle}
              </h3>
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="inline-flex items-center gap-1 text-emerald-400 font-medium font-mono text-[11px]">
                  <Zap size={12} />
                  {currentResolutionLabel}
                </span>
                <span>•</span>
                <span className="truncate text-zinc-400">
                  {activeServer?.provider || 'Servidor Rápido'}
                </span>
              </div>
            </div>
          </div>

          {/* ACCIONES SUPERIORES: CAMBIO RÁPIDO DE SERVIDORES Y APERTURA EXTERNA */}
          <div className="flex items-center gap-2 shrink-0">
            {/* SELECTOR DE SERVIDORES RÁPIDO */}
            {servers.length > 1 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setActiveMenu((m) => (m === 'servers' ? 'none' : 'servers'))}
                  className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border backdrop-blur-md transition ${
                    activeMenu === 'servers'
                      ? 'bg-zinc-800 text-white border-zinc-600'
                      : 'bg-zinc-900/80 text-zinc-300 hover:text-white border-zinc-700/60'
                  }`}
                  title="Cambiar Servidor de Streaming"
                >
                  <Server size={13} className="text-emerald-400" />
                  <span className="hidden sm:inline">Servidor {activeServerIndex + 1}/{servers.length}</span>
                  <ChevronRight size={12} className={activeMenu === 'servers' ? 'rotate-90' : ''} />
                </button>

                {/* MENÚ FLOTANTE DE SERVIDORES */}
                {activeMenu === 'servers' && (
                  <div className="absolute right-0 top-11 w-64 rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-2 shadow-2xl backdrop-blur-xl z-50">
                    <div className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center justify-between">
                      <span>Servidores Disponibles</span>
                      <span className="text-[10px] text-emerald-400 font-normal">Auto-ordenados por calidad</span>
                    </div>
                    <div className="mt-1 space-y-1 max-h-56 overflow-y-auto pr-1">
                      {servers.map((srv, idx) => {
                        const status = serverHealthMap[srv.id] || (srv.isEmbed ? 'online' : 'checking');
                        return (
                          <button
                            key={srv.id}
                            type="button"
                            onClick={() => {
                              handleServerChange(idx);
                              setActiveMenu('none');
                            }}
                            className={`w-full flex items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition ${
                              activeServerIndex === idx
                                ? 'bg-zinc-800 text-white font-semibold'
                                : status === 'failed'
                                ? 'text-zinc-500 opacity-60 hover:bg-zinc-800/30'
                                : 'text-zinc-300 hover:bg-zinc-800/60'
                            }`}
                          >
                            <div className="flex items-center gap-2 truncate pr-2">
                              {/* Indicador visual de salud */}
                              <span
                                className={`h-2 w-2 rounded-full shrink-0 ${
                                  status === 'online'
                                    ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50'
                                    : status === 'checking'
                                    ? 'bg-amber-400 animate-pulse'
                                    : 'bg-rose-500'
                                }`}
                                title={
                                  status === 'online'
                                    ? 'Servidor Verificado (Online)'
                                    : status === 'checking'
                                    ? 'Comprobando respuesta...'
                                    : 'Servidor no disponible'
                                }
                              />
                              <div className="flex flex-col truncate">
                                <span className={`truncate ${status === 'failed' ? 'line-through' : ''}`}>{srv.label}</span>
                                <span className="text-[10px] text-zinc-500 font-mono">
                                  {srv.isEmbed ? 'Reproductor Web (Embed)' : 'Stream Directo (HLS)'}
                                  {srv.latencyMs ? ` • ${srv.latencyMs}ms` : ''}
                                  {status === 'failed' ? ' • No disponible' : ''}
                                </span>
                              </div>
                            </div>
                            {activeServerIndex === idx && (
                              <Check size={14} className="text-emerald-400 shrink-0" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeServer && (
              <a
                href={activeServer.url}
                target="_blank"
                rel="noreferrer"
                className="hidden sm:flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white bg-zinc-900/80 hover:bg-zinc-800 px-3 py-1.5 rounded-lg border border-zinc-700/60 transition shadow-sm backdrop-blur-md"
                title="Abrir fuente en pestaña nueva"
              >
                <ExternalLink size={13} />
                <span>Pestaña</span>
              </a>
            )}
          </div>
        </div>

        {/* NOTIFICACIÓN DISCRETA DE FAILOVER O RECONEXIÓN */}
        {failoverNotice && (
          <div className="absolute top-16 inset-x-0 z-50 flex justify-center pointer-events-none animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="rounded-full bg-zinc-900/90 border border-emerald-500/40 px-4 py-1.5 text-xs text-emerald-300 shadow-xl backdrop-blur-md flex items-center gap-2 font-medium">
              <Zap size={14} className="animate-pulse" />
              <span>{failoverNotice}</span>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 2. ÁREA CENTRAL DE VIDEO Y FEEDBACK INTERACTIVO                            */}
        {/* ========================================================================= */}
        <div
          className="relative flex-1 bg-black flex items-center justify-center overflow-hidden"
          onClick={() => {
            if (activeServer && !activeServer.isEmbed) {
              if (activeMenu !== 'none') {
                setActiveMenu('none');
              } else {
                togglePlay();
              }
            }
          }}
          onDoubleClick={toggleFullscreen}
        >
          {isLoadingStream && (
            <div className="flex flex-col items-center gap-3 text-white z-20">
              <Loader2 className="h-10 w-10 animate-spin text-zinc-400" />
              <p className="text-xs font-mono text-zinc-400">Optimizando servidores y máxima calidad...</p>
            </div>
          )}

          {!isLoadingStream && loadError && (
            <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center z-20">
              <Info className="h-8 w-8 text-amber-400" />
              <p className="text-sm text-zinc-200">{loadError}</p>
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs text-white hover:bg-zinc-700 transition"
              >
                Cerrar
              </button>
            </div>
          )}

          {!isLoadingStream && !loadError && activeServer && (
            <>
              {activeServer.isEmbed ? (
                /* MODO EMBED IFRAME */
                <iframe
                  key={activeServer.url}
                  src={activeServer.url}
                  className="h-full w-full border-0 bg-black"
                  allow="autoplay; fullscreen; encrypted-media; picture-in-picture; accelerometer; gyroscope"
                  allowFullScreen
                />
              ) : (
                /* MODO NATIVO HLS */
                <>
                  <video
                    ref={videoRef}
                    className="h-full w-full object-contain"
                    playsInline
                    preload="auto"
                  >
                    {streamInfo?.subtitles?.map((sub: SubtitleTrack) => (
                      <track
                        key={sub.id}
                        kind="subtitles"
                        src={sub.url}
                        srcLang={sub.language}
                        label={sub.label}
                      />
                    ))}
                  </video>

                  {/* ERROR OVERLAY Y REINTENTO */}
                  {playbackError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 px-6 text-center z-30">
                      <p className="text-sm text-zinc-200 max-w-md">{playbackError}</p>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => attachSource(activeServer.url)}
                          className="flex items-center gap-2 rounded-lg bg-zinc-800 border border-zinc-700 px-4 py-2 text-xs font-medium text-white hover:bg-zinc-700 transition"
                        >
                          <RotateCcw size={14} /> Reintentar
                        </button>
                        {servers.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleServerChange((activeServerIndex + 1) % servers.length)}
                            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 transition"
                          >
                            Probar Siguiente Servidor
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* BOTÓN CENTRAL DE PLAY CUANDO ESTÁ PAUSADO */}
                  {!isPlaying && !playbackError && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-900/80 text-white border border-zinc-700/80 shadow-2xl backdrop-blur-md transform transition-transform hover:scale-110">
                        <Play size={26} className="ml-1 fill-current" />
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* ========================================================================= */}
        {/* 3. BARRA INFERIOR DE CONTROLES CINEMATOGRÁFICA (SIN SLOP)                 */}
        {/* ========================================================================= */}
        <div
          className={`absolute bottom-0 inset-x-0 z-40 flex flex-col bg-gradient-to-t from-black/90 via-black/60 to-transparent px-4 sm:px-6 pt-6 pb-4 transition-opacity duration-300 ${
            controlsVisible || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {activeServer && !activeServer.isEmbed && (
            <>
              {/* LÍNEA DE TIEMPO / SCRUBBER CON BUFFER Y PREVISUALIZACIÓN DE TIEMPO */}
              <div
                className="group relative h-2 w-full cursor-pointer rounded-full bg-zinc-800/80 mb-3 flex items-center"
                onMouseMove={handleScrubberMouseMove}
                onMouseLeave={handleScrubberMouseLeave}
              >
                {/* TOOLTIP FLOTANTE DE TIEMPO AL PASAR EL CURSOR */}
                {hoverTime && (
                  <div
                    className="absolute -top-7 -translate-x-1/2 rounded bg-zinc-900 border border-zinc-700 px-2 py-0.5 text-[10px] font-mono font-medium text-zinc-200 shadow-lg pointer-events-none"
                    style={{ left: `${hoverTime.posPercent}%` }}
                  >
                    {formatTime(hoverTime.time)}
                  </div>
                )}

                {/* BARRA DE BUFFER */}
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-zinc-600/60 transition-all"
                  style={{ width: `${bufferedPct}%` }}
                />

                {/* BARRA DE PROGRESO */}
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-emerald-500 shadow-sm"
                  style={{ width: `${progressPct}%` }}
                />

                {/* THUMB DE SEGUIMIENTO */}
                <div
                  className="absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-white shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ left: `${progressPct}%` }}
                />

                {/* INPUT RANGE INVISIBLE PARA ACCESIBILIDAD Y ARRASTRE */}
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.1}
                  value={currentTime}
                  onChange={handleSeek}
                  aria-label="Línea de tiempo del video"
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
              </div>

              {/* FILA DE BOTONES DE CONTROL Y MENÚS */}
              <div className="flex items-center justify-between gap-3">
                {/* LADO IZQUIERDO: PLAY/PAUSE, SALTOS +/- 10S, VOLUMEN, TIEMPO */}
                <div className="flex items-center gap-3 sm:gap-4">
                  <button
                    type="button"
                    onClick={togglePlay}
                    aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
                    className="text-zinc-200 hover:text-white transition"
                  >
                    {isPlaying ? <Pause size={20} className="fill-current" /> : <Play size={20} className="fill-current ml-0.5" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => seekOffset(-10)}
                    aria-label="Retroceder 10 segundos"
                    className="text-zinc-400 hover:text-white transition hidden xs:inline-block"
                    title="Retroceder 10s (←)"
                  >
                    <RotateCcw size={17} />
                  </button>

                  <button
                    type="button"
                    onClick={() => seekOffset(10)}
                    aria-label="Adelantar 10 segundos"
                    className="text-zinc-400 hover:text-white transition hidden xs:inline-block"
                    title="Adelantar 10s (→)"
                  >
                    <RotateCw size={17} />
                  </button>

                  {/* CONTROL DE VOLUMEN */}
                  <div className="flex items-center gap-1.5 group/vol">
                    <button
                      type="button"
                      onClick={toggleMute}
                      aria-label="Silenciar o activar sonido"
                      className="text-zinc-300 hover:text-white transition"
                    >
                      {isMuted || volume === 0 ? (
                        <VolumeX size={18} />
                      ) : volume < 0.5 ? (
                        <Volume1 size={18} />
                      ) : (
                        <Volume2 size={18} />
                      )}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={isMuted ? 0 : volume}
                      onChange={handleVolumeSlider}
                      className="w-16 sm:w-20 accent-emerald-500 cursor-pointer hidden sm:block h-1 bg-zinc-700 rounded-lg"
                    />
                  </div>

                  {/* DISPLAY DE TIEMPO FORMATEADO */}
                  <span className="font-mono text-xs text-zinc-300 tracking-tight">
                    {formatTime(currentTime)} <span className="text-zinc-600">/</span> {formatTime(duration)}
                  </span>
                </div>

                {/* LADO DERECHO: AUDIO, SUBTÍTULOS, VELOCIDAD, CALIDAD, PIP, FULLSCREEN */}
                <div className="flex items-center gap-2 sm:gap-3">
                  {/* MENÚ DE IDIOMA / PISTAS DE AUDIO */}
                  {audioTracks.length > 0 && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setActiveMenu((m) => (m === 'audio' ? 'none' : 'audio'))}
                        className={`text-zinc-300 hover:text-white p-1.5 rounded-lg transition ${
                          activeMenu === 'audio' ? 'bg-zinc-800 text-white' : ''
                        }`}
                        title="Idioma de Audio"
                      >
                        <Languages size={17} />
                      </button>
                      {activeMenu === 'audio' && (
                        <div className="absolute bottom-10 right-0 w-44 rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl z-50">
                          <span className="block px-2.5 py-1 text-[10px] font-bold text-zinc-400 uppercase">
                            Idioma de Audio
                          </span>
                          {audioTracks.map((track) => (
                            <button
                              key={track.id}
                              type="button"
                              onClick={() => selectAudioTrack(track.id)}
                              className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs rounded-lg transition ${
                                activeAudioTrack === track.id
                                  ? 'text-emerald-400 font-semibold bg-zinc-800'
                                  : 'text-zinc-200 hover:bg-zinc-800/60'
                              }`}
                            >
                              <span>{track.name}</span>
                              {activeAudioTrack === track.id && <Check size={12} />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* MENÚ DE SUBTÍTULOS */}
                  {streamInfo?.subtitles && streamInfo.subtitles.length > 0 && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setActiveMenu((m) => (m === 'subtitles' ? 'none' : 'subtitles'))}
                        className={`p-1.5 rounded-lg transition ${
                          activeSubtitleId !== 'off'
                            ? 'text-emerald-400 bg-emerald-500/10'
                            : activeMenu === 'subtitles'
                            ? 'bg-zinc-800 text-white'
                            : 'text-zinc-300 hover:text-white'
                        }`}
                        title="Subtítulos"
                      >
                        <Captions size={17} />
                      </button>
                      {activeMenu === 'subtitles' && (
                        <div className="absolute bottom-10 right-0 w-40 rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl z-50">
                          <button
                            type="button"
                            onClick={() => selectSubtitle('off')}
                            className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs rounded-lg transition ${
                              activeSubtitleId === 'off'
                                ? 'text-emerald-400 font-semibold bg-zinc-800'
                                : 'text-zinc-200 hover:bg-zinc-800/60'
                            }`}
                          >
                            <span>Desactivados</span>
                            {activeSubtitleId === 'off' && <Check size={12} />}
                          </button>
                          {streamInfo.subtitles.map((sub: SubtitleTrack) => (
                            <button
                              key={sub.id}
                              type="button"
                              onClick={() => selectSubtitle(sub)}
                              className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs rounded-lg transition ${
                                activeSubtitleId === sub.id
                                  ? 'text-emerald-400 font-semibold bg-zinc-800'
                                  : 'text-zinc-200 hover:bg-zinc-800/60'
                              }`}
                            >
                              <span>{sub.label}</span>
                              {activeSubtitleId === sub.id && <Check size={12} />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* MENÚ DE VELOCIDAD DE REPRODUCCIÓN */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setActiveMenu((m) => (m === 'speed' ? 'none' : 'speed'))}
                      className={`text-xs font-mono font-medium px-2 py-1 rounded-lg transition border ${
                        playbackRate !== 1
                          ? 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10'
                          : activeMenu === 'speed'
                          ? 'border-zinc-600 bg-zinc-800 text-white'
                          : 'border-zinc-700/50 bg-zinc-800/60 text-zinc-300 hover:text-white'
                      }`}
                      title="Velocidad de reproducción"
                    >
                      {playbackRate}x
                    </button>
                    {activeMenu === 'speed' && (
                      <div className="absolute bottom-10 right-0 w-32 rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl z-50">
                        <span className="block px-2.5 py-1 text-[10px] font-bold text-zinc-400 uppercase">
                          Velocidad
                        </span>
                        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                          <button
                            key={rate}
                            type="button"
                            onClick={() => handleSpeedChange(rate)}
                            className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs rounded-lg transition ${
                              playbackRate === rate
                                ? 'text-emerald-400 font-semibold bg-zinc-800'
                                : 'text-zinc-200 hover:bg-zinc-800/60'
                            }`}
                          >
                            <span>{rate === 1 ? 'Normal (1x)' : `${rate}x`}</span>
                            {playbackRate === rate && <Check size={12} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* MENÚ DE CALIDAD DE VIDEO */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setActiveMenu((m) => (m === 'quality' ? 'none' : 'quality'))}
                      className={`p-1.5 rounded-lg transition ${
                        activeMenu === 'quality' ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:text-white'
                      }`}
                      title="Calidad de video"
                    >
                      <Settings size={17} />
                    </button>
                    {activeMenu === 'quality' && (
                      <div className="absolute bottom-10 right-0 w-44 rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl z-50">
                        <span className="block px-2.5 py-1 text-[10px] font-bold text-zinc-400 uppercase">
                          Calidad de Video
                        </span>
                        <button
                          type="button"
                          onClick={() => selectQuality(-1)}
                          className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs rounded-lg transition ${
                            activeQuality === -1
                              ? 'text-emerald-400 font-semibold bg-zinc-800'
                              : 'text-zinc-200 hover:bg-zinc-800/60'
                          }`}
                        >
                          <span>Auto (Máxima HD)</span>
                          {activeQuality === -1 && <Check size={12} />}
                        </button>
                        {qualityLevels.map((lvl) => (
                          <button
                            key={lvl.index}
                            type="button"
                            onClick={() => selectQuality(lvl.index)}
                            className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs rounded-lg transition ${
                              activeQuality === lvl.index
                                ? 'text-emerald-400 font-semibold bg-zinc-800'
                                : 'text-zinc-200 hover:bg-zinc-800/60'
                            }`}
                          >
                            <span>{lvl.label}</span>
                            {activeQuality === lvl.index && <Check size={12} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* PICTURE IN PICTURE */}
                  <button
                    type="button"
                    onClick={togglePictureInPicture}
                    className={`p-1.5 rounded-lg transition hidden sm:inline-block ${
                      isPipActive ? 'text-emerald-400 bg-emerald-500/10' : 'text-zinc-300 hover:text-white'
                    }`}
                    title="Ventana flotante (PiP)"
                  >
                    <PictureInPicture size={17} />
                  </button>

                  {/* PANTALLA COMPLETA */}
                  <button
                    type="button"
                    onClick={toggleFullscreen}
                    className="text-zinc-300 hover:text-white p-1.5 rounded-lg transition"
                    title="Pantalla completa (F)"
                  >
                    {isFullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* CONTROLES PARA MODO EMBED (IFRAME) */}
          {activeServer && activeServer.isEmbed && (
            <div className="flex items-center justify-end text-xs text-zinc-400">
              <button
                type="button"
                onClick={toggleFullscreen}
                className="flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white bg-zinc-900/90 px-3 py-1.5 rounded-lg border border-zinc-700/60 transition shadow-sm"
              >
                {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
                <span>Pantalla Completa</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
