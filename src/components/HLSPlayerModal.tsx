// src/components/HLSPlayerModal.tsx
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Hls from 'hls.js';
import type { Level } from 'hls.js';
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
  Settings2,
  Captions,
  RotateCcw,
  RotateCw,
  Server,
  Check,
  Languages,
  PictureInPicture,
  ChevronRight,
  Zap,
  Info,
  Cast,
  SkipForward,
  Lock,
  Unlock,
  Users,
  MoreVertical,
  Share2,
} from 'lucide-react';
import { api, getAuthToken, type PlaybackResolution } from '../api/client';
import { useChromecast } from '../hooks/useChromecast';
import { useTeleparty, type WatchPartyMedia } from '../hooks/useTeleparty';
import { WatchPartyPanel } from './WatchPartyPanel';
import { WatchPartyJoinModal } from './WatchPartyJoinModal';
import type { MediaStreamOut, SubtitleTrack, MediaStreamVariant, RankedStream } from '../types';
import { parseWebVttCues, type ParsedSubtitleCue } from '../utils/subtitleFormat';
import {
  DEFAULT_SUBTITLE_TIMING,
  formatSubtitleTime,
  parseSubtitleTime,
  subtitleTimelineTime,
  type SubtitleTimingSettings,
} from '../utils/subtitleTiming';
// proxiedStreamUrl removed
import {
  rankAndSortServers,
  quickProbeServerHealth,
  hasExpiringSignature,
  applyBackendTiers,
  scoredServerFromRanked,
  type ScoredServer,
} from '../utils/streamOptimizer';
import { getDeliveryCapability, setDeliveryCapability } from '../utils/deliveryCapabilities';
import { APP_PREFERENCES_EVENT, getAppPreferences } from '../utils/appPreferences';
import {
  backendUrl,
  publicAppUrl,
  isNativeShell,
  nativeHaptic,
  nativeLockLandscape,
  nativeSetImmersive,
  nativeShare,
  nativeUnlockOrientation,
} from '../utils/runtime';
import { normalizePlayerLanguage, playerLanguageLabel } from '../utils/playerLanguages';
import {
  applyResolution,
  buildAttachmentKey,
  canonicalUrlOf,
  serversStableSignature,
  updateRenewedServer,
  nextDeliveryIntent,
  shouldScheduleRenewal,
  canEscalateToProxy,
  shouldProxyForCast,
  isExpiredWithoutLocator,
  isUnresolvedCanonical,
  prioritizeDirectCandidates,
  hasAttemptedMode,
  recordAttemptedMode,
  isNativeMediaUrl,
  DIRECT_WATCHDOG_MS,
  DIRECT_BLACK_SCREEN_MS,
  MAX_PROBE_CANDIDATES,
  MSG_EXPIRED_WITHOUT_LOCATOR,
  MSG_PROXY_FAILED,
  MSG_NO_SERVERS,
  type DeliveryState,
} from '../utils/playerDelivery';

const LazyReportControl = lazy(() => import('./ReportControl'));

export interface HLSPlayerMedia {
  id?: string;
  title?: string;
  showTitle?: string;
  poster_url?: string | null;
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
  ranked_streams?: RankedStream[];
  /** Pistas externas opcionales (por ejemplo OpenSubtitles) ya normalizadas. */
  subtitleTracks?: SubtitleTrack[];
  initialTime?: number;
  onProgressUpdate?: (currentTime: number, duration: number) => void;
  onNextEpisode?: () => void;
  userId?: string | null;
  showId?: string | null;
  tmdbId?: number | null;
  kind?: string | null;
  episodeId?: string | null;
  episodeNumber?: number | null;
  [key: string]: any;
}

interface AudioOption {
  id: number;
  name: string;
  lang?: string;
}

function normalizedLanguageKey(value: unknown): string {
  return normalizePlayerLanguage(value);
}

function languageDisplayName(value: unknown): string {
  return playerLanguageLabel(value);
}

function renditionDisplayName(key: string, items: Array<{ server: ScoredServer; index: number }>): string {
  const first = items[0]?.server;
  const audio = String(first?.audio_language || '').trim();
  const subtitle = String(first?.subtitle_language || '').trim();
  if (audio) return `Audio ${languageDisplayName(audio)}`;
  if (subtitle) return `Subtítulos ${languageDisplayName(subtitle)}`;
  return languageDisplayName(key);
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
  const nativeShell = isNativeShell();
  const { media, onClose, directSource = null } = props;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoNode, setVideoNode] = useState<HTMLVideoElement | null>(null);
  const videoCallbackRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    setVideoNode(node);
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const wakeLockRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  // dash.js se carga solo cuando se selecciona un manifiesto MPD.
  const dashRef = useRef<any>(null);
  const hideControlsTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastNativeTapRef = useRef<{ at: number; x: number } | null>(null);
  const lastUpdateRef = useRef<number>(0);
  const autoFailoverCountRef = useRef<number>(0);

  // Identificador creciente por intento (protección contra carreras): cualquier
  // temporizador o promesa que termine después de cambiar de servidor se ignora.
  const attemptIdRef = useRef<number>(0);
  // Regla 7: Un servidor no puede intentarse más de una vez por modo dentro del mismo intento de reproducción.
  const attemptedModesRef = useRef<Set<string>>(new Set());
  // HLS.js can recover a decoder/media fault in-place. Allow one recovery per
  // playback attempt before escalating to proxy or another server.
  const mediaRecoveryAttemptsRef = useRef<Set<number>>(new Set());
  // Los locators de páginas/embeds pueden fallar por una respuesta transitoria
  // del proveedor. Permitimos un único reintento del mismo locator antes de
  // avanzar para que el failover no descarte una fuente primaria recuperable.
  const jitRetryCountsRef = useRef<Map<string, number>>(new Map());

  // Telemetría de salud y detección de pantalla negra / stalls
  const loadStartMsRef = useRef<number>(Date.now());
  const blackScreenTimerRef = useRef<NodeJS.Timeout | null>(null);
  const proxyRequestInFlightRef = useRef<boolean>(false);
  const playbackConfirmedRef = useRef<boolean>(false);
  const bufferCountRef = useRef<number>(0);
  const bufferingStartMsRef = useRef<number | null>(null);
  const stallFailoverTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Preserva la posición al cambiar entre una fuente subtitulada/doblada o
  // durante un failover. Se consume al recibir MANIFEST_PARSED/metadata.
  const pendingResumeTimeRef = useRef<number | null>(null);

  // Estados de Servidores y Selección Inteligente
  const [servers, setServers] = useState<ScoredServer[]>([]);
  const [activeServerIndex, setActiveServerIndex] = useState<number>(0);
  const [serverHealthMap, setServerHealthMap] = useState<Record<string, 'online' | 'checking' | 'unverified' | 'failed'>>({});
  const [streamInfo, setStreamInfo] = useState<MediaStreamOut | null>(null);
  const [resolvedSubtitleTracks, setResolvedSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [isLoadingStream, setIsLoadingStream] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failoverNotice, setFailoverNotice] = useState<string | null>(null);
  const [canonicalResolveError, setCanonicalResolveError] = useState<string | null>(null);

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
  const [hasEnded, setHasEnded] = useState(false);

  useEffect(() => {
    setHasEnded(false);
    setNextCountdown(null);
  }, [props.episodeId, props.streamUrl]);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [deliveryState, setDeliveryState] = useState<DeliveryState>('resolving');
  // La cascada sigue eligiendo automáticamente el primer servidor, pero si
  // hay varias fuentes el usuario debe poder inspeccionarlas y cambiar de
  // plataforma sin entrar al panel de administración.
  const [serverSelectorAlways, setServerSelectorAlways] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('voidstream_show_server_selector') === 'true';
  });
  const [activeSessionUrl, setActiveSessionUrl] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const directWatchdogRef = useRef<NodeJS.Timeout | null>(null);
  const renewalTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Limpieza de listeners nativos del <video> para poder eliminarlos en cada
  // cambio de servidor (fantasmas de un intento anterior).
  const nativeListenersCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const syncSelectorPreference = () => {
      setServerSelectorAlways(window.localStorage.getItem('voidstream_show_server_selector') === 'true');
    };
    window.addEventListener('voidstream:server-selector-changed', syncSelectorPreference);
    window.addEventListener('storage', syncSelectorPreference);
    return () => {
      window.removeEventListener('voidstream:server-selector-changed', syncSelectorPreference);
      window.removeEventListener('storage', syncSelectorPreference);
    };
  }, []);

  const showServerSelector = servers.length > 1 || serverSelectorAlways || Boolean(playbackError) || deliveryState === 'error';

  // Una respuesta lenta no es un fallo fatal. En ese caso detenemos el intento
  // actual y dejamos que la persona decida si quiere reintentar esta fuente o
  // probar otra, sin cambiar de servidor por su cuenta.
  const requestManualServerChoice = useCallback((message: string) => {
    if (directWatchdogRef.current) {
      clearTimeout(directWatchdogRef.current);
      directWatchdogRef.current = null;
    }
    if (blackScreenTimerRef.current) {
      clearTimeout(blackScreenTimerRef.current);
      blackScreenTimerRef.current = null;
    }
    if (stallFailoverTimerRef.current) {
      clearTimeout(stallFailoverTimerRef.current);
      stallFailoverTimerRef.current = null;
    }
    videoRef.current?.pause();
    setFailoverNotice(null);
    setPlaybackError(message);
    setDeliveryState('awaiting_manual_choice');
  }, []);

  // SELECTOR MANUAL: visible con >1 candidato para permitir elegir otra fuente
  // nativa cuando el watchdog o la resolución JIT marcan una fuente como caída.

  // Controles de UI & Auto-Hide
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isScreenLocked, setIsScreenLocked] = useState(false);
  const [showLockWidget, setShowLockWidget] = useState(false);
  const lockWidgetTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [hoverTime, setHoverTime] = useState<{ time: number; posPercent: number } | null>(null);
  const [activeMenu, setActiveMenu] = useState<'none' | 'quality' | 'audio' | 'subtitles' | 'speed' | 'servers' | 'more'>('none');

  // Menús de Configuración de Video
  const [qualityLevels, setQualityLevels] = useState<{ index: number; label: string; height?: number }[]>([]);
  const [activeQuality, setActiveQuality] = useState<number>(-1); // -1 = Auto
  const [currentResolutionLabel, setCurrentResolutionLabel] = useState<string>('Auto (Máxima Calidad)');
  const [audioTracks, setAudioTracks] = useState<AudioOption[]>([]);
  const [activeAudioTrack, setActiveAudioTrack] = useState<number>(-1);
  const [activeSubtitleId, setActiveSubtitleId] = useState<string | 'off'>('off');
  const [activeSubtitleCues, setActiveSubtitleCues] = useState<ParsedSubtitleCue[]>([]);
  const [expandedAudioLanguages, setExpandedAudioLanguages] = useState<Record<string, boolean>>({});
  const [expandedSubtitleLanguages, setExpandedSubtitleLanguages] = useState<Record<string, boolean>>({});
  const [subtitleSettingsOpen, setSubtitleSettingsOpen] = useState(false);
  const [subtitleTiming, setSubtitleTiming] = useState<SubtitleTimingSettings>(DEFAULT_SUBTITLE_TIMING);
  const [subtitleStartInput, setSubtitleStartInput] = useState(formatSubtitleTime(DEFAULT_SUBTITLE_TIMING.startAt));
  const [subtitleOffsetInput, setSubtitleOffsetInput] = useState(formatSubtitleTime(DEFAULT_SUBTITLE_TIMING.offset, true));
  const [loadedSubtitleTimingKey, setLoadedSubtitleTimingKey] = useState<string | null>(null);
  const [preferencesRevision, setPreferencesRevision] = useState(0);
  const preferenceScope = props.userId || 'guest';
  const appPreferences = getAppPreferences(preferenceScope);
  const subtitleTimingKey = `meristream:subtitle-timing:${preferenceScope}:${String(media?.id || props.item?.id || props.title || 'current')}`;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(subtitleTimingKey);
      const parsed = raw ? JSON.parse(raw) as Partial<SubtitleTimingSettings> : {};
      const next: SubtitleTimingSettings = {
        startAt: Number.isFinite(parsed.startAt) ? Math.max(0, Number(parsed.startAt)) : 0,
        offset: Number.isFinite(parsed.offset) ? Number(parsed.offset) : 0,
      };
      setSubtitleTiming(next);
      setSubtitleStartInput(formatSubtitleTime(next.startAt));
      setSubtitleOffsetInput(formatSubtitleTime(next.offset, true));
      setLoadedSubtitleTimingKey(subtitleTimingKey);
    } catch {
      setSubtitleTiming(DEFAULT_SUBTITLE_TIMING);
      setSubtitleStartInput(formatSubtitleTime(DEFAULT_SUBTITLE_TIMING.startAt));
      setSubtitleOffsetInput(formatSubtitleTime(DEFAULT_SUBTITLE_TIMING.offset, true));
      setLoadedSubtitleTimingKey(subtitleTimingKey);
    }
  }, [subtitleTimingKey]);

  useEffect(() => {
    if (loadedSubtitleTimingKey !== subtitleTimingKey) return;
    window.localStorage.setItem(subtitleTimingKey, JSON.stringify(subtitleTiming));
  }, [loadedSubtitleTimingKey, subtitleTiming, subtitleTimingKey]);

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string }>).detail;
      if (!detail?.userId || detail.userId === preferenceScope) setPreferencesRevision((value) => value + 1);
    };
    window.addEventListener(APP_PREFERENCES_EVENT, sync);
    return () => window.removeEventListener(APP_PREFERENCES_EVENT, sync);
  }, [preferenceScope]);

  // `preferencesRevision` is intentionally read here: it makes an open player
  // react immediately after the settings dialog saves, while keeping the
  // preferences themselves in a tiny per-user localStorage record.
  void preferencesRevision;

  const subtitleTracks: SubtitleTrack[] = (() => {
    const byUrl = new Map<string, SubtitleTrack>();
    const add = (raw: any, index: number) => {
      const url = String(raw?.url || raw?.src || '').trim();
      // Subtitle URLs must be our own normalized WebVTT proxy paths. This
      // prevents provider pages/CDNs from being exposed to the player.
      if (!/^\/api\/v1\/subtitles\/file\/[a-f0-9]{32}\.vtt(?:\?.*)?$/i.test(url) || byUrl.has(url)) return;
      byUrl.set(url, {
        id: String(raw?.id || `subtitle-${index}`),
        label: String(raw?.label || raw?.language || 'Subtítulo'),
        language: String(raw?.language || raw?.lang || 'und'),
        url,
        src: raw?.src,
        is_default: Boolean(raw?.is_default || raw?.default),
      });
    };
    (props.subtitleTracks || []).forEach(add);
    resolvedSubtitleTracks.forEach(add);
    (streamInfo?.subtitles || []).forEach(add);
    servers.flatMap((server) => server.subtitles || []).forEach(add);
    return [...byUrl.values()];
  })();
  const subtitleSignature = subtitleTracks.map((track) => `${track.id}:${track.url}`).join('|');
  const hasBurnedInSubtitles = servers[activeServerIndex]?.subtitle_mode === 'burned_in';
  const subtitleSourceUrl = (track: SubtitleTrack): string => backendUrl(track.url);

  const activeSubtitleTrack = activeSubtitleId === 'off'
    ? undefined
    : subtitleTracks.find((track) => track.id === activeSubtitleId);

  useEffect(() => {
    const track = activeSubtitleTrack;
    if (!track) {
      setActiveSubtitleCues([]);
      return;
    }

    const controller = new AbortController();
    setActiveSubtitleCues([]);
    fetch(subtitleSourceUrl(track), {
      signal: controller.signal,
      headers: { Accept: 'text/vtt, text/plain;q=0.9, */*;q=0.1' },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`subtitle_http_${response.status}`);
        return response.text();
      })
      .then((payload) => {
        if (!controller.signal.aborted) setActiveSubtitleCues(parseWebVttCues(payload));
      })
      .catch(() => {
        if (!controller.signal.aborted) setActiveSubtitleCues([]);
      });

    return () => controller.abort();
  }, [activeSubtitleId, subtitleSignature]);

  const subtitleClockTime = subtitleTimelineTime(currentTime, subtitleTiming);
  const visibleSubtitleText = activeSubtitleCues
    .filter((cue) => subtitleClockTime >= cue.startTime && subtitleClockTime < cue.endTime)
    .map((cue) => cue.text)
    .join('\n');

  useEffect(() => {
    const video = videoNode;
    if (!video) return;
    const selectedLabel = activeSubtitleTrack?.label;
    const customCuesLoaded = activeSubtitleCues.length > 0;
    Array.from(video.textTracks).forEach((track) => {
      track.mode = selectedLabel && !customCuesLoaded && track.label === selectedLabel ? 'showing' : 'disabled';
    });
  }, [activeSubtitleId, activeSubtitleCues.length, subtitleSignature, videoNode]);
  const activeServer = servers[activeServerIndex] || null;
  const renditionServers = servers
    .map((server, index) => ({ server, index }))
    .filter(({ server }) => Boolean(server.link_type || server.language || server.audio_language || server.subtitle_language));

  // Agrupar antes de pintar evita que una docena de mirrors del mismo idioma
  // convierta la barra de controles en un panel interminable. El primer
  // candidato conserva el orden/ranking del backend; los demás quedan
  // disponibles bajo demanda.
  const renditionGroups = (() => {
    const groups = new Map<string, Array<{ server: ScoredServer; index: number }>>();
    for (const entry of renditionServers) {
      const key = normalizedLanguageKey(entry.server.audio_language || entry.server.subtitle_language || entry.server.language);
      const list = groups.get(key) || [];
      list.push(entry);
      groups.set(key, list);
    }
    const preferred = appPreferences.preferredLanguages.map((language) => normalizedLanguageKey(language));
    return [...groups.entries()]
      .map(([key, items]) => ({ key, items }))
      .sort((left, right) => {
        const leftRank = preferred.indexOf(left.key);
        const rightRank = preferred.indexOf(right.key);
        return (leftRank < 0 ? 99 : leftRank) - (rightRank < 0 ? 99 : rightRank);
      });
  })();

  const subtitleGroups = (() => {
    const groups = new Map<string, SubtitleTrack[]>();
    for (const track of subtitleTracks) {
      const key = normalizedLanguageKey(track.language || track.label);
      const list = groups.get(key) || [];
      list.push(track);
      groups.set(key, list);
    }
    const preferred = appPreferences.preferredSubtitleLanguages.map((language) => normalizedLanguageKey(language));
    return [...groups.entries()]
      .map(([key, items]) => ({ key, items }))
      .sort((left, right) => {
        const leftRank = preferred.indexOf(left.key);
        const rightRank = preferred.indexOf(right.key);
        return (leftRank < 0 ? 99 : leftRank) - (rightRank < 0 ? 99 : rightRank);
      });
  })();

  const triggerEpisodeEnded = useCallback(() => {
    setHasEnded(true);
    setIsPlaying(false);
    if (props.onNextEpisode && appPreferences.autoPlayNextEpisode) {
      setNextCountdown(5);
    } else {
      setNextCountdown(null);
    }
  }, [props.onNextEpisode, appPreferences.autoPlayNextEpisode]);

  const handleRemoteEnded = useCallback(() => {
    triggerEpisodeEnded();
  }, [triggerEpisodeEnded]);

  // Google Cast (Chromecast) Integration
  const {
    isCasting,
    deviceName: castDeviceName,
    remoteCurrentTime: castCurrentTime,
    remoteDuration: castDuration,
    remoteIsPaused: castIsPaused,
    remoteLoadState: castLoadState,
    remoteLoadError: castLoadError,
    requestCastSession,
    endCastSession,
    loadMediaOnCast,
    castPlay,
    castPause,
    castStop,
    castSeek,
    castSetVolume,
    castSetMuted,
  } = useChromecast(undefined, handleRemoteEnded);

  const castLoadInFlightRef = useRef<{ attemptId: number; work: Promise<boolean> } | null>(null);
  const castPlaybackStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isCasting || !activeServer || castPlaybackStartRef.current === null) return;
    if (castCurrentTime > castPlaybackStartRef.current + 0.5) {
      setServerHealthMap((previous) => previous[activeServer.id] === 'online'
        ? previous
        : { ...previous, [activeServer.id]: 'online' });
      castPlaybackStartRef.current = null;
    }
  }, [isCasting, castCurrentTime, activeServer?.id]);

  const loadActiveServerOnCast = useCallback((resumeTime: number, candidateUrl?: string | null): Promise<boolean> => {
    if (!activeServer || activeServer.isEmbed || activeServer.notPlayable || isUnresolvedCanonical(activeServer.url)) {
      return Promise.resolve(false);
    }

    const attemptId = attemptIdRef.current;
    if (castLoadInFlightRef.current?.attemptId === attemptId) return castLoadInFlightRef.current.work;
    let work!: Promise<boolean>;
    work = (async () => {
      let castUrl = String(candidateUrl || activeSessionUrl || activeServer.url || '').trim();
      if (!castUrl) return false;
      castPlaybackStartRef.current = Math.max(resumeTime || 0, castCurrentTime || 0, currentTime || 0);

      if (shouldProxyForCast(activeServer, castUrl)) {
        setDeliveryState('requesting_proxy');
        const canonicalUrl = canonicalUrlOf(activeServer) || activeServer.url;
        const session = await api.requestProxySession(canonicalUrl, activeServer.resolution_id);
        if (attemptId !== attemptIdRef.current) {
          void api.closeProxySession(session.session_id);
          return false;
        }

        const previousSessionId = activeSessionIdRef.current;
        activeSessionIdRef.current = session.session_id;
        setActiveSessionUrl(backendUrl(session.playback_url));
        castUrl = backendUrl(session.playback_url);
        if (previousSessionId && previousSessionId !== session.session_id) {
          void api.closeProxySession(previousSessionId);
        }
      }

      const success = await loadMediaOnCast({
        url: castUrl,
        title: props.title || media?.title || 'MeriStream',
        seriesTitle: props.showTitle || media?.showTitle,
        poster: props.posterUrl || media?.poster_url,
        currentTime: Math.max(0, resumeTime || 0),
        subtitles: resolvedSubtitleTracks,
        activeSubtitleId: activeSubtitleId !== 'off' ? activeSubtitleId : null,
      });
      if (attemptId !== attemptIdRef.current) return false;

      if (success) {
        playbackConfirmedRef.current = true;
        setPlaybackError(null);
        setDeliveryState(/\/api\/v1\/playback\//i.test(castUrl) ? 'playing_proxy' : 'playing_direct');
      } else {
        setPlaybackError('Chromecast no pudo abrir esta fuente. Prueba otro servidor.');
        setDeliveryState('error');
      }
      return success;
    })().catch((error) => {
      if (attemptId === attemptIdRef.current) {
        console.warn('[Player] No se pudo preparar la fuente para Chromecast:', error);
        setPlaybackError('No se pudo preparar esta fuente para Chromecast.');
        setDeliveryState('error');
      }
      return false;
    }).finally(() => {
      if (castLoadInFlightRef.current?.work === work) castLoadInFlightRef.current = null;
    });

    castLoadInFlightRef.current = { attemptId, work };
    return work;
  }, [
    activeServer,
    activeSessionUrl,
    castCurrentTime,
    currentTime,
    loadMediaOnCast,
    props.title,
    media?.title,
    props.showTitle,
    media?.showTitle,
    props.posterUrl,
    media?.poster_url,
    resolvedSubtitleTracks,
    activeSubtitleId,
  ]);

  // Countdown timer para autoplay del siguiente episodio
  useEffect(() => {
    if (nextCountdown === null) return;
    if (nextCountdown <= 0) {
      setNextCountdown(null);
      props.onNextEpisode?.();
      return;
    }
    const timer = setTimeout(() => {
      setNextCountdown((prev) => (prev !== null ? prev - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [nextCountdown, props.onNextEpisode]);

  // Sincronizar medio con Chromecast al conectarse inicialmente
  const wasCastingRef = useRef(false);
  useEffect(() => {
    if (!wasCastingRef.current && isCasting) {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      if (activeServer?.url && !activeServer.isEmbed && !isUnresolvedCanonical(activeServer.url) && !activeServer.notPlayable) {
        const resumeTime = videoRef.current?.currentTime || currentTime || 0;
        console.log("[Player] Preparando fuente proxy para Chromecast al conectar sesión");
        void loadActiveServerOnCast(resumeTime, activeSessionUrl || activeServer.url);
      }
    }
    wasCastingRef.current = isCasting;
  }, [
    isCasting,
    activeServer,
    activeSessionUrl,
    loadActiveServerOnCast,
    currentTime,
  ]);

  // Al desconectar Chromecast, reanudar video local en la misma posición
  const prevIsCastingRef = useRef(false);
  useEffect(() => {
    if (prevIsCastingRef.current && !isCasting) {
      if (videoRef.current && castCurrentTime > 0) {
        videoRef.current.currentTime = castCurrentTime;
        videoRef.current.play().catch(() => {});
      }
    }
    prevIsCastingRef.current = isCasting;
  }, [isCasting, castCurrentTime]);

  useEffect(() => {
    if (!isCasting || castLoadState !== 'error') return;
    playbackConfirmedRef.current = false;
    setPlaybackError(castLoadError || 'Chromecast no pudo reproducir esta fuente.');
    setDeliveryState('error');
  }, [isCasting, castLoadState, castLoadError]);

  const qualityPreferenceKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (qualityLevels.length === 0) return;
    const key = `${preferenceScope}:${activeServer?.id || 'none'}`;
    if (qualityPreferenceKeyRef.current === key) return;
    qualityPreferenceKeyRef.current = key;
    if (appPreferences.defaultQuality === 'auto') return;
    const targetHeight = Number.parseInt(appPreferences.defaultQuality, 10);
    if (!Number.isFinite(targetHeight)) return;
    const eligible = qualityLevels.filter((level) => Number(level.height || 0) > 0 && Number(level.height) <= targetHeight);
    const preferred = eligible.sort((left, right) => Number(right.height || 0) - Number(left.height || 0))[0]
      || qualityLevels.find((level) => Number(level.height || 0) === targetHeight);
    if (!preferred) return;
    if (hlsRef.current) hlsRef.current.currentLevel = preferred.index;
    if (dashRef.current) {
      dashRef.current.setAutoSwitchQualityFor?.('video', false);
      dashRef.current.setQualityFor?.('video', preferred.index);
    }
    setActiveQuality(preferred.index);
    setCurrentResolutionLabel(preferred.label);
  }, [qualityLevels, preferenceScope, activeServer?.id, appPreferences.defaultQuality]);

  const userExplicitlySelectedSubtitlesRef = useRef<boolean>(false);
  const prevSubtitleSignatureRef = useRef<string>('');

  useEffect(() => {
    if (prevSubtitleSignatureRef.current !== subtitleSignature) {
      prevSubtitleSignatureRef.current = subtitleSignature;
      userExplicitlySelectedSubtitlesRef.current = false;
    }
    if (userExplicitlySelectedSubtitlesRef.current) return;
    if (subtitleTracks.length === 0) return;
    if (activeSubtitleId !== 'off') return;

    const preferred = appPreferences.preferredSubtitleLanguages
      .map((language) => normalizedLanguageKey(language));
    const track = subtitleTracks.find((candidate) => preferred.includes(normalizedLanguageKey(candidate.language || candidate.label)));
    if (track) setActiveSubtitleId(track.id);
  }, [subtitleSignature, appPreferences.preferredSubtitleLanguages.join(',')]);

  const rawTitle: string =
    props.title || media?.title || props.item?.title || props.result?.title || '';

  // Dedup título (defecto #7): "10 cosas que odio de ti - 10 cosas que odio
  // de ti" — cuando el nombre de la fuente/episodio repite el título base,
  // mostrarlo una sola vez. Nunca mostrar "undefined".
  const displayTitle = (() => {
    const parts = (rawTitle || '')
      .split(/\s+[-–—]\s+/)
      .map((p) => p.trim())
      .filter((p) => Boolean(p) && !/^undefined$/i.test(p));
    const deduped = parts.filter(
      (p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i
    );
    return deduped.join(' - ') || 'Reproduciendo Video';
  })();

  // Watch Party (Teleparty) Integration
  const [partyRoomCode, setPartyRoomCode] = useState<string | null>(() => {
    const raw = props.initialPartyRoomCode || props.partyRoomCode || null;
    return raw ? String(raw).toUpperCase().trim() : null;
  });
  const [isWatchPartyPanelOpen, setIsWatchPartyPanelOpen] = useState(Boolean(props.initialPartyRoomCode || props.partyRoomCode));
  const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);
  const [viewerLockToast, setViewerLockToast] = useState<string | null>(null);
  const viewerLockToastTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingPartyMediaRef = useRef<WatchPartyMedia | null>(null);
  const partyMediaRevisionRef = useRef(0);
  const [partyMediaRevision, setPartyMediaRevision] = useState(0);

  useEffect(() => {
    if (!nativeShell) return;
    const onNativeBack = (event: Event) => {
      const nativeEvent = event as CustomEvent;
      if (subtitleSettingsOpen) {
        nativeEvent.preventDefault();
        setSubtitleSettingsOpen(false);
        return;
      }
      // Mobile overflow is rendered inside the controls tree. Consume Android
      // Back here before any player/history navigation can run.
      if (activeMenu === 'more') {
        nativeEvent.preventDefault();
        setActiveMenu('none');
        setControlsVisible(true);
        return;
      }
      if (activeMenu !== 'none') {
        nativeEvent.preventDefault();
        setActiveMenu('none');
        return;
      }
      if (isWatchPartyPanelOpen) {
        nativeEvent.preventDefault();
        setIsWatchPartyPanelOpen(false);
        return;
      }
      if (isScreenLocked) {
        nativeEvent.preventDefault();
        setIsScreenLocked(false);
        setShowLockWidget(false);
      }
    };
    window.addEventListener('meristream:native-back', onNativeBack);
    return () => window.removeEventListener('meristream:native-back', onNativeBack);
  }, [nativeShell, subtitleSettingsOpen, activeMenu, isWatchPartyPanelOpen, isScreenLocked]);

  useEffect(() => {
    const propCode = props.initialPartyRoomCode || props.partyRoomCode;
    if (propCode) {
      const code = String(propCode).toUpperCase().trim();
      setPartyRoomCode(code);
      setIsWatchPartyPanelOpen(true);
    }
  }, [props.initialPartyRoomCode, props.partyRoomCode]);

  const showViewerLockNotice = useCallback((msg: string = 'Controlado por el anfitrión') => {
    setViewerLockToast(msg);
    if (viewerLockToastTimerRef.current) clearTimeout(viewerLockToastTimerRef.current);
    viewerLockToastTimerRef.current = setTimeout(() => {
      setViewerLockToast(null);
    }, 2500);
  }, []);

  const telepartyMedia = useMemo<WatchPartyMedia>(() => {
    return {
      showId: props.showId || null,
      tmdbId: props.tmdbId || null,
      episodeId: props.episodeId || null,
      episodeNumber: props.episodeNumber || null,
      title: displayTitle || props.title || media?.title || 'Contenido en vivo',
      kind: props.kind || (media as any)?.kind || 'movie',
      posterUrl: props.posterUrl || media?.poster_url || props.item?.poster_url || null,
      streamUrl: activeServer?.url || props.streamUrl || null,
      serverId: activeServer?.id || null,
      sourceSite: activeServer?.sourceSite || null,
      provider: activeServer?.provider || null,
      canonicalLocator: activeServer?.canonical_locator || activeServer?.original_url || null,
    };
  }, [props.showId, props.tmdbId, props.episodeId, props.episodeNumber, displayTitle, props.title, props.kind, props.posterUrl, props.streamUrl, props.item, media, activeServer]);

  const teleparty = useTeleparty({
    videoRef,
    roomCode: partyRoomCode,
    media: telepartyMedia,
    authToken: (props as any).authToken || getAuthToken(),
    onError: (err) => {
      console.error('[Teleparty]', err);
    },
    onMediaChange: (remoteMedia) => {
      // Queue the media update until the source list is available in this
      // player. The effect below then selects the matching server locally.
      pendingPartyMediaRef.current = remoteMedia;
      partyMediaRevisionRef.current += 1;
      setPartyMediaRevision(partyMediaRevisionRef.current);
    },
  });

  const isViewerMode = teleparty.isInRoom && !teleparty.isHost;

  const handleLeaveWatchParty = useCallback(() => {
    teleparty.disconnect();
    setPartyRoomCode(null);
    setIsWatchPartyPanelOpen(false);
  }, [teleparty]);

  const handleJoinWatchParty = useCallback((code: string) => {
    setPartyRoomCode(code.toUpperCase());
    setIsJoinModalOpen(false);
    setIsWatchPartyPanelOpen(true);
  }, []);

  // Helper para resetear el temporizador de ocultado de controles
  const showControlsTemporarily = useCallback(() => {
    if (isScreenLocked) return;
    setControlsVisible(true);
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => {
      if (isPlaying && activeMenu === 'none') {
        setControlsVisible(false);
      }
    }, 3200);
  }, [isPlaying, activeMenu, isScreenLocked]);

  const showLockWidgetTemporarily = useCallback(() => {
    setShowLockWidget(true);
    if (lockWidgetTimerRef.current) clearTimeout(lockWidgetTimerRef.current);
    lockWidgetTimerRef.current = setTimeout(() => {
      setShowLockWidget(false);
    }, 2800);
  }, []);

  const handleLockScreen = useCallback(() => {
    setIsScreenLocked(true);
    setActiveMenu('none');
    setControlsVisible(false);
    setShowLockWidget(true);
    if (lockWidgetTimerRef.current) clearTimeout(lockWidgetTimerRef.current);
    lockWidgetTimerRef.current = setTimeout(() => {
      setShowLockWidget(false);
    }, 2200);
  }, []);

  const handleUnlockScreen = useCallback(() => {
    setIsScreenLocked(false);
    setShowLockWidget(false);
    if (lockWidgetTimerRef.current) {
      clearTimeout(lockWidgetTimerRef.current);
      lockWidgetTimerRef.current = null;
    }
    setControlsVisible(true);
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => {
      if (isPlaying && activeMenu === 'none') {
        setControlsVisible(false);
      }
    }, 3200);
  }, [isPlaying, activeMenu]);

  // 3. PREVENTATIVE RENEWAL LOOP
  useEffect(() => {
    if (renewalTimerRef.current) clearTimeout(renewalTimerRef.current);
    const activeServer = servers[activeServerIndex];
    if (!activeServer || !isPlaying) return;

    if (shouldScheduleRenewal(activeServer, deliveryState)) {
      const deadline = activeServer.refresh_after!;
      const timeToRefresh = Math.max(5000, deadline - Date.now() - 30000); // 30s before deadline
      const attemptId = attemptIdRef.current;
      renewalTimerRef.current = setTimeout(async () => {
        if (attemptId !== attemptIdRef.current) return;
        console.log("[Player] Renovación preventiva directa...");
        try {
          const originalUrl = canonicalUrlOf(activeServer) || activeServer.url;
          const res = await api.resolveEmbed(originalUrl);
          if (attemptId !== attemptIdRef.current) return;
          if (res.resolved && res.url) {
            setServers((prev) => {
              const copy = [...prev];
              if (copy[activeServerIndex]) {
                copy[activeServerIndex] = updateRenewedServer(copy[activeServerIndex], {
                  url: res.url,
                  original_url: res.original_url,
                  canonical_locator: res.canonical_locator,
                  resolution_id: res.resolution_id,
                  generation: res.generation,
                  delivery_mode: res.delivery_mode,
                  is_proxyable: res.is_proxyable,
                  is_refreshable: res.is_refreshable,
                  refresh_after: res.refresh_after,
                  expires_at: res.expires_at,
                  resolved_at: res.resolved_at,
                  failure_reason: res.failure_reason,
                  requiredHeaders: res.requiredHeaders,
                });
              }
              return copy;
            });

            // Conservar la posición y recargar la fuente una sola vez.
            const currentPos = videoRef.current?.currentTime || 0;
            const wasPlaying = !videoRef.current?.paused;
            if (hlsRef.current && res.url !== activeServer.url) {
              hlsRef.current.loadSource(res.url);
              if (currentPos > 0) videoRef.current!.currentTime = currentPos;
              if (wasPlaying) videoRef.current!.play().catch(() => {});
            } else if (dashRef.current && res.url !== activeServer.url) {
              // dash.js no expone un `loadSource` estable entre versiones;
              // reiniciar la instancia conserva el mismo punto de reanudación
              // y vuelve a construir el grafo con el manifiesto renovado.
              dashRef.current.reset?.();
              dashRef.current = null;
              attachSource(res.url);
            }
          }
        } catch (_err) {
          console.error("Fallo al renovar JIT", _err);
        }
      }, timeToRefresh);
    }
  }, [servers, activeServerIndex, deliveryState, isPlaying]);

  // 1. RECOPILACIÓN, CALIFICACIÓN Y AUTO-SELECCIÓN DEL MEJOR SERVIDOR
  // INICIALIZACIÓN ESTABLE (defecto #11): no se reconstruye la lista ni se vuelve
  // al índice 0 en cada render por cambios de identidad de props.all_streams.
  // Solo se re-ordena/re-sitúa cuando la firma real de las URLs cambia.
  const candidateSignatureRef = useRef<string>('');

  useEffect(() => {
    let cancelled = false;
    setIsLoadingStream(props.isLoading === true);
    setLoadError(null);
    setResolvedSubtitleTracks([]);
    setHasEnded(false);
    setNextCountdown(null);

    if (props.isLoading) {
      return;
    }

    if (props.loadError) {
      setIsLoadingStream(false);
      setLoadError(props.loadError);
      return;
    }

    let candidateServers: ScoredServer[] = [];

    // 1. Construcción directa desde ranked_streams si existen
    if (props.ranked_streams && props.ranked_streams.length > 0) {
      candidateServers = prioritizeDirectCandidates(
        props.ranked_streams.map((r, idx) => scoredServerFromRanked(r, idx)),
      );
    } else {
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
          ].filter(Boolean) as string[]
        )
      );

      if (allCandidateUrls.length > 0) {
        candidateServers = applyBackendTiers(rankAndSortServers(allCandidateUrls), props.ranked_streams);
      }
    }

    if (candidateServers.length > 0) {
      const ranked = candidateServers;
      const signature = serversStableSignature(ranked);

      if (candidateSignatureRef.current !== signature) {
        candidateSignatureRef.current = signature;
        jitRetryCountsRef.current.clear();
        jitCompletedRef.current.clear();
        setServers(ranked);
        const firstPlayableIdx = ranked.findIndex((s) =>
          !isExpiredWithoutLocator(s) && !s.notPlayable && !s.isEmbed && isNativeMediaUrl(s.url)
        );
        setActiveServerIndex(firstPlayableIdx >= 0 ? firstPlayableIdx : 0);
      }
      setIsLoadingStream(false);

      // Ninguna fuente se muestra como disponible hasta que este reproductor
      // consiga avanzar de verdad; el ping solo se conserva como dato de latencia.
      const initialMap: Record<string, 'online' | 'checking' | 'unverified' | 'failed'> = {};
      ranked.forEach((s) => {
        initialMap[s.id] = 'unverified';
      });
      setServerHealthMap(initialMap);

      const probeCandidates = ranked.slice(0, MAX_PROBE_CANDIDATES);
      probeCandidates.forEach((srv) => {
        if (!srv.isEmbed && !srv.notPlayable) {
          quickProbeServerHealth(srv, 2500).then((lat) => {
            if (!cancelled && lat !== null) {
              setServers((prev) => {
                const targetIdx = prev.findIndex((p) => p.id === srv.id);
                if (targetIdx !== -1) {
                  const copy = [...prev];
                  copy[targetIdx] = { ...copy[targetIdx], latencyMs: lat };
                  return copy;
                }
                return prev;
              });
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
          setResolvedSubtitleTracks(info.subtitles || []);

          const variantUrls = info.variants?.map((v: MediaStreamVariant) => v.url) || [];
          const masterUrl = (info as any).master_m3u8;
          const fallbackUrl = (info as any).fallback_mp4;

          const collected = Array.from(
            new Set([masterUrl, fallbackUrl, ...variantUrls].filter(Boolean))
          );

          const ranked = rankAndSortServers(collected);
          const signature = serversStableSignature(ranked);
          if (candidateSignatureRef.current !== signature) {
            candidateSignatureRef.current = signature;
            setServers(ranked);
            setActiveServerIndex(0);
          }

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
    // applyJitResolution depende del estado servers y cambiaría en cada tick:
    // se omite para que este efecto solo corra al cambiar la fuente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media?.id, directSource, props.streamUrl, props.src, props.isLoading, props.loadError]);

  // RE-RESOLVE JUST-IN-TIME (defecto #11): los HLS firmados guardados en BD
  // expiran antes del play (403 al abrir horas/minutos después) y las páginas
  // /ver/<slug>-<n> nunca fueron media. Antes de dar play, se re-resuelven en
  // caliente vía episode-servers/resolve-embed. Se intenta UNA vez por servidor.
  const jitInFlightRef = useRef<Set<string>>(new Set());
  const jitCompletedRef = useRef<Set<string>>(new Set());

  // Resolver únicamente el servidor activo. Esto evita que una fuente vencida
  // del índice 0 sobrescriba o dispare failover sobre otro candidato que el
  // usuario ya eligió.
  useEffect(() => {
    const server = activeServer;
    if (!server) return;

    const signedNeedsJit =
      hasExpiringSignature(server.url) &&
      (!server.expires_at || server.expires_at <= Date.now()) &&
      !server.resolved_at;

    // Los locators de stream de proveedor (por ejemplo ZokoAnime `/stream/...`)
    // son embeds aunque no coincidan con las rutas canónicas genéricas. También
    // deben pasar por la resolución JIT antes de tocar HLS.js.
    const needsJit = (server.isEmbed && !isNativeMediaUrl(server.url)) ||
      server.notPlayable === true || isUnresolvedCanonical(server.url) || signedNeedsJit;
    if (!needsJit) {
      setCanonicalResolveError(null);
      return;
    }

    const locator = canonicalUrlOf(server) || server.url;
    const jitKey = `${server.id}|${locator}`;
    if (jitInFlightRef.current.has(jitKey) || jitCompletedRef.current.has(jitKey)) return;

    const attemptId = attemptIdRef.current;
    const targetId = server.id;
    const targetIndex = activeServerIndex;
    let cancelled = false;
    jitInFlightRef.current.add(jitKey);
    jitCompletedRef.current.add(jitKey);
    setServerHealthMap((previous) => ({ ...previous, [targetId]: 'checking' }));
    setCanonicalResolveError(null);
    setDeliveryState('resolving');

    // Las páginas canónicas de episodio necesitan el adaptador del proveedor
    // (AnimeFLV/TioAnime/Cinecalidad/etc.), no el resolver genérico de embeds.
    // Ese endpoint sigue siendo JIT y no escribe en la BD, pero sí ejecuta la
    // receta correcta de catálogo → episodio → media.
    const resolutionPromise = isUnresolvedCanonical(locator)
      ? api.getEpisodeServers(locator).then(async (episodeResult) => {
          const isMediaUrl = (value: string) => isNativeMediaUrl(value);
          const ranked = Array.isArray(episodeResult.ranked_streams) ? episodeResult.ranked_streams : [];
          const first = ranked.find((candidate) => candidate?.url && candidate.type !== 'embed' && isMediaUrl(candidate.url));
          const streamUrl = typeof episodeResult.stream_url === 'string' ? episodeResult.stream_url : '';
          const resolvedUrl = first?.url || (isMediaUrl(streamUrl) ? streamUrl : '');
          const resolved = Boolean(episodeResult.resolved && resolvedUrl && resolvedUrl !== locator && isMediaUrl(resolvedUrl));
          const pageResolution = {
            url: resolved ? resolvedUrl : locator,
            original_url: locator,
            canonical_locator: locator,
            resolved,
            type: resolved && first?.type !== 'embed' ? 'direct' as const : 'embed' as const,
            delivery_mode: resolved && first?.type !== 'embed' ? 'direct_trial' as const : 'embed' as const,
            is_proxyable: resolved,
            is_refreshable: true,
            resolution_id: first?.resolution_id,
            generation: first?.generation,
            refresh_after: first?.refresh_after,
            expires_at: first?.expires_at,
            resolved_at: first?.resolved_at,
            provider: first?.provider,
            requiredHeaders: first?.requiredHeaders || episodeResult.requiredHeaders,
            extraStreams: ranked,
            subtitles: first?.subtitles?.flatMap((track) => {
              const src = track.src || track.url;
              return src ? [{ ...track, src }] : [];
            }),
          } as PlaybackResolution & { extraStreams?: any[] };
          if (resolved) return pageResolution;

          // Algunas páginas canónicas son en realidad reproductores terminales
          // (por ejemplo un mirror de GNULA) y no exponen una lista de episodios.
          // Si el extractor de catálogo no encuentra nada, probar el resolutor
          // de embeds con el mismo locator antes de marcarlo como caído.
          try {
            const embedResolution = await api.resolveEmbed(locator);
            if (embedResolution.resolved && embedResolution.url) return embedResolution;
          } catch {
            // Se conserva el diagnóstico del endpoint especializado.
          }
          return pageResolution;
        })
      : api.resolveEmbed(locator);

    const retryJitOnceBeforeFailover = (): boolean => {
      const previous = jitRetryCountsRef.current.get(jitKey) || 0;
      if (previous >= 1) return false;
      jitRetryCountsRef.current.set(jitKey, previous + 1);
      jitInFlightRef.current.delete(jitKey);
      jitCompletedRef.current.delete(jitKey);
      setServers((prev) => prev.map((candidate) =>
        candidate.id === targetId
          ? { ...candidate, notPlayable: false, failure_reason: undefined }
          : candidate
      ));
      setCanonicalResolveError('Reintentando la fuente principal…');
      setDeliveryState('resolving');
      return true;
    };

    resolutionPromise
      .then((res: any) => {
        if (cancelled || attemptId !== attemptIdRef.current) return;

        if (res.failure_reason === 'expired_without_locator') {
          setServers((prev) => prev.map((candidate) =>
            candidate.id === targetId ? { ...applyResolution(candidate, res), notPlayable: true } : candidate
          ));
          setCanonicalResolveError(MSG_EXPIRED_WITHOUT_LOCATOR);
          setDeliveryState('error');
          if (targetIndex < servers.length - 1) {
            handleServerChange(targetIndex + 1, true);
          } else {
            setPlaybackError(MSG_EXPIRED_WITHOUT_LOCATOR);
          }
          return;
        }

        if (!res.resolved || !res.url) {
          // Un fallo transitorio no debe bloquear para siempre el botón de
          // reintento: reintentar una vez la misma fuente antes de pasar al
          // siguiente proveedor evita el patrón "primer servidor falla,
          // segundo también, primer servidor sí funciona al volver a pulsar".
          if (retryJitOnceBeforeFailover()) return;
          jitCompletedRef.current.delete(jitKey);
          setCanonicalResolveError('No se pudo extraer un stream reproducible de esta fuente.');
          setDeliveryState('error');
          setServerHealthMap((previous) => ({ ...previous, [targetId]: 'failed' }));
          setServers((prev) => prev.map((candidate) =>
            candidate.id === targetId ? { ...candidate, notPlayable: true, failure_reason: 'unresolved' } : candidate
          ));
          if (targetIndex < servers.length - 1) {
            handleServerChange(targetIndex + 1, true);
          } else {
            setPlaybackError(MSG_NO_SERVERS);
          }
          return;
        }

        setServers((prev) => {
          let updated = prev.map((candidate) => {
            if (candidate.id !== targetId) return candidate;
            return { ...applyResolution(candidate, res), notPlayable: false };
          });

          // Si la resolución trajo streams reales para esta fuente/plataforma,
          // eliminamos cualquier otro placeholder de página no resuelta de la misma plataforma
          const targetPlatform = server.sourceSite || server.provider || (server as any).platform || (server as any).source_site;
          if (targetPlatform) {
            updated = updated.filter((c) => {
              if (c.id === targetId) return true;
              const cPlatform = c.sourceSite || c.provider || (c as any).platform || (c as any).source_site;
              if (cPlatform && String(cPlatform).toLowerCase() === String(targetPlatform).toLowerCase() && isUnresolvedCanonical(c.url)) {
                // No quitar candidatos que están antes del servidor activo:
                // hacerlo desplaza activeServerIndex y puede dejar al player
                // apuntando a una fuente distinta después del failover.
                const originalIndex = prev.findIndex((candidate) => candidate.id === c.id);
                return originalIndex >= 0 && originalIndex <= targetIndex;
              }
              return true;
            });
          }

          if (Array.isArray(res.extraStreams) && res.extraStreams.length > 1) {
            const extra = res.extraStreams.slice(1);
            const existingUrls = new Set(updated.map((s) => s.url));
            const existingHosts = new Set(
              updated.map((s) => {
                try {
                  const h = new URL(s.url).hostname.replace(/^www\./, "");
                  const parts = h.split(".");
                  return parts.length >= 2 ? parts.slice(-2).join(".") : h;
                } catch {
                  return s.provider || "";
                }
              }).filter(Boolean)
            );

            for (const r of extra) {
              if (!r?.url || existingUrls.has(r.url)) continue;
              let hostFamily = "";
              try {
                const h = new URL(r.url).hostname.replace(/^www\./, "");
                const parts = h.split(".");
                hostFamily = parts.length >= 2 ? parts.slice(-2).join(".") : h;
              } catch {
                hostFamily = r.provider || "";
              }
              if (hostFamily && existingHosts.has(hostFamily)) {
                // Mismo host/familia que ya tenemos -> descartar duplicado
                continue;
              }
              existingUrls.add(r.url);
              if (hostFamily) existingHosts.add(hostFamily);
              updated.push(scoredServerFromRanked(r, updated.length));
              // Máximo 1 servidor alternativo extra por resolución de proveedor
              break;
            }
          }

          return updated;
        });
        setCanonicalResolveError(null);
      })
      .catch(() => {
        if (cancelled || attemptId !== attemptIdRef.current) return;
        // La fuente puede recuperarse cuando el proveedor vuelve a responder.
        // No memorizamos este fallo como una resolución permanente.
        if (retryJitOnceBeforeFailover()) return;
        jitCompletedRef.current.delete(jitKey);
        setCanonicalResolveError(
          isUnresolvedCanonical(server.url)
            ? 'No se pudo contactar al resolutor. Puedes probar otro servidor.'
            : 'No se pudo renovar esta fuente.'
        );
        setDeliveryState('error');
        setServerHealthMap((previous) => ({ ...previous, [targetId]: 'failed' }));
      })
      .finally(() => {
        jitInFlightRef.current.delete(jitKey);
      });

    return () => {
      cancelled = true;
    };
  }, [activeServer?.id, activeServer?.url, activeServer?.isEmbed, activeServer?.notPlayable, activeServer?.canonical_locator, activeServerIndex, servers.length, canonicalResolveError]);

  // 2. CAMBIO DE SERVIDOR MANUAL O POR FAILOVER AUTOMÁTICO
  const handleServerChange = (index: number, isAutoFailover = false, isPartySync = false) => {
    if (!isAutoFailover && !isPartySync && teleparty.isInRoom && !teleparty.isHost) {
      showViewerLockNotice('El anfitrión controla el servidor de la sala');
      return;
    }
    if (index === activeServerIndex && !isAutoFailover) return;
    if (index >= servers.length || index < 0) return;

    setServerHealthMap((previous) => ({ ...previous, [servers[index].id]: 'checking' }));

    // Protección contra carreras: invalidar TODOS los temporizadores/promesas del
    // intento anterior (punto 6 y 7).
    attemptIdRef.current += 1;
    const targetIndex = index;
    const currentPosition = isCasting ? (castCurrentTime || currentTime) : (videoRef.current?.currentTime || currentTime);
    if (Number.isFinite(currentPosition) && currentPosition > 0.5) {
      pendingResumeTimeRef.current = currentPosition;
    }

    if (directWatchdogRef.current) clearTimeout(directWatchdogRef.current);
    if (renewalTimerRef.current) clearTimeout(renewalTimerRef.current);
    if (blackScreenTimerRef.current) clearTimeout(blackScreenTimerRef.current);
    if (stallFailoverTimerRef.current) {
      clearTimeout(stallFailoverTimerRef.current);
      stallFailoverTimerRef.current = null;
    }
    proxyRequestInFlightRef.current = false;
    const previousSessionId = activeSessionIdRef.current;
    activeSessionIdRef.current = null;
    if (previousSessionId) void api.closeProxySession(previousSessionId);
    setActiveSessionUrl(null);
    playbackConfirmedRef.current = false;
    loadStartMsRef.current = Date.now();
    setHasEnded(false);
    setNextCountdown(null);

    const currentSrv = servers[activeServerIndex];
    if (isAutoFailover && !isPartySync && currentSrv) {
      api.reportPlayerEvent({
        eventType: "failover_auto",
        provider: currentSrv.provider || "Servidor",
        serverUrl: currentSrv.url,
        mediaTitle: props.title || media?.title,
        details: `Auto-failover hacia ${servers[index]?.provider || 'siguiente'}`,
      });

      if (autoFailoverCountRef.current >= servers.length) {
        setDeliveryState('error');
        setPlaybackError(MSG_NO_SERVERS);
        return;
      }
      autoFailoverCountRef.current += 1;
    } else {
      // Selección manual del usuario: resetear contador e historial de modos intentados
      autoFailoverCountRef.current = 0;
      attemptedModesRef.current.clear();
      // Permitir reintentar una resolución JIT si el usuario vuelve a elegir
      // manualmente la fuente después de un error transitorio.
      jitCompletedRef.current.clear();
      jitRetryCountsRef.current.clear();
    }

    // Destruir la instancia HLS anterior y eliminar listeners nativos pendientes.
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (dashRef.current) {
      dashRef.current.reset?.();
      dashRef.current = null;
    }
    if (nativeListenersCleanupRef.current) {
      nativeListenersCleanupRef.current();
      nativeListenersCleanupRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }

    if (isCasting) {
      castStop();
    }

    setPlaybackError(null);
    setHasEnded(false);
    setIsPlaying(false);
    setQualityLevels([]);
    setActiveQuality(-1);
    setAudioTracks([]);
    setActiveAudioTrack(-1);
    setActiveMenu('none');

    if (isAutoFailover && !isPartySync) {
      const targetSrv = servers[targetIndex];
      setFailoverNotice(`Conectando automáticamente a servidor de respaldo (${targetSrv?.label || 'Respaldo'})...`);
      setTimeout(() => setFailoverNotice(null), 3000);
    } else {
      jitInFlightRef.current.clear();
    }

    const targetSrv = servers[targetIndex];
    const isTargetPlayable = Boolean(
      targetSrv && !targetSrv.isEmbed && !isUnresolvedCanonical(targetSrv.url) && !targetSrv.notPlayable
    );

    lastAttachmentKey.current = '';
    setActiveServerIndex(targetIndex);

    if (isTargetPlayable && targetSrv?.url) {
      attachSource(targetSrv.url);
    }
  };

  const serverMatchesPartyMedia = useCallback((server: ScoredServer, remote: WatchPartyMedia) => {
    const normalize = (value: unknown) => String(value || '').trim().toLowerCase();
    if (remote.serverId && normalize(server.id) === normalize(remote.serverId)) return true;
    if (remote.canonicalLocator && normalize(server.canonical_locator || server.original_url) === normalize(remote.canonicalLocator)) return true;
    if (remote.streamUrl && normalize(server.url) === normalize(remote.streamUrl)) return true;
    const remoteSite = normalize(remote.sourceSite);
    const remoteProvider = normalize(remote.provider);
    if (remoteSite && normalize(server.sourceSite) === remoteSite && remoteProvider && normalize(server.provider) === remoteProvider) return true;
    return false;
  }, []);

  // Apply a host-selected server to every viewer. The third argument keeps the
  // change silent: it is a room instruction, not an automatic failover.
  useEffect(() => {
    const remoteMedia = pendingPartyMediaRef.current;
    if (!remoteMedia || !teleparty.isInRoom || servers.length === 0) return;
    if (teleparty.isHost) {
      pendingPartyMediaRef.current = null;
      return;
    }
    const targetIndex = servers.findIndex((server) => serverMatchesPartyMedia(server, remoteMedia));
    if (targetIndex < 0 || targetIndex === activeServerIndex) return;
    pendingPartyMediaRef.current = null;
    handleServerChange(targetIndex, false, true);
  }, [partyMediaRevision, teleparty.isInRoom, teleparty.isHost, servers, activeServerIndex, serverMatchesPartyMedia]);

  const partyServerKey = activeServer
    ? String(activeServer.id || activeServer.canonical_locator || activeServer.original_url || activeServer.url || '')
    : '';
  const lastPartyServerKeyRef = useRef<string | null>(null);

  // Publish manual source changes made by the host. The initial key is only
  // remembered so room creation does not emit a duplicate CHANGE_MEDIA.
  useEffect(() => {
    if (!teleparty.isInRoom || !teleparty.isConnected || !teleparty.isHost || !partyServerKey) return;
    const previousKey = lastPartyServerKeyRef.current;
    lastPartyServerKeyRef.current = partyServerKey;
    if (previousKey && previousKey !== partyServerKey) {
      teleparty.syncMedia(telepartyMedia);
    }
  }, [partyServerKey, teleparty.isInRoom, teleparty.isConnected, teleparty.isHost, teleparty.syncMedia, telepartyMedia]);

  // 3. CONEXIÓN NATIVA AL STREAM CON HLS.JS (SELECCIONANDO MÁXIMA CALIDAD AL INSTANTE)
  const attachSource = useCallback((url: string) => {
    const video = videoRef.current;
    if (!url || activeServer?.isEmbed) return;
    if (!isCasting && !video) return;

    // Las páginas canónicas y candidatos marcados como no reproducibles solo
    // pueden pasar por el resolutor JIT; nunca deben llegar a HLS.js como si
    // fueran un manifiesto. La rama de expiración sí se evalúa primero para
    // poder saltar una URL firmada vencida cuando corresponda.
    if (isExpiredWithoutLocator(activeServer)) {
      if (activeServerIndex < servers.length - 1) {
        handleServerChange(activeServerIndex + 1, true);
      } else {
        setDeliveryState('error');
        setPlaybackError(MSG_EXPIRED_WITHOUT_LOCATOR);
      }
      return;
    }
    if (activeServer?.notPlayable || isUnresolvedCanonical(activeServer.url)) {
      setDeliveryState('resolving');
      return;
    }

    // Protección contra carreras: este intento pertenece al attemptId actual.
    const attemptId = attemptIdRef.current;

    if (blackScreenTimerRef.current) clearTimeout(blackScreenTimerRef.current);
    if (directWatchdogRef.current) clearTimeout(directWatchdogRef.current);
    playbackConfirmedRef.current = false;
    loadStartMsRef.current = Date.now();

    // Watchdog de pantalla negra: una espera larga no se considera un error
    // fatal. Se pide una decisión explícita antes de probar otra fuente.
    blackScreenTimerRef.current = setTimeout(() => {
      if (attemptId !== attemptIdRef.current) return;
      if (!playbackConfirmedRef.current && activeServer) {
        api.reportPlayerEvent({
          eventType: "black_screen_stalled",
          provider: activeServer.provider || "Servidor",
          serverUrl: activeServer.url,
          mediaTitle: props.title || media?.title,
          durationBeforeErrorMs: Date.now() - loadStartMsRef.current,
          details: "El reproductor esperó >6.5s sin recibir frames ni iniciar reproducción (pantalla negra)",
        });
        requestManualServerChoice('Este servidor está tardando en responder. ¿Quieres probar otro servidor?');
      }
    }, DIRECT_BLACK_SCREEN_MS);

    setPlaybackError(null);
    setQualityLevels([]);
    setActiveQuality(-1);
    setCurrentResolutionLabel(activeServer?.quality || 'Auto HD');

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const currentTitle = props.title || media?.title || '';
    const currentProv = activeServer?.provider || 'Servidor';

    const markNativePlaybackStarted = () => {
      if (directWatchdogRef.current) clearTimeout(directWatchdogRef.current);
      playbackConfirmedRef.current = true;
      setPlaybackError(null);
      setDeliveryState('playing_direct');
    };

    const setupDash = async (playUrl: string) => {
      if (!video) return;
      try {
        const dashModule: any = await import('dashjs');
        if (attemptId !== attemptIdRef.current) return;
        const dashApi = dashModule.default ?? dashModule;
        const player = dashApi.MediaPlayer().create();
        dashRef.current = player;
        player.initialize(video, playUrl, true);
        player.on?.('streamInitialized', () => {
          if (attemptId !== attemptIdRef.current) return;

          const bitrates = player.getBitrateInfoListFor?.('video') || [];
          const levels = bitrates.map((bitrate: any, index: number) => ({
            index,
            label: bitrate.height
              ? `${bitrate.height}p`
              : `${Math.round((bitrate.bitrate || 0) / 1000)} kbps`,
            height: bitrate.height,
          }));
          setQualityLevels(levels);
          if (levels.length > 0) setCurrentResolutionLabel('Auto HD');

          const tracks = player.getTracksFor?.('audio') || [];
          if (tracks.length > 0) {
            setAudioTracks(tracks.map((track: any, index: number) => ({
              id: index,
              name: track.lang || track.labels?.[0]?.text || `Pista ${index + 1}`,
              lang: track.lang,
            })));
            const currentTrack = player.getCurrentTrackFor?.('audio');
            const currentIndex = currentTrack ? tracks.indexOf(currentTrack) : 0;
            setActiveAudioTrack(currentIndex >= 0 ? currentIndex : 0);
          }

          const resumeTime = pendingResumeTimeRef.current ?? props.initialTime;
          if (resumeTime && resumeTime > 0) {
            video.currentTime = resumeTime;
            pendingResumeTimeRef.current = null;
          }
          video.play().catch(() => {});
        });
        player.on?.('playbackStarted', () => {
          if (attemptId !== attemptIdRef.current) return;
          markNativePlaybackStarted();
        });
        player.on?.('error', () => {
          if (attemptId !== attemptIdRef.current) return;
          setServerHealthMap((prev) => ({ ...prev, [activeServer?.id || '']: 'failed' }));
          if (activeServerIndex < servers.length - 1) handleServerChange(activeServerIndex + 1, true);
          else {
            setDeliveryState('error');
            setPlaybackError(MSG_NO_SERVERS);
          }
        });
      } catch {
        if (attemptId !== attemptIdRef.current) return;
        if (activeServerIndex < servers.length - 1) handleServerChange(activeServerIndex + 1, true);
        else {
          setDeliveryState('error');
          setPlaybackError('El manifiesto DASH no pudo reproducirse en este navegador.');
        }
      }
    };

    const setupHls = async (playUrl: string) => {
      if (!video) return;
      const isHlsUrl = playUrl.includes('.m3u8') || playUrl.includes('/m3u8/');
      if (!isHlsUrl) return;

      // Native HLS (Safari / WebViews that expose it) should not download
      // hls.js at all. Android WebView normally falls through to the lazy
      // import below.
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playUrl;
        return;
      }

      try {
        const hlsModule = await import('hls.js');
        if (attemptId !== attemptIdRef.current) return;
        const HlsCtor = hlsModule.default;
        if (!HlsCtor.isSupported()) {
          video.src = playUrl;
          return;
        }

        const deviceMemory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory || 8);
        const constrainedDevice = (navigator.hardwareConcurrency || 8) <= 4 || deviceMemory <= 4;
        const hls = new HlsCtor({
          enableWorker: true,
          lowLatencyMode: false,
          // Mantener menos segmentos en memoria en equipos modestos reduce
          // presión de RAM sin sacrificar el margen suficiente para evitar
          // microcortes. HLS.js seguirá ampliando el buffer si la red lo pide.
          backBufferLength: constrainedDevice ? 20 : 45,
          maxBufferLength: constrainedDevice ? 18 : 30,
          startLevel: -1,
          capLevelToPlayerSize: true,
          xhrSetup: (xhr, requestUrl) => {
            if (requestUrl.includes('/api/v1/proxy/stream') || requestUrl.includes('localhost') || requestUrl.includes('127.0.0.1')) {
              if (currentTitle) xhr.setRequestHeader('X-Media-Title', encodeURIComponent(currentTitle));
              if (currentProv) xhr.setRequestHeader('X-Media-Provider', encodeURIComponent(currentProv));
            }
          }
        });

        hlsRef.current = hls;
        hls.loadSource(playUrl);
        hls.attachMedia(video);

        const handleManifestParsed = (_evt: any, data: any) => {
          if (attemptId !== attemptIdRef.current) return;
          if (directWatchdogRef.current) clearTimeout(directWatchdogRef.current);
          playbackConfirmedRef.current = true;
          setPlaybackError(null);
          setDeliveryState(prev => prev === 'trying_direct' ? 'playing_direct' : prev);

          const levels: { index: number; label: string; height?: number }[] = data.levels.map((lvl: Level, idx: number) => ({
            index: idx,
            label: lvl.height ? `${lvl.height}p` : `${Math.round((lvl.bitrate ?? 0) / 1000)} kbps`,
            height: lvl.height,
          }));

          setQualityLevels(levels);

          if (levels.length > 0) {
            setCurrentResolutionLabel('Auto HD');
          }

          const resumeTime = pendingResumeTimeRef.current ?? props.initialTime;
          if (resumeTime && resumeTime > 0) {
            video.currentTime = resumeTime;
            pendingResumeTimeRef.current = null;
          }

          video.play().then(() => {
            if (attemptId !== attemptIdRef.current) return;
            setDeliveryState(prev => {
              if (prev === 'playing_direct' && activeServer) {
                setDeliveryCapability(url, 'direct_ok', activeServer.provider);
              }
              return prev;
            });
          }).catch(() => {
            setIsPlaying(false);
          });

          setTimeout(() => {
            if (attemptId !== attemptIdRef.current) return;
            if (video && !video.paused && video.currentTime === 0 && !playbackConfirmedRef.current && activeServer) {
              api.reportPlayerEvent({
                eventType: "playback_buffering",
                provider: activeServer.provider || "Servidor",
                serverUrl: activeServer.url,
                mediaTitle: currentTitle,
                details: "Video congelado en segundo 0 tras dar play (requiere adelantar o reintentar segmento inicial)",
              });
            }
          }, 3500);
        };

        const handleAudioTracksUpdated = (_evt: any, data: any) => {
          if (attemptId !== attemptIdRef.current) return;
          if (data.audioTracks && data.audioTracks.length > 1) {
            const audios: AudioOption[] = data.audioTracks.map((track: any, idx: number) => ({
              id: idx,
              name: track.name || track.lang || `Pista ${idx + 1}`,
              lang: track.lang,
            }));
            setAudioTracks(audios);
            setActiveAudioTrack(hls.audioTrack);
          }
        };

        const handleLevelSwitched = (_evt: any, data: any) => {
          if (attemptId !== attemptIdRef.current) return;
          const lvl = hls.levels[data.level];
          if (lvl && lvl.height) {
            setCurrentResolutionLabel(`${lvl.height}p ${lvl.height >= 1080 ? 'Full HD' : 'HD'}`);
          }
        };

        const droppedLevels = new Set<number>();
        const recoverUnavailableLevel = (data: any): boolean => {
          const detail = String(data?.details || '');
          const levelError = detail === 'levelLoadError' ||
            detail === 'levelLoadTimeOut' ||
            detail === 'levelParsingError' ||
            detail === 'levelEmptyError';
          if (!levelError || hls.levels.length <= 1) return false;
          const rawLevel = Number(data?.level ?? data?.context?.level);
          if (!Number.isInteger(rawLevel) || rawLevel < 0 || rawLevel >= hls.levels.length) return false;
          if (droppedLevels.has(rawLevel)) return false;
          droppedLevels.add(rawLevel);
          try {
            hls.removeLevel(rawLevel);
          } catch {
            return false;
          }
          if (hls.levels.length === 0) return false;
          const nextLevel = Math.max(0, Math.min(rawLevel - 1, hls.levels.length - 1));
          hls.nextLoadLevel = nextLevel;
          hls.loadLevel = nextLevel;
          hls.startLoad();
          setCurrentResolutionLabel('Auto HD');
          return true;
        };

        const handleHlsError = (_evt: any, data: any) => {
          if (attemptId !== attemptIdRef.current) return;
          if (!data.fatal) {
            if (data.details === 'bufferStalledError' || data.details === 'bufferNudgeOnStall') {
              bufferCountRef.current += 1;
              api.reportPlayerEvent({
                eventType: "playback_buffering",
                provider: activeServer?.provider || "Servidor",
                serverUrl: activeServer?.url || url,
                mediaTitle: currentTitle,
                bufferPauseCount: bufferCountRef.current,
                details: `HLS Buffer Stall (${data.details}): el reproductor tuvo que saltar un gap de datos`,
              });
            } else if (data.type === 'networkError') {
              api.reportPlayerEvent({
                eventType: "playback_buffering",
                provider: activeServer?.provider || "Servidor",
                serverUrl: activeServer?.url || url,
                mediaTitle: currentTitle,
                details: `Fallo de segmento HLS (${data.details}): reintentando descarga...`,
              });
            }
            return;
          }

          // HLS puede marcar como "fatal" un timeout de manifiesto o segmento.
          // La espera prolongada sigue siendo una decisión manual, igual que
          // el watchdog del directo; solo los errores fatales reales cambian de
          // servidor automáticamente.
          const hlsErrorText = `${String(data?.details || '')} ${String(data?.error?.message || '')}`;
          if (data.type === 'networkError' && /timeout|timed[ -]?out/i.test(hlsErrorText)) {
            api.reportPlayerEvent({
              eventType: "playback_buffering",
              provider: activeServer?.provider || "Servidor",
              serverUrl: activeServer?.url || url,
              mediaTitle: currentTitle,
              details: `HLS tardó demasiado en responder (${data.details || 'timeout'}); se solicita decisión manual`,
            });
            requestManualServerChoice('Este servidor está tardando en responder. ¿Quieres probar otro servidor?');
            return;
          }

          if (recoverUnavailableLevel(data)) {
            console.warn('HLS variant unavailable; continuing with a lower quality level', data.level);
            return;
          }

          if (data.type === 'mediaError' && !mediaRecoveryAttemptsRef.current.has(attemptId)) {
            mediaRecoveryAttemptsRef.current.add(attemptId);
            try {
              hls.recoverMediaError();
              api.reportPlayerEvent({
                eventType: "playback_buffering",
                provider: activeServer?.provider || "Servidor",
                serverUrl: activeServer?.url || url,
                mediaTitle: currentTitle,
                details: `HLS mediaError recuperable (${data.details}); se reintenta el mismo stream antes del failover`,
              });
              return;
            } catch (error) {
              console.warn('HLS media recovery failed; escalating', error);
            }
          }

          console.warn('HLS Fatal Error:', data.type, data.details);

          if (
            activeServer &&
            canEscalateToProxy(activeServer) &&
            !hasAttemptedMode(attemptedModesRef.current, activeServer.id, 'proxy')
          ) {
            setDeliveryCapability(url, 'proxy_required', activeServer.provider);
            setServers((prev) => {
              const copy = [...prev];
              if (copy[activeServerIndex]) {
                copy[activeServerIndex] = { ...copy[activeServerIndex], delivery_mode: 'proxy_required' };
              }
              return copy;
            });
            attachSource(url);
            return;
          }

          if (activeServer) {
            setServerHealthMap((prev) => ({ ...prev, [activeServer.id]: 'failed' }));
            api.reportPlayerEvent({
              eventType: "playback_error",
              provider: activeServer.provider || "Servidor",
              serverUrl: activeServer.url,
              mediaTitle: currentTitle,
              durationBeforeErrorMs: Date.now() - loadStartMsRef.current,
              details: `HLS fatal: ${data.type} - ${data.details}`,
            });
          }

          if (activeServerIndex < servers.length - 1) {
            const nextIdx = activeServerIndex + 1;
            setFailoverNotice(`Cambiando a ${servers[nextIdx]?.label || 'siguiente servidor'}...`);
            setTimeout(() => setFailoverNotice(null), 3000);
            handleServerChange(nextIdx, true);
          } else {
            setDeliveryState('error');
            setPlaybackError(MSG_NO_SERVERS);
          }
        };

        hls.on(HlsCtor.Events.MANIFEST_PARSED, handleManifestParsed);
        hls.on(HlsCtor.Events.AUDIO_TRACKS_UPDATED, handleAudioTracksUpdated);
        hls.on(HlsCtor.Events.LEVEL_SWITCHED, handleLevelSwitched);
        hls.on(HlsCtor.Events.ERROR, handleHlsError);
      } catch (error) {
        if (attemptId !== attemptIdRef.current) return;
        console.warn('No se pudo cargar hls.js; intentando reproducción nativa', error);
        video.src = playUrl;
      }
    }; // end setupHls

    // Direct-first & Proxy-on-demand logic
    // A provider locator is resolved by the JIT effect above. Do not treat the
    // unresolved embed as a failed playback attempt while that request is in
    // flight; doing so races the resolver and skips the preferred source.
    if (activeServer?.isEmbed || isUnresolvedCanonical(activeServer?.url)) {
      return;
    }
    const capability = getDeliveryCapability(url, activeServer?.provider);
    let finalUrl = backendUrl(url);

    // Hacia el proxy SOLO si una marca previa o la resolución lo exige
    const intent = nextDeliveryIntent(activeServer, capability);
    const canonicalUrl = canonicalUrlOf(activeServer) || url;

    if (intent === 'skip') {
      if (activeServerIndex < servers.length - 1) {
        handleServerChange(activeServerIndex + 1, true);
      } else {
        setDeliveryState('error');
        setPlaybackError(MSG_EXPIRED_WITHOUT_LOCATOR);
      }
      return;
    }

    if (intent === 'proxy') {
      // Regla 3 & 7: no repetir proxy si ya se intentó o si no es proxyable
      if (!canEscalateToProxy(activeServer) || hasAttemptedMode(attemptedModesRef.current, activeServer.id, 'proxy')) {
        if (activeServerIndex < servers.length - 1) {
          handleServerChange(activeServerIndex + 1, true);
        } else {
          setDeliveryState('error');
          setPlaybackError(MSG_PROXY_FAILED);
        }
        return;
      }

      recordAttemptedMode(attemptedModesRef.current, activeServer.id, 'proxy');
      if (proxyRequestInFlightRef.current) return;
      proxyRequestInFlightRef.current = true;
      setDeliveryState('requesting_proxy');

      // El original_url debe ser RENOVABLE: nunca el HLS firmado temporal.
      api.requestProxySession(canonicalUrl, activeServer?.resolution_id)
        .then(session => {
          if (attemptId !== attemptIdRef.current || !proxyRequestInFlightRef.current) {
            void api.closeProxySession(session.session_id);
            return;
          }
          activeSessionIdRef.current = session.session_id;
          finalUrl = backendUrl(session.playback_url);
          setActiveSessionUrl(finalUrl);
          // Conservar la metadata de la sesión en el servidor activo.
          setServers((prev) => {
            const copy = [...prev];
            if (copy[activeServerIndex]) {
              copy[activeServerIndex] = {
                ...copy[activeServerIndex],
                delivery_mode: 'proxy_required',
                generation: session.generation || copy[activeServerIndex].generation,
                refresh_after: session.refresh_after,
                expires_at: session.expires_at,
              };
            }
            return copy;
          });
          setDeliveryState('playing_proxy');
          if (isCasting) {
            if (videoRef.current) {
              videoRef.current.pause();
              videoRef.current.removeAttribute('src');
            }
            const resumeTime = pendingResumeTimeRef.current ?? castCurrentTime ?? currentTime ?? props.initialTime ?? 0;
            pendingResumeTimeRef.current = null;
            console.log("[Player] Transmitiendo proxy a Chromecast:", finalUrl, "en segundo:", resumeTime);
            void loadActiveServerOnCast(resumeTime, finalUrl);
            playbackConfirmedRef.current = true;
            proxyRequestInFlightRef.current = false;
            return;
          }
          if (!video) return;

          const sessionIsHls = finalUrl.includes('.m3u8') || finalUrl.includes('/m3u8/');
          const sessionIsDash = /\.mpd(?:[?#]|$)/i.test(finalUrl);
          if (sessionIsHls) {
            void setupHls(finalUrl);
          } else if (sessionIsDash) {
            void setupDash(finalUrl);
          } else {
            video.src = finalUrl;
          }
          proxyRequestInFlightRef.current = false;
        }).catch(_err => {
          console.error("Proxy falló para", canonicalUrl, _err);
          if (attemptId !== attemptIdRef.current) return;
          proxyRequestInFlightRef.current = false;
          if (activeServer) {
            setServerHealthMap((previous) => ({ ...previous, [activeServer.id]: 'failed' }));
          }
          // Regla 4: Proxy fallido puede avanzar al siguiente servidor una sola vez.
          if (activeServerIndex < servers.length - 1) {
            handleServerChange(activeServerIndex + 1, true);
          } else {
            setDeliveryState('error');
            setPlaybackError(MSG_PROXY_FAILED);
          }
        });
      return;
    }

    // INTENTO DIRECTO
    if (hasAttemptedMode(attemptedModesRef.current, activeServer.id, 'direct')) {
      // Directo ya intentado: si es proxyable y proxy no se ha intentado, intentar proxy
      if (canEscalateToProxy(activeServer) && !hasAttemptedMode(attemptedModesRef.current, activeServer.id, 'proxy')) {
        setDeliveryCapability(url, 'proxy_required', activeServer.provider);
        attachSource(url);
        return;
      }
      if (activeServerIndex < servers.length - 1) {
        handleServerChange(activeServerIndex + 1, true);
      } else {
        setDeliveryState('error');
        setPlaybackError(MSG_NO_SERVERS);
      }
      return;
    }

    recordAttemptedMode(attemptedModesRef.current, activeServer.id, 'direct');
    setDeliveryState('trying_direct');

    directWatchdogRef.current = setTimeout(() => {
      if (attemptId !== attemptIdRef.current) return;
      // Solo si el directo no produjo progreso ni manifest parsed. La demora
      // por sí sola no es fatal: no escalar a proxy ni cambiar de servidor.
      if (!playbackConfirmedRef.current) {
        directWatchdogRef.current = null;
        requestManualServerChoice('Este servidor está tardando en responder. ¿Quieres probar otro servidor?');
      }
    }, DIRECT_WATCHDOG_MS);

    if (isCasting) {
      if (directWatchdogRef.current) clearTimeout(directWatchdogRef.current);
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute('src');
      }
      const resumeTime = pendingResumeTimeRef.current ?? castCurrentTime ?? currentTime ?? props.initialTime ?? 0;
      pendingResumeTimeRef.current = null;
      console.log("[Player] Preparando entrega compatible con Chromecast:", finalUrl, "en segundo:", resumeTime);
      void loadActiveServerOnCast(resumeTime, finalUrl);
      return;
    }
    if (!video) return;

    const isHls = finalUrl.includes('.m3u8') || finalUrl.includes('/m3u8/');
    const isDash = /\.mpd(?:[?#]|$)/i.test(finalUrl);
    if (isHls) {
      void setupHls(finalUrl);
    } else if (isDash) {
      void setupDash(finalUrl);
    } else if (isNativeMediaUrl(finalUrl)) {
      video.src = finalUrl;
      const onLoadedMetadata = () => {
        if (attemptId !== attemptIdRef.current) return;
        if (directWatchdogRef.current) clearTimeout(directWatchdogRef.current);
        const resumeTime = pendingResumeTimeRef.current ?? props.initialTime;
        if (resumeTime && resumeTime > 0) {
          video.currentTime = resumeTime;
          pendingResumeTimeRef.current = null;
        }
        video.play().catch(() => {});
        playbackConfirmedRef.current = true;
        setDeliveryState('playing_direct');
        setDeliveryCapability(url, 'direct_ok', activeServer?.provider);
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
      };
      video.addEventListener('loadedmetadata', onLoadedMetadata);
      nativeListenersCleanupRef.current = () => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
      };
    } else if (activeServerIndex < servers.length - 1) {
      handleServerChange(activeServerIndex + 1, true);
    } else {
      setDeliveryState('error');
      setPlaybackError(MSG_NO_SERVERS);
    }
  }, [
    activeServer,
    activeServerIndex,
    servers.length,
    props.initialTime,
    props.title,
    media?.title,
    props.showTitle,
    media?.showTitle,
    props.posterUrl,
    media?.poster_url,
    requestManualServerChoice,
    isCasting,
    castCurrentTime,
    currentTime,
    resolvedSubtitleTracks,
    activeSubtitleId,
    loadActiveServerOnCast,
  ]);

  // CLAVE DE CONEXIÓN (punto 8): detecta cambios REALES de URL/generación/delivery,
  // no solo el índice. Una URL nueva en el mismo índice reconecta HLS.js.
  const lastAttachmentKey = useRef<string>('');
  useEffect(() => {
    const key = `${activeServerIndex}:${buildAttachmentKey(activeServer)}`;
    // Las páginas canónicas/no reproducibles se resuelven JIT; nunca se deben
    // entregar a HLS.js como si fueran un manifiesto. El efecto de resolución
    // actualizará el mismo candidato a una URL nativa y entonces este efecto
    // volverá a ejecutarse con una clave de conexión nueva.
    const isCanonicalPending = Boolean(
      activeServer && (activeServer.notPlayable || isUnresolvedCanonical(activeServer.url))
    );
    // `attachSource` monta HLS.js directamente cuando se crea una sesión proxy.
    // La actualización posterior de generation/delivery_mode cambia la identidad
    // del servidor, pero no debe desmontar ese HLS recién iniciado y abortar su
    // manifiesto. handleServerChange limpia activeSessionUrl al cambiar de fuente.
    if (activeSessionUrl) return;
    if (activeServer && !activeServer.isEmbed && !isCanonicalPending && lastAttachmentKey.current !== key) {
      if (isCasting || videoRef.current) {
        lastAttachmentKey.current = key;
        attachSource(activeServer.url || '');
      } else {
        // Si el elemento <video> aún no está montado durante la transición, reintentar en el siguiente frame
        const timer = requestAnimationFrame(() => {
          if (isCasting || videoRef.current) {
            lastAttachmentKey.current = key;
            attachSource(activeServer.url || '');
          }
        });
        return () => cancelAnimationFrame(timer);
      }
    }
    if (!activeServer) {
      lastAttachmentKey.current = '';
    }
  }, [activeServer, activeServerIndex, activeSessionUrl, attachSource]);

  useEffect(() => {
    return () => {
      const sessionId = activeSessionIdRef.current;
      activeSessionIdRef.current = null;
      if (sessionId) void api.closeProxySession(sessionId);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (dashRef.current) {
        dashRef.current.reset?.();
        dashRef.current = null;
      }
      if (directWatchdogRef.current) clearTimeout(directWatchdogRef.current);
      if (renewalTimerRef.current) clearTimeout(renewalTimerRef.current);
      if (blackScreenTimerRef.current) clearTimeout(blackScreenTimerRef.current);
      if (stallFailoverTimerRef.current) clearTimeout(stallFailoverTimerRef.current);
      if (nativeListenersCleanupRef.current) {
        nativeListenersCleanupRef.current();
        nativeListenersCleanupRef.current = null;
      }
    };
  }, []);

  // 4. EVENT LISTENERS DEL ELEMENTO VIDEO
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeServer || activeServer.isEmbed) return;

    // Los eventos nativos pueden llegar después de destruir HLS.js durante un
    // cambio de servidor. Asociarlos al intento evita que un error tardío del
    // candidato anterior pinte "ningún servidor" sobre un stream ya activo.
    const listenerAttemptId = attemptIdRef.current;

    bufferCountRef.current = 0;
    bufferingStartMsRef.current = null;

    const onTimeUpdate = () => {
      if (listenerAttemptId !== attemptIdRef.current) return;
      setCurrentTime(video.currentTime);

      // Si el elemento ya avanza, cualquier overlay de un intento anterior es
      // obsoleto. Esto cubre el caso en que un error nativo tardío llegó justo
      // después de que HLS.js había comenzado a reproducir.
      if (video.currentTime > 0.3 && !video.paused) {
        setPlaybackError(null);
        setServerHealthMap((previous) => previous[activeServer.id] === 'online'
          ? previous
          : { ...previous, [activeServer.id]: 'online' });
      }

      // Confirmar playback saludable y cancelar watchdog de pantalla negra y directo
      if (!playbackConfirmedRef.current && video.currentTime > 0.3) {
        playbackConfirmedRef.current = true;
        if (blackScreenTimerRef.current) clearTimeout(blackScreenTimerRef.current);
        if (directWatchdogRef.current) clearTimeout(directWatchdogRef.current);
        setPlaybackError(null);
        api.reportPlayerEvent({
          eventType: "playback_started",
          provider: activeServer.provider || "Servidor",
          serverUrl: activeServer.url,
          mediaTitle: props.title || media?.title,
          durationBeforeErrorMs: Date.now() - loadStartMsRef.current,
          details: `Reproducción iniciada a ${Math.round(video.currentTime * 10) / 10}s`,
        });
      }
      // Progreso real del video también cancela el watchdog directo (punto 9).
      else if (video.currentTime > 0 && directWatchdogRef.current) {
        clearTimeout(directWatchdogRef.current);
        directWatchdogRef.current = null;
      }

      // Detección proactiva de final de episodio cuando el stream llega al final (evita congelamiento HLS sin 'ended')
      if (video.duration > 20 && video.currentTime > 0 && !hasEnded && props.onNextEpisode) {
        const remaining = video.duration - video.currentTime;
        if (remaining <= 1.5 || video.currentTime / video.duration >= 0.992) {
          triggerEpisodeEnded();
        }
      }

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

    const onPlay = () => {
      if (listenerAttemptId !== attemptIdRef.current) return;
      setIsPlaying(true);
      setPlaybackError(null);
      if (!playbackConfirmedRef.current && video.currentTime > 0.1) {
        playbackConfirmedRef.current = true;
        if (blackScreenTimerRef.current) clearTimeout(blackScreenTimerRef.current);
        api.reportPlayerEvent({
          eventType: "playback_started",
          provider: activeServer.provider || "Servidor",
          serverUrl: activeServer.url,
          mediaTitle: props.title || media?.title,
          durationBeforeErrorMs: Date.now() - loadStartMsRef.current,
        });
      }
    };

    const scheduleStallFailover = () => {
      if (video.paused || video.currentTime <= 0.5 || stallFailoverTimerRef.current) return;
      const stalledAtTime = video.currentTime;
      stallFailoverTimerRef.current = setTimeout(() => {
        stallFailoverTimerRef.current = null;
        // Waiting is normal during a slow segment. Aunque el playhead siga
        // detenido, no cambiamos de proveedor automáticamente: la decisión es
        // del usuario cuando la espera supera la ventana de cortesía.
        if (
          listenerAttemptId !== attemptIdRef.current ||
          video.paused ||
          video.readyState >= 3 ||
          video.currentTime > stalledAtTime + 0.25
        ) return;
        api.reportPlayerEvent({
          eventType: "black_screen_stalled",
          provider: activeServer.provider || "Servidor",
          serverUrl: activeServer.url,
          mediaTitle: props.title || media?.title,
          durationBeforeErrorMs: Date.now() - loadStartMsRef.current,
          details: "El stream quedó detenido durante la reproducción; se solicita decisión manual",
        });
        requestManualServerChoice('La reproducción lleva demasiado tiempo detenida. ¿Quieres probar otro servidor?');
      }, 20000);
    };

    const onPlaying = () => {
      if (listenerAttemptId !== attemptIdRef.current) return;
      setIsPlaying(true);
      setPlaybackError(null);
      if (stallFailoverTimerRef.current) {
        clearTimeout(stallFailoverTimerRef.current);
        stallFailoverTimerRef.current = null;
      }
      // El evento `playing` confirma reproducción real: cancelar el watchdog directo.
      if (directWatchdogRef.current) {
        clearTimeout(directWatchdogRef.current);
        directWatchdogRef.current = null;
      }
      if (bufferingStartMsRef.current) {
        const stallDuration = Date.now() - bufferingStartMsRef.current;
        bufferingStartMsRef.current = null;
        if (stallDuration > 1000) {
          api.reportPlayerEvent({
            eventType: "playback_started",
            provider: activeServer.provider || "Servidor",
            serverUrl: activeServer.url,
            mediaTitle: props.title || media?.title,
            details: `Pausa por buffer finalizada tras ${stallDuration}ms`,
          });
        }
      }
    };

    const onWaiting = () => {
      bufferCountRef.current += 1;
      bufferingStartMsRef.current = Date.now();
      api.reportPlayerEvent({
        eventType: "playback_buffering",
        provider: activeServer.provider || "Servidor",
        serverUrl: activeServer.url,
        mediaTitle: props.title || media?.title,
        bufferPauseCount: bufferCountRef.current,
        details: `Video pausado por falta de buffer (Pausa #${bufferCountRef.current} de CDN)`,
      });
      scheduleStallFailover();
    };

    const onStalled = () => {
      api.reportPlayerEvent({
        eventType: "playback_buffering",
        provider: activeServer.provider || "Servidor",
        serverUrl: activeServer.url,
        mediaTitle: props.title || media?.title,
        details: "Descarga de datos de video detenida por lentitud de CDN (stalled)",
      });
      scheduleStallFailover();
    };

    const onPause = () => {
      setIsPlaying(false);
      if (stallFailoverTimerRef.current) {
        clearTimeout(stallFailoverTimerRef.current);
        stallFailoverTimerRef.current = null;
      }
      if (props.onProgressUpdate) {
        props.onProgressUpdate(video.currentTime, video.duration || 0);
      }
    };

    const onEnded = () => {
      if (listenerAttemptId !== attemptIdRef.current) return;
      triggerEpisodeEnded();
      if (props.onProgressUpdate) props.onProgressUpdate(video.currentTime, video.duration || 0);
    };

    const onVolumeChange = () => {
      setVolume(video.volume);
      setIsMuted(video.muted);
    };

    const onError = () => {
      if (listenerAttemptId !== attemptIdRef.current) return;
      // Un error nativo tardío no debe cubrir una reproducción que ya está
      // confirmada y avanzando. Los errores HLS reales se procesan en el
      // listener Hls.Events.ERROR, que conserva su propia protección de carrera.
      if (playbackConfirmedRef.current && !video.paused && video.currentTime > 0.3) {
        setPlaybackError(null);
        return;
      }
      // Solo actuar si no hay instancia Hls activa para no colisionar con Hls.Events.ERROR
      if (!hlsRef.current && activeServer && !activeServer.isEmbed) {
        if (blackScreenTimerRef.current) clearTimeout(blackScreenTimerRef.current);
        api.reportPlayerEvent({
          eventType: "playback_error",
          provider: activeServer.provider || "Servidor",
          serverUrl: activeServer.url,
          mediaTitle: props.title || media?.title,
          durationBeforeErrorMs: Date.now() - loadStartMsRef.current,
          details: `HTML5 video error: code ${(video.error as any)?.code || 'unknown'}`,
        });

        if (activeServerIndex < servers.length - 1) {
          handleServerChange(activeServerIndex + 1, true);
        } else {
          setPlaybackError('Ningún servidor automático funcionó. Elige uno manualmente:');
        }
      }
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('progress', onProgress);
    video.addEventListener('play', onPlay);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('stalled', onStalled);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('error', onError);

    // Exponer la limpieza para poder eliminarla en cada cambio de servidor (punto 7).
    nativeListenersCleanupRef.current = () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onStalled);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('error', onError);
    };

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onStalled);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('error', onError);
      if (stallFailoverTimerRef.current) {
        clearTimeout(stallFailoverTimerRef.current);
        stallFailoverTimerRef.current = null;
      }
      if (nativeListenersCleanupRef.current) nativeListenersCleanupRef.current = null;
    };
  }, [activeServer, activeServerIndex, servers.length, props.title, media?.title, requestManualServerChoice]);

  // 5. ATAJOS DE TECLADO Y FULLSCREEN
  useEffect(() => {
    if (nativeShell) return;
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [nativeShell]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (isScreenLocked) {
        if (e.key === 'Escape' || e.key.toLowerCase() === 'l') {
          e.preventDefault();
          handleUnlockScreen();
        } else {
          showLockWidgetTemporarily();
        }
        return;
      }

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
  }, [onClose, isPlaying, activeMenu, showControlsTemporarily, isScreenLocked, handleUnlockScreen, showLockWidgetTemporarily]);

  const isClosingRef = useRef(false);
  const isAppRoutedPlayer = typeof window !== 'undefined' && (
    /^\/(?:ver|watch|reproducir|player)(?:\/|$)/i.test(window.location.pathname)
    || new URLSearchParams(window.location.search).get('view') === 'player'
    || new URLSearchParams(window.location.search).get('player') === '1'
  );
  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    if (videoRef.current && props.onProgressUpdate) {
      props.onProgressUpdate(videoRef.current.currentTime, videoRef.current.duration || 0);
    }
    if (window.history.state?.meristream_view === 'player' && !isAppRoutedPlayer) {
      window.history.back();
    }
    leaveNativeImmersive();
    onClose();
  }, [onClose, props, isAppRoutedPlayer]);

  // Pantalla dedicada: bloqueo de scroll del fondo y botón atrás de navegación
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    try {
      // App.tsx owns the shareable /ver/... route. Do not add a second
      // history entry for the player, otherwise one click on "Cerrar"
      // leaves a phantom player entry behind. Keep the legacy state-only
      // fallback for callers that still mount this modal without a route.
      if (isAppRoutedPlayer) {
        window.history.replaceState({ ...(window.history.state || {}), meristream_view: 'player' }, '');
      } else {
        window.history.pushState({ ...(window.history.state || {}), meristream_view: 'player' }, '');
      }
    } catch {}

    const onPopState = () => {
      if (isClosingRef.current) return;
      isClosingRef.current = true;
      if (videoRef.current && props.onProgressUpdate) {
        props.onProgressUpdate(videoRef.current.currentTime, videoRef.current.duration || 0);
      }
      onClose();
    };

    window.addEventListener('popstate', onPopState);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('popstate', onPopState);
    };
  }, [onClose, props, isAppRoutedPlayer]);

  useEffect(() => {
    if (!props.isOpen || !nativeShell) return;
    setIsFullscreen(true);
    void nativeSetImmersive(true);
    void nativeLockLandscape();
    return () => {
      setIsFullscreen(false);
      void nativeSetImmersive(false);
      void nativeUnlockOrientation();
    };
  }, [props.isOpen, nativeShell]);

  // Controles de Acción de Reproducción
  const enterNativeImmersive = async () => {
    if (!isNativeShell()) return;
    setIsFullscreen(true);
    await nativeSetImmersive(true);
    await nativeLockLandscape();
  };

  const leaveNativeImmersive = () => {
    if (!isNativeShell()) return;
    setIsFullscreen(false);
    void nativeSetImmersive(false);
    void nativeUnlockOrientation();
  };

  const togglePlay = () => {
    nativeHaptic(4);
    if (isViewerMode) {
      showViewerLockNotice('Reproducción controlada por el anfitrión');
      return;
    }
    if (isCasting) {
      if (castIsPaused) castPlay();
      else castPause();
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void enterNativeImmersive();
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const seekOffset = (seconds: number) => {
    if (isViewerMode) {
      showViewerLockNotice('Línea de tiempo controlada por el anfitrión');
      return;
    }
    if (isCasting) {
      const maxDur = castDuration || duration || 0;
      castSeek(Math.max(0, Math.min(maxDur, castCurrentTime + seconds)));
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration, video.currentTime + seconds));
  };

  const toggleMute = () => {
    if (isCasting) {
      castSetMuted(!isMuted);
      setIsMuted(!isMuted);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.6;
  };

  const changeVolume = (delta: number) => {
    const newVol = Math.max(0, Math.min(1, volume + delta));
    setVolume(newVol);
    setIsMuted(newVol === 0);
    if (isCasting) {
      castSetVolume(newVol);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.volume = newVol;
    video.muted = newVol === 0;
  };

  const handleVolumeSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setVolume(val);
    setIsMuted(val === 0);
    if (isCasting) {
      castSetVolume(val);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.volume = val;
    video.muted = val === 0;
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isViewerMode) {
      showViewerLockNotice('Línea de tiempo controlada por el anfitrión');
      return;
    }
    const val = Number(e.target.value);
    if (isCasting) {
      castSeek(val);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = val;
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

  const toggleFullscreen = async () => {
    const node = containerRef.current;
    if (!node) return;

    if (nativeShell) {
      if (isFullscreen) {
        leaveNativeImmersive();
      } else {
        await enterNativeImmersive();
      }
      return;
    }

    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await node.requestFullscreen();
    }
  };

  const showTapFeedback = (message: string) => {
    setFailoverNotice(message);
    window.setTimeout(() => setFailoverNotice((current) => current === message ? null : current), 650);
  };

  const handleNativePlayerPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!nativeShell || event.pointerType === 'mouse' || isScreenLocked) return;
    const now = performance.now();
    const previous = lastNativeTapRef.current;
    lastNativeTapRef.current = { at: now, x: event.clientX };

    if (!previous || now - previous.at > 330 || Math.abs(event.clientX - previous.x) > 96) return;
    lastNativeTapRef.current = null;
    nativeHaptic(8);

    const rect = event.currentTarget.getBoundingClientRect();
    const position = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
    if (position < 0.36) {
      seekOffset(-10);
      showTapFeedback('−10 s');
      return;
    }
    if (position > 0.64) {
      seekOffset(10);
      showTapFeedback('+10 s');
      return;
    }

    // The native player is already immersive. A center double-tap toggles
    // playback instead of unexpectedly leaving fullscreen.
    togglePlay();
    showTapFeedback(isPlaying ? 'Pausa' : 'Reproducir');
  };

  const handlePlayerDoubleClick = () => {
    if (isScreenLocked || nativeShell) return;
    void toggleFullscreen();
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
    if (dashRef.current) {
      if (levelIndex < 0) {
        dashRef.current.setAutoSwitchQualityFor?.('video', true);
        setCurrentResolutionLabel('Auto (Máxima Calidad)');
      } else {
        dashRef.current.setAutoSwitchQualityFor?.('video', false);
        dashRef.current.setQualityFor?.('video', levelIndex);
        const level = qualityLevels.find((q) => q.index === levelIndex);
        setCurrentResolutionLabel(level?.label || 'Manual');
      }
    }
    setActiveQuality(levelIndex);
    setActiveMenu('none');
  };

  const selectAudioTrack = (trackIndex: number) => {
    if (hlsRef.current) hlsRef.current.audioTrack = trackIndex;
    if (dashRef.current) {
      const tracks = dashRef.current.getTracksFor?.('audio') || [];
      if (tracks[trackIndex]) dashRef.current.setCurrentTrack?.(tracks[trackIndex]);
    }
    setActiveAudioTrack(trackIndex);
    setActiveMenu('none');
  };

  const selectSubtitle = (track: SubtitleTrack | 'off') => {
    userExplicitlySelectedSubtitlesRef.current = true;
    const video = videoRef.current;
    if (video) {
      Array.from(video.textTracks).forEach((tt) => {
        tt.mode = 'disabled';
      });
      if (track !== 'off') {
        const domTrack = Array.from(video.textTracks).find((tt) => tt.label === track.label);
        if (domTrack) domTrack.mode = 'showing';
      }
    }
    if (track === 'off') {
      setActiveSubtitleId('off');
    } else {
      setActiveSubtitleId(track.id);
    }
    setActiveMenu('none');
    setSubtitleSettingsOpen(false);
  };

  const updateSubtitleTiming = (field: keyof SubtitleTimingSettings, rawValue: string) => {
    if (field === 'startAt') {
      setSubtitleStartInput(rawValue);
      const value = parseSubtitleTime(rawValue);
      if (value !== null) setSubtitleTiming((current) => ({ ...current, startAt: value }));
      return;
    }

    setSubtitleOffsetInput(rawValue);
    const value = parseSubtitleTime(rawValue, true);
    if (value !== null) setSubtitleTiming((current) => ({ ...current, offset: value }));
  };

  const normalizeSubtitleTimingInput = (field: keyof SubtitleTimingSettings) => {
    if (field === 'startAt') {
      setSubtitleStartInput(formatSubtitleTime(subtitleTiming.startAt));
    } else {
      setSubtitleOffsetInput(formatSubtitleTime(subtitleTiming.offset, true));
    }
  };

  const resetSubtitleTiming = () => {
    setSubtitleTiming(DEFAULT_SUBTITLE_TIMING);
    setSubtitleStartInput(formatSubtitleTime(DEFAULT_SUBTITLE_TIMING.startAt));
    setSubtitleOffsetInput(formatSubtitleTime(DEFAULT_SUBTITLE_TIMING.offset, true));
  };

  const effectiveCurrentTime = isCasting ? castCurrentTime : currentTime;
  const effectiveDuration = isCasting && castDuration > 0 ? castDuration : duration;
  const effectiveIsPlaying = isCasting ? !castIsPaused : isPlaying;
  const progressPct = effectiveDuration > 0 ? (effectiveCurrentTime / effectiveDuration) * 100 : 0;

  useEffect(() => {
    if (!nativeShell || typeof navigator === 'undefined') return;
    const wakeLock = (navigator as Navigator & { wakeLock?: { request?: (type: 'screen') => Promise<any> } }).wakeLock;
    let cancelled = false;

    const release = async () => {
      const lock = wakeLockRef.current;
      wakeLockRef.current = null;
      if (lock?.release) {
        try { await lock.release(); } catch {}
      }
    };

    const acquire = async () => {
      if (cancelled || !effectiveIsPlaying || document.visibilityState !== 'visible' || !wakeLock?.request || wakeLockRef.current) return;
      try {
        const lock = await wakeLock.request('screen');
        if (cancelled || !effectiveIsPlaying) {
          try { await lock.release?.(); } catch {}
          return;
        }
        wakeLockRef.current = lock;
        lock?.addEventListener?.('release', () => {
          if (wakeLockRef.current === lock) wakeLockRef.current = null;
        });
      } catch {
        // Wake Lock is optional; playback remains fully functional without it.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && effectiveIsPlaying) void acquire();
      else void release();
    };

    if (effectiveIsPlaying) void acquire();
    else void release();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void release();
    };
  }, [nativeShell, effectiveIsPlaying]);
  const bufferedPct = isCasting ? 100 : (effectiveDuration > 0 ? (bufferedEnd / effectiveDuration) * 100 : 0);
  const subtitleIsCustomPosition = appPreferences.subtitlePosition === 'custom';
  const subtitlePositionClass = subtitleIsCustomPosition
    ? 'z-20'
    : appPreferences.subtitlePosition === 'top'
    ? 'top-20'
    : appPreferences.subtitlePosition === 'center'
    ? 'top-1/2 -translate-y-1/2'
    : 'bottom-20';
  const subtitlePositionStyle = subtitleIsCustomPosition
    ? {
        left: `${appPreferences.subtitlePositionX}%`,
        top: `${appPreferences.subtitlePositionY}%`,
        transform: 'translate(-50%, -50%)',
      }
    : undefined;
  const subtitleScaleClass = appPreferences.subtitleScale === 'large'
    ? 'text-lg sm:text-xl'
    : appPreferences.subtitleScale === 'small'
    ? 'text-sm sm:text-base'
    : 'text-base sm:text-lg';

  // Android / browser Media Session integration. On capable WebViews this
  // exposes playback to headset buttons, lock-screen controls and the media
  // notification without creating a second native player implementation.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const poster = props.posterUrl || media?.poster_url || props.item?.poster_url || '';
    const showName = props.showTitle || media?.showTitle || media?.title || 'MeriStream';
    try {
      session.metadata = new MediaMetadata({
        title: displayTitle,
        artist: showName,
        album: props.episodeNumber ? `Episodio ${props.episodeNumber}` : 'MeriStream',
        ...(poster ? { artwork: [{ src: poster }] } : {}),
      });
    } catch {}

    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { session.setActionHandler(action, handler); } catch {}
    };

    setHandler('play', () => {
      if (isCasting) castPlay();
      else void videoRef.current?.play().catch(() => {});
    });
    setHandler('pause', () => {
      if (isCasting) castPause();
      else videoRef.current?.pause();
    });
    setHandler('seekbackward', (details) => {
      const delta = Number(details.seekOffset || 10);
      if (isCasting) castSeek(Math.max(0, castCurrentTime - delta));
      else if (videoRef.current) videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - delta);
    });
    setHandler('seekforward', (details) => {
      const delta = Number(details.seekOffset || 10);
      const max = isCasting ? (castDuration || duration || Number.MAX_SAFE_INTEGER) : (videoRef.current?.duration || duration || Number.MAX_SAFE_INTEGER);
      if (isCasting) castSeek(Math.min(max, castCurrentTime + delta));
      else if (videoRef.current) videoRef.current.currentTime = Math.min(max, videoRef.current.currentTime + delta);
    });
    setHandler('seekto', (details) => {
      if (typeof details.seekTime !== 'number') return;
      if (isCasting) castSeek(details.seekTime);
      else if (videoRef.current) videoRef.current.currentTime = details.seekTime;
    });
    if (props.onNextEpisode) {
      setHandler('nexttrack', () => props.onNextEpisode?.());
    }

    return () => {
      for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'nexttrack'] as MediaSessionAction[]) {
        setHandler(action, null);
      }
      try { session.metadata = null; } catch {}
    };
  }, [
    displayTitle,
    props.posterUrl,
    props.showTitle,
    props.episodeNumber,
    props.onNextEpisode,
    props.item?.poster_url,
    media?.poster_url,
    media?.showTitle,
    media?.title,
    isCasting,
    castCurrentTime,
    castDuration,
    duration,
    castPlay,
    castPause,
    castSeek,
  ]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    try {
      session.playbackState = effectiveIsPlaying ? 'playing' : 'paused';
    } catch {}
    if (
      effectiveDuration > 0
      && Number.isFinite(effectiveDuration)
      && Number.isFinite(effectiveCurrentTime)
      && typeof session.setPositionState === 'function'
    ) {
      try {
        session.setPositionState({
          duration: effectiveDuration,
          playbackRate: playbackRate || 1,
          position: Math.min(effectiveDuration, Math.max(0, effectiveCurrentTime)),
        });
      } catch {}
    }
  }, [effectiveCurrentTime, effectiveDuration, effectiveIsPlaying, playbackRate]);

  // REINTENTO REAL: reinicia el estado del servidor activo y fuerza el
  // pipeline completo (re-resolve JIT si aplica → attachSource). Antes el
  // botón solo repintaba el mismo src sin disparar ninguna petición nueva.
  const handleRetryCurrentServer = () => {
    if (!activeServer) return;
    jitCompletedRef.current.clear();
    setCanonicalResolveError(null);
    setPlaybackError(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setBufferedEnd(0);

    if (activeServer.isEmbed) {
      setServers((prev) => {
        const copy = [...prev];
        if (copy[activeServerIndex]) {
          copy[activeServerIndex] = {
            ...copy[activeServerIndex],
            notPlayable: false,
            failure_reason: undefined,
            resolved_at: undefined,
          };
        }
        return copy;
      });
      return;
    }

    attachSource(activeServer.url);
  };

  return (
    <div
      ref={containerRef}
      data-player-root
      className={`fixed inset-0 z-[9999] flex h-full w-full min-h-[100dvh] flex-col justify-between bg-black select-none overflow-hidden ${
        !controlsVisible && isPlaying ? 'cursor-none' : ''
      }`}
      onMouseMove={isScreenLocked ? showLockWidgetTemporarily : showControlsTemporarily}
      onMouseDown={isScreenLocked ? showLockWidgetTemporarily : showControlsTemporarily}
      onTouchStart={isScreenLocked ? showLockWidgetTemporarily : showControlsTemporarily}
    >
        {/* ========================================================================= */}
        {/* 1. TOP BAR MODERNA Y ELEGANTE (SIN SLOP)                                   */}
        {/* ========================================================================= */}
        <div
          data-player-topbar
          className={`absolute top-0 inset-x-0 z-50 flex items-center justify-between px-2.5 sm:px-6 py-2.5 sm:py-4 bg-gradient-to-b from-black/90 via-black/50 to-transparent transition-opacity duration-300 ${
            !isScreenLocked && (controlsVisible || !isPlaying || Boolean(playbackError)) ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* TÍTULO Y BADGE DE CALIDAD */}
          <div className="flex items-center gap-2 sm:gap-3 max-w-[65%] sm:max-w-[75%] truncate">
            <button
              type="button"
              onClick={handleClose}
              className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700/60 transition shadow-sm shrink-0"
              title="Cerrar reproductor (Esc)"
            >
              <X size={16} className="sm:w-[18px] sm:h-[18px]" />
            </button>

            <div className="flex flex-col truncate">
              <h3 className="text-xs sm:text-base font-semibold text-white truncate tracking-tight">
                {displayTitle}
              </h3>
              <div className="flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-xs text-zinc-400">
                <span className="inline-flex items-center gap-1 text-emerald-400 font-medium font-mono text-[10px] sm:text-[11px]">
                  <Zap size={11} className="sm:w-3 sm:h-3" />
                  {currentResolutionLabel}
                </span>
                <span>•</span>
                <span className="truncate text-zinc-400 text-[10px] sm:text-xs">
                  {activeServer?.provider || 'Servidor Rápido'}
                </span>
              </div>
            </div>
          </div>

          {/* ACCIONES SUPERIORES: CAMBIO RÁPIDO DE SERVIDORES Y APERTURA EXTERNA */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {/* BOTÓN Y BADGE DE WATCH PARTY */}
            <div data-player-secondary-action="true">
            {teleparty.isInRoom ? (
              <button
                type="button"
                onClick={() => setIsWatchPartyPanelOpen((v) => !v)}
                data-testid="watch-party-active-badge"
                className="flex items-center gap-1 sm:gap-1.5 px-2 py-1 sm:px-2.5 sm:py-1.5 rounded-lg text-xs font-semibold bg-amber-500/15 hover:bg-amber-500/25 text-amber-100 border border-amber-500/35 transition backdrop-blur-md shadow-sm"
                title="Abrir chat y controles de Watch Party"
              >
                <Users size={13} className="text-amber-300" />
                <span className="font-mono font-bold tracking-wider">{teleparty.roomCode}</span>
                <span className="text-amber-300/70 font-normal">•</span>
                <span>{teleparty.participants.length}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIsJoinModalOpen(true)}
                data-testid="watch-party-open-modal-button"
                className="flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs font-medium px-2 py-1 sm:px-2.5 sm:py-1.5 rounded-lg border backdrop-blur-md transition bg-zinc-900/80 text-zinc-300 hover:text-white hover:bg-zinc-800 border-zinc-700/60"
                title="Iniciar o unirse a Watch Party"
              >
                <Users size={13} className="text-amber-300 sm:w-[14px] sm:h-[14px]" />
                <span className="hidden sm:inline">Watch Party</span>
              </button>
            )}
            </div>

            {/* VIEWER MODE INDICATOR BADGE */}
            {isViewerMode && (
              <div
                data-testid="viewer-mode-indicator"
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[10px] sm:text-xs font-medium backdrop-blur-md"
              >
                <Lock size={12} className="text-amber-400 shrink-0" />
                <span className="hidden md:inline">Controlado por el anfitrión:</span>
                <span className="font-semibold text-white truncate max-w-[90px]">
                  {teleparty.room?.hostUsername || teleparty.hostParticipant?.username || 'Anfitrión'}
                </span>
              </div>
            )}

            {!nativeShell && (
              <div data-player-secondary-action="true">
                <Suspense fallback={null}>
                  <LazyReportControl
                    title={props.title || media?.title || 'esta obra'}
                    showId={props.showId || null}
                    tmdbId={props.tmdbId || null}
                    kind={props.kind || null}
                    episodeId={props.episodeId || null}
                    episodeNumber={props.episodeNumber || null}
                    sourceProvider={activeServer?.sourceSite || activeServer?.provider || null}
                    sourceUrl={activeServer?.canonical_locator || null}
                    compact
                  />
                </Suspense>
              </div>
            )}
            {/* La cascada selecciona automáticamente, pero el selector queda
                disponible cuando existen varias fuentes. */}
            {showServerSelector && servers.length > 1 && (
              <div className="relative" data-player-secondary-action="true">
                <button
                  type="button"
                  onClick={() => setActiveMenu((m) => (m === 'servers' ? 'none' : 'servers'))}
                  className={`flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs font-medium px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg border backdrop-blur-md transition ${
                    activeMenu === 'servers'
                      ? 'bg-zinc-800 text-white border-zinc-600'
                      : 'bg-zinc-900/80 text-zinc-300 hover:text-white border-zinc-700/60'
                  }`}
                  title="Cambiar o Inspeccionar Servidor de Streaming"
                >
                  <Server size={12} className="text-emerald-400 sm:w-[13px] sm:h-[13px]" />
                  <span className="hidden sm:inline">
                    {(() => {
                      const site = activeServer?.sourceSite ? String(activeServer.sourceSite).toUpperCase() : '';
                      const prov = activeServer?.provider || `Servidor ${activeServerIndex + 1}`;
                      if (site && prov && !prov.toUpperCase().includes(site)) {
                        return `${prov} · ${site}`;
                      }
                      return site || prov;
                    })()} ({activeServerIndex + 1}/{servers.length})
                  </span>
                  <span className="sm:hidden text-[10px] font-mono">
                    {activeServerIndex + 1}/{servers.length}
                  </span>
                  <ChevronRight size={11} className={`sm:w-3 sm:h-3 ${activeMenu === 'servers' ? 'rotate-90' : ''}`} />
                </button>

                {/* MENÚ FLOTANTE DE SERVIDORES */}
                {activeMenu === 'servers' && (
                  <div className="absolute right-0 top-11 z-[100] w-64 rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-2 shadow-2xl backdrop-blur-xl">
                    <div className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center justify-between">
                      <span>Servidores Disponibles</span>
                      <span className="text-[10px] text-emerald-400 font-normal">Auto-ordenados por calidad</span>
                    </div>
                    <div className="mt-1 space-y-1 max-h-56 overflow-y-auto pr-1">
                      {(() => {
                        // PREMIUM POR PLATAFORMA: la lista ya viene ordenada por
                        // tier/score. Solo cuentan los servidores con source_site
                        // REAL (plataforma de origen desde el backend); la primera
                        // aparición de cada plataforma es su mejor servidor. Si una
                        // plataforma no aportó servidores, simplemente no aparece —
                        // nada se fuerza con nombres genéricos. El badge muestra la
                        // PLATAFORMA, no el nombre del servidor.
                        const seenSites = new Set<string>();
                        const premium: Array<{ srv: (typeof servers)[number]; idx: number; site: string }> = [];
                        const rest: Array<{ srv: (typeof servers)[number]; idx: number; site: string }> = [];
                        servers.forEach((srv, idx) => {
                          const site = srv.sourceSite ? String(srv.sourceSite).toLowerCase() : null;
                          if (site && !seenSites.has(site)) {
                            seenSites.add(site);
                            premium.push({ srv, idx, site });
                          } else {
                            rest.push({ srv, idx, site: site || (srv.sourceSite ? String(srv.sourceSite).toLowerCase() : '') });
                          }
                        });
                        const row = (srv: (typeof servers)[number], idx: number, siteLabel?: string) => {
                          const status = serverHealthMap[srv.id] || 'unverified';
                          const isJit = Boolean(
                            srv.isEmbed || srv.notPlayable || isUnresolvedCanonical(srv.url)
                            || (hasExpiringSignature(srv.url) && (!srv.expires_at || srv.expires_at <= Date.now()) && !srv.resolved_at)
                          );
                          const effectiveSiteLabel = siteLabel || (srv.sourceSite ? String(srv.sourceSite).toUpperCase() : '');
                          const statusTitle = status === 'failed'
                            ? 'Falló al intentar reproducir (clic para volver a probar)'
                            : status === 'checking'
                              ? 'Comprobando esta fuente en el reproductor'
                              : status === 'online'
                                ? 'Reproducción confirmada en este reproductor'
                                : 'Aún no se ha confirmado reproduciendo';
                          const detailLabel = status === 'online'
                            ? 'Reproducción confirmada'
                            : status === 'failed'
                              ? 'No se pudo reproducir en la última prueba'
                              : status === 'checking'
                                ? 'Probando en el reproductor…'
                                : isJit
                                  ? 'Sin confirmar · se resolverá al probar'
                                  : 'Sin confirmar en este reproductor';
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
                                  : 'text-zinc-300 hover:bg-zinc-800/60'
                              }`}
                            >
                              <div className="flex items-center gap-2 truncate pr-2">
                                {/* Indicador visual de salud */}
                                <span
                                  className={`h-2 w-2 rounded-full shrink-0 ${
                                    status === 'failed'
                                      ? 'bg-rose-500'
                                      : status === 'checking'
                                      ? 'bg-amber-400 animate-pulse'
                                      : status === 'online'
                                        ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50'
                                        : 'bg-zinc-500'
                                  }`}
                                  title={statusTitle}
                                />
                                <div className="flex flex-col truncate">
                                  <span className="truncate">
                                    {isJit ? (effectiveSiteLabel || srv.provider || srv.label) : srv.label}
                                  </span>
                                  <span className="text-[10px] text-zinc-500 font-mono">
                                    {detailLabel}
                                    {srv.latencyMs ? ` • ${srv.latencyMs}ms` : ''}
                                    {status === 'failed' ? ' • Clic para reintentar' : ''}
                                  </span>
                                </div>
                              </div>
                              {effectiveSiteLabel && (
                                <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded uppercase font-bold tracking-wide ${
                                  status === 'online'
                                    ? 'bg-emerald-500/10 text-emerald-300'
                                    : status === 'failed'
                                      ? 'bg-rose-500/10 text-rose-300'
                                      : 'bg-zinc-800 text-zinc-400'
                                }`}>
                                  {effectiveSiteLabel}
                                </span>
                              )}
                              {activeServerIndex === idx && (
                                <Check size={14} className="text-emerald-400 shrink-0" />
                              )}
                            </button>
                          );
                        };
                        return (
                          <>
                            {premium.length > 0 && (
                              <div className="px-2 pt-1 pb-0.5 text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
                                Premium por plataforma
                              </div>
                            )}
                            {premium.map((p) => row(p.srv, p.idx, p.site))}
                            {rest.length > 0 && (
                              <div className="px-2 pt-2 pb-0.5 mt-1 border-t border-zinc-800 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                                Otros servidores
                              </div>
                            )}
                            {rest.map((r) => row(r.srv, r.idx, r.site))}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
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
            if (isScreenLocked) {
              showLockWidgetTemporarily();
              return;
            }
            if (activeMenu !== 'none') {
              setActiveMenu('none');
              return;
            }
            if (nativeShell) {
              // Mobile streaming convention: a single tap reveals controls;
              // play/pause is explicit, while double-tap handles seeking.
              showControlsTemporarily();
              return;
            }
            if (activeServer && !activeServer.isEmbed) togglePlay();
          }}
          onPointerUp={nativeShell ? handleNativePlayerPointerUp : undefined}
          onDoubleClick={isScreenLocked ? undefined : handlePlayerDoubleClick}
        >
          {isLoadingStream && (
            <div className="flex flex-col items-center gap-4 text-white z-20 animate-in fade-in duration-200">
              <div className="relative flex items-center justify-center">
                <div className="h-16 w-16 rounded-full border-2 border-emerald-500/20 border-t-emerald-500 animate-spin" />
                <Zap size={22} className="absolute text-emerald-400 animate-pulse" />
              </div>
              <div className="flex flex-col items-center gap-1.5 text-center px-4">
                <p className="text-base font-semibold text-white tracking-wide">Cargando Reproductor...</p>
                <p className="text-xs font-mono text-zinc-400">Optimizando servidores y máxima calidad disponible</p>
              </div>
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
              {!isCasting && (activeServer.isEmbed || isUnresolvedCanonical(activeServer.url) || activeServer.notPlayable) ? (
                /* LOCATOR SIN STREAM NATIVO: se resuelve JIT o se hace failover */
                <div className="flex flex-col items-center gap-4 text-white z-20 px-6 text-center animate-in fade-in duration-200">
                  <div className="relative flex items-center justify-center">
                    <div className={`h-14 w-14 rounded-full border-2 ${canonicalResolveError ? 'border-amber-500/30 border-t-amber-400' : 'border-emerald-500/20 border-t-emerald-500 animate-spin'}`} />
                    <Zap size={20} className={`absolute ${canonicalResolveError ? 'text-amber-400' : 'text-emerald-400 animate-pulse'}`} />
                  </div>
                  <div className="flex flex-col items-center gap-1.5 max-w-md">
                    <p className="text-base font-semibold text-white tracking-wide">
                      {canonicalResolveError ? 'Fuente no disponible' : `Resolviendo fuente de ${activeServer.sourceSite ? activeServer.sourceSite.toUpperCase() : activeServer.provider}...`}
                    </p>
                    <p className="text-xs text-zinc-400">
                      {canonicalResolveError || 'Esta fuente no contiene un stream nativo y se está resolviendo para el reproductor interno.'}
                    </p>
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    {canonicalResolveError && (
                      <button
                        type="button"
                        onClick={handleRetryCurrentServer}
                        className="flex items-center gap-2 rounded-lg bg-zinc-800 border border-zinc-700 px-4 py-2 text-xs font-medium text-white hover:bg-zinc-700 transition"
                      >
                        <RotateCcw size={14} /> Reintentar
                      </button>
                    )}
                    {servers.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleServerChange((activeServerIndex + 1) % servers.length, false)}
                        className="flex items-center gap-2 rounded-lg bg-zinc-800 border border-zinc-700 px-4 py-2 text-xs font-medium text-emerald-400 hover:bg-zinc-700 hover:text-emerald-300 transition"
                      >
                        Probar siguiente servidor <ChevronRight size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                /* MODO NATIVO HLS/DASH/MP4 O CASTING */
                <>
                  <video
                    ref={videoCallbackRef}
                    className="h-full w-full object-contain"
                    playsInline
                    preload="metadata"
                  >
                    {subtitleTracks.map((track) => (
                      <track
                        // Providers often reuse ids such as `vidsrc-0` for
                        // every mirror. The URL is the stable identity at the
                        // player boundary, so include it to keep React's track
                        // nodes distinct and avoid dropping captions.
                        key={`${track.id}:${track.url}`}
                        kind="subtitles"
                        src={subtitleSourceUrl(track)}
                        srcLang={track.language}
                        label={track.label}
                      />
                    ))}
                  </video>

                  {/* OVERLAY DE TRANSMISIÓN ACTIVA A CHROMECAST / GOOGLE CAST */}
                  {isCasting && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/85 backdrop-blur-md p-6 text-center space-y-4 animate-in fade-in duration-200 pointer-events-auto">
                      <div className="relative flex items-center justify-center">
                        <div className="w-20 h-20 rounded-full bg-violet-600/20 border border-violet-500/40 flex items-center justify-center text-violet-400 animate-pulse">
                          <Cast size={38} />
                        </div>
                      </div>
                      <div className="space-y-1.5 max-w-md">
                        <p className="text-base font-bold text-white tracking-wide">
                          {castLoadState === 'error' ? 'Chromecast conectado' : `Transmitiendo en ${castDeviceName || "Chromecast"}`}
                        </p>
                        <p className="text-xs text-zinc-400">
                          {castLoadState === 'error'
                            ? (castLoadError || 'No se pudo iniciar la reproducción en el dispositivo.')
                            : castLoadState === 'loading' || deliveryState === 'resolving' || deliveryState === 'requesting_proxy'
                            ? `Conectando nuevo servidor (${activeServer?.label || 'Servidor'})...`
                            : 'La reproducción se controla desde esta pantalla. Puedes pausar, adelantar o cambiar de servidor.'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={endCastSession}
                        className="px-4 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold border border-zinc-700 transition"
                      >
                        Detener transmisión
                      </button>
                    </div>
                  )}

                  {visibleSubtitleText && (
                    <div className={`pointer-events-none absolute flex justify-center px-6 text-center ${subtitleIsCustomPosition ? '' : 'inset-x-0'} ${subtitlePositionClass}`} style={subtitlePositionStyle}>
                      <div className={`max-w-4xl rounded bg-black/70 px-3 py-1 font-medium leading-relaxed text-white shadow-lg ${subtitleScaleClass}`}>
                        {visibleSubtitleText.split(/\r?\n/).map((line, index) => (
                          <div key={`${index}-${line}`}>{line}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ERROR OVERLAY Y REINTENTO */}
                  {playbackError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 px-6 text-center z-30">
                      <p className="text-sm text-zinc-200 max-w-md">{playbackError}</p>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={handleRetryCurrentServer}
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

                  {hasEnded && !playbackError && props.onNextEpisode && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 px-6 text-center z-30 pointer-events-auto backdrop-blur-sm animate-in fade-in duration-200">
                      <div className="max-w-sm w-full bg-zinc-900/95 border border-zinc-700/80 rounded-2xl p-6 shadow-2xl flex flex-col items-center gap-4">
                        {nextCountdown !== null && nextCountdown > 0 ? (
                          <>
                            <div className="inline-flex items-center gap-2 rounded-full bg-amber-400/10 border border-amber-400/30 px-3 py-1 text-amber-400 text-xs font-bold uppercase tracking-wider">
                              <Play size={12} className="fill-current" />
                              <span>Siguiente episodio en {nextCountdown}s</span>
                            </div>
                            <p className="text-sm font-semibold text-zinc-100 line-clamp-2">
                              {props.showTitle || media?.showTitle || 'Siguiente capítulo'}
                            </p>
                            <div className="flex items-center gap-2.5 w-full justify-center mt-1">
                              <button
                                type="button"
                                onClick={() => setNextCountdown(null)}
                                className="flex-1 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-300 transition"
                              >
                                Cancelar
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setNextCountdown(null);
                                  props.onNextEpisode?.();
                                }}
                                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-xs font-bold text-zinc-950 shadow-lg transition"
                              >
                                Reproducir ya <ChevronRight size={14} />
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="text-sm font-semibold text-zinc-100">
                              ¿Deseas ver el siguiente episodio?
                            </p>
                            <button
                              type="button"
                              onClick={props.onNextEpisode}
                              className="flex items-center gap-2 rounded-xl bg-amber-400 px-5 py-2.5 text-xs font-bold text-zinc-950 shadow-xl hover:bg-amber-300 transition"
                            >
                              Siguiente episodio <ChevronRight size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {/* BOTÓN FLOTANTE ESTILO NETFLIX EN CRÉDITOS / ÚLTIMOS 35 SEGUNDOS */}
                  {props.onNextEpisode && !hasEnded && duration > 40 && currentTime > 0 && (duration - currentTime) <= 35 && (duration - currentTime) > 1.5 && (
                    <div className="absolute bottom-20 right-6 z-30 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <button
                        type="button"
                        onClick={props.onNextEpisode}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-zinc-950 font-bold text-xs shadow-2xl shadow-amber-500/20 transition-all hover:scale-105 active:scale-95 border border-amber-300"
                        title="Reproducir siguiente episodio ahora"
                      >
                        <span>Siguiente episodio</span>
                        <SkipForward size={14} className="fill-current" />
                      </button>
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
          data-player-controls
          className={`absolute bottom-0 inset-x-0 z-50 flex flex-col bg-gradient-to-t from-black/95 via-black/70 to-transparent px-1 sm:px-6 pt-2.5 sm:pt-6 pb-2 sm:pb-4 transition-opacity duration-300 ${
            !isScreenLocked && (controlsVisible || !isPlaying) ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {activeServer && !activeServer.isEmbed && (
            <>
              {/* TIEMPO Y ESTADO EN MÓVIL (se coloca arriba de la barra para no apretar los botones) */}
              <div className="flex sm:hidden items-center justify-between text-[11px] font-mono text-zinc-300 px-1 mb-1.5 select-none">
                <span>
                  {formatTime(effectiveCurrentTime)} <span className="text-zinc-600">/</span> {formatTime(effectiveDuration)}
                </span>
                <span className="text-[10px] font-mono text-emerald-400 font-medium">
                  {currentResolutionLabel}
                </span>
              </div>

              {/* LÍNEA DE TIEMPO / SCRUBBER CON BUFFER Y PREVISUALIZACIÓN DE TIEMPO */}
              <div
                className={`group relative h-1.5 sm:h-2 w-full rounded-full bg-zinc-800/80 mb-2 sm:mb-3 flex items-center ${
                  isViewerMode ? 'opacity-50 cursor-not-allowed pointer-events-none' : 'cursor-pointer'
                }`}
                onMouseMove={!isViewerMode ? handleScrubberMouseMove : undefined}
                onMouseLeave={!isViewerMode ? handleScrubberMouseLeave : undefined}
              >
                {/* TOOLTIP FLOTANTE DE TIEMPO AL PASAR EL CURSOR */}
                {hoverTime && !isViewerMode && (
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
                  data-player-scrubber-thumb
                  className={`absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-white shadow-md opacity-0 group-hover:opacity-100 transition-opacity ${
                    isViewerMode ? 'hidden' : ''
                  }`}
                  style={{ left: `${progressPct}%` }}
                />

                {/* INPUT RANGE INVISIBLE PARA ACCESIBILIDAD Y ARRASTRE */}
                <input
                  type="range"
                  min={0}
                  max={effectiveDuration || 0}
                  step={0.1}
                  value={effectiveCurrentTime}
                  onChange={handleSeek}
                  disabled={isViewerMode}
                  aria-label="Línea de tiempo del video"
                  className={`absolute inset-0 h-full w-full ${
                    isViewerMode ? 'cursor-not-allowed pointer-events-none' : 'cursor-pointer'
                  } opacity-0`}
                />
              </div>

              {/* FILA DE BOTONES DE CONTROL Y MENÚS */}
              <div className="flex items-center justify-between gap-1 sm:gap-3 w-full">
                {/* LADO IZQUIERDO: PLAY/PAUSE, SALTOS +/- 10S, VOLUMEN, TIEMPO */}
                <div className="flex items-center gap-0.5 sm:gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={togglePlay}
                    aria-label={effectiveIsPlaying ? 'Pausar' : 'Reproducir'}
                    title={isViewerMode ? 'Controlado por el anfitrión' : (effectiveIsPlaying ? 'Pausar' : 'Reproducir')}
                    className={`relative text-zinc-200 hover:text-white transition p-0.5 sm:p-1.5 rounded-lg ${
                      isViewerMode ? 'opacity-60 cursor-not-allowed' : ''
                    }`}
                  >
                    {isViewerMode && (
                      <span className="absolute -top-1 -right-1 p-0.5 bg-zinc-900 border border-amber-500/50 rounded-full text-amber-400">
                        <Lock size={9} />
                      </span>
                    )}
                    {effectiveIsPlaying ? <Pause size={16} className="fill-current sm:w-5 sm:h-5" /> : <Play size={16} className="fill-current ml-0.5 sm:w-5 sm:h-5" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => seekOffset(-10)}
                    data-mobile-player-secondary
                    disabled={isViewerMode}
                    aria-label="Retroceder 10 segundos"
                    className={`text-zinc-400 hover:text-white transition p-0.5 sm:p-1 ${
                      isViewerMode ? 'opacity-40 cursor-not-allowed' : ''
                    }`}
                    title={isViewerMode ? 'Controlado por el anfitrión' : 'Retroceder 10s (←)'}
                  >
                    <RotateCcw size={14} className="sm:w-4 sm:h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={() => seekOffset(10)}
                    data-mobile-player-secondary
                    disabled={isViewerMode}
                    aria-label="Adelantar 10 segundos"
                    className={`text-zinc-400 hover:text-white transition p-0.5 sm:p-1 ${
                      isViewerMode ? 'opacity-40 cursor-not-allowed' : ''
                    }`}
                    title={isViewerMode ? 'Controlado por el anfitrión' : 'Adelantar 10s (→)'}
                  >
                    <RotateCw size={14} className="sm:w-4 sm:h-4" />
                  </button>

                  {/* BOTÓN SIGUIENTE EPISODIO EN REPRODUCTOR */}
                  {props.onNextEpisode && (
                    <button
                      type="button"
                      onClick={props.onNextEpisode}
                      data-mobile-player-secondary
                      aria-label="Reproducir siguiente episodio"
                      className="text-zinc-300 hover:text-amber-400 transition flex items-center p-0.5 sm:px-2 sm:py-1 rounded-md sm:rounded-lg sm:bg-white/5 sm:hover:bg-white/10 sm:border sm:border-white/10 text-xs font-semibold"
                      title="Siguiente episodio"
                    >
                      <SkipForward size={14} className="fill-current sm:w-[15px] sm:h-[15px]" />
                      <span className="hidden md:inline">Siguiente</span>
                    </button>
                  )}

                  {/* CONTROL DE VOLUMEN */}
                  <div className="flex items-center gap-0.5 group/vol" data-mobile-player-secondary>
                    <button
                      type="button"
                      onClick={toggleMute}
                      aria-label="Silenciar o activar sonido"
                      className="text-zinc-300 hover:text-white transition p-0.5 sm:p-1.5"
                    >
                      {isMuted || volume === 0 ? (
                        <VolumeX size={14} className="sm:w-[18px] sm:h-[18px]" />
                      ) : volume < 0.5 ? (
                        <Volume1 size={14} className="sm:w-[18px] sm:h-[18px]" />
                      ) : (
                        <Volume2 size={14} className="sm:w-[18px] sm:h-[18px]" />
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

                  {/* DISPLAY DE TIEMPO FORMATEADO (solo visible en desktop) */}
                  <span className="hidden sm:inline font-mono text-xs text-zinc-300 tracking-tight shrink-0 ml-1">
                    {formatTime(effectiveCurrentTime)} <span className="text-zinc-600">/</span> {formatTime(effectiveDuration)}
                  </span>
                </div>

                {/* LADO DERECHO: AUDIO, SUBTÍTULOS, VELOCIDAD, CALIDAD, PIP, FULLSCREEN */}
                <div className="flex items-center gap-0.5 sm:gap-2 shrink-0">
                  {hasBurnedInSubtitles && subtitleTracks.length === 0 && (
                    <span
                      className="hidden sm:inline-block rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-300"
                      title="Este video trae los subtítulos incrustados por el proveedor"
                    >
                      Subtítulos incrustados
                    </span>
                  )}
                  {/* MENÚ DE IDIOMA / PISTAS DE AUDIO */}
                  {(audioTracks.length > 0 || renditionServers.length > 0) && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setActiveMenu((m) => (m === 'audio' ? 'none' : 'audio'))}
                        className={`text-zinc-300 hover:text-white p-1 sm:p-1.5 rounded-md sm:rounded-lg transition ${
                          activeMenu === 'audio' ? 'bg-zinc-800 text-white' : ''
                        }`}
                        title="Idioma de Audio"
                      >
                        <Languages size={15} className="sm:w-[17px] sm:h-[17px]" />
                      </button>
                      {activeMenu === 'audio' && (
                        <div className="absolute bottom-10 right-0 z-[100] w-56 max-w-[min(90vw,22rem)] max-h-[min(70vh,28rem)] overflow-y-auto overscroll-contain rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
                          <span className="block px-2.5 py-1 text-[10px] font-bold text-zinc-400 uppercase">
                            Idioma de Audio
                          </span>
                          {(() => {
                            const groups = new Map<string, AudioOption[]>();
                            for (const track of audioTracks) {
                              const key = normalizedLanguageKey(track.lang || track.name);
                              const list = groups.get(key) || [];
                              list.push(track);
                              groups.set(key, list);
                            }
                            return [...groups.entries()].map(([key, tracks]) => {
                              const expanded = Boolean(expandedAudioLanguages[key]);
                              const visible = expanded ? tracks : tracks.slice(0, 1);
                              return (
                                <div key={`audio-group-${key}`} className="mb-1 last:mb-0">
                                  {visible.map((track) => (
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
                                      <span className="truncate">{tracks.length > 1 ? `${languageDisplayName(key)} · ${track.name}` : track.name}</span>
                                      {activeAudioTrack === track.id && <Check size={12} />}
                                    </button>
                                  ))}
                                  {tracks.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => setExpandedAudioLanguages((state) => ({ ...state, [key]: !expanded }))}
                                      className="w-full px-2.5 py-1 text-left text-[10px] text-zinc-400 hover:text-zinc-200"
                                    >
                                      {expanded ? 'Ocultar opciones' : `Ver ${tracks.length - 1} opción${tracks.length > 2 ? 'es' : ''} más`}
                                    </button>
                                  )}
                                </div>
                              );
                            });
                          })()}
                          {renditionServers.length > 0 && (
                            <>
                              <span className="mt-1 block border-t border-zinc-800 px-2.5 pt-2 text-[10px] font-bold text-zinc-400 uppercase">
                                Fuentes por idioma
                              </span>
                              {renditionGroups.map(({ key, items }) => {
                                const expanded = Boolean(expandedAudioLanguages[`source:${key}`]);
                                const visible = expanded ? items : items.slice(0, 1);
                                return (
                                  <div key={`rendition-group-${key}`} className="mb-1 last:mb-0">
                                    {visible.map(({ server, index }) => (
                                      <button
                                        key={`rendition-${server.id}`}
                                        type="button"
                                        onClick={() => {
                                          handleServerChange(index);
                                          setActiveMenu('none');
                                        }}
                                        className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs rounded-lg transition ${
                                          activeServerIndex === index
                                            ? 'text-emerald-400 font-semibold bg-zinc-800'
                                            : 'text-zinc-200 hover:bg-zinc-800/60'
                                        }`}
                                      >
                                        <span className="truncate">{renditionDisplayName(key, items)} · {server.provider}</span>
                                        {activeServerIndex === index && <Check size={12} />}
                                      </button>
                                    ))}
                                    {items.length > 1 && (
                                      <button
                                        type="button"
                                        onClick={() => setExpandedAudioLanguages((state) => ({ ...state, [`source:${key}`]: !expanded }))}
                                        className="w-full px-2.5 py-1 text-left text-[10px] text-zinc-400 hover:text-zinc-200"
                                      >
                                        {expanded ? 'Ocultar opciones' : `Ver ${items.length - 1} servidor${items.length > 2 ? 'es' : ''} más`}
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* MENÚ DE SUBTÍTULOS */}
                  {subtitleTracks.length > 0 && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setActiveMenu((m) => (m === 'subtitles' ? 'none' : 'subtitles'))}
                        className={`p-1 sm:p-1.5 rounded-md sm:rounded-lg transition ${
                          activeSubtitleId !== 'off'
                            ? 'text-emerald-400 bg-emerald-500/10'
                            : activeMenu === 'subtitles'
                            ? 'bg-zinc-800 text-white'
                            : 'text-zinc-300 hover:text-white'
                        }`}
                        title="Subtítulos"
                      >
                        <Captions size={15} className="sm:w-[17px] sm:h-[17px]" />
                      </button>
                      {activeMenu === 'subtitles' && (
                        <div className="absolute bottom-10 right-0 z-[100] w-56 max-w-[min(90vw,22rem)] max-h-[min(70vh,28rem)] overflow-y-auto overscroll-contain rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
                          <div className="mb-1 flex items-center justify-between border-b border-zinc-800 px-2 pb-1.5">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Subtítulos</span>
                            <button
                              type="button"
                              onClick={() => setSubtitleSettingsOpen((open) => !open)}
                              aria-label="Ajustar sincronización de subtítulos"
                              aria-pressed={subtitleSettingsOpen}
                              title="Ajustar sincronización de subtítulos"
                              className={`rounded-md p-1 transition ${subtitleSettingsOpen ? 'bg-zinc-800 text-emerald-300' : 'text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200'}`}
                            >
                              <Settings2 size={14} />
                            </button>
                          </div>

                          {subtitleSettingsOpen && (
                            <div className="mb-1 space-y-2 border-b border-zinc-800 px-2 pb-2.5">
                              <div className="flex items-center justify-between gap-2">
                                <div>
                                  <p className="text-xs font-medium text-zinc-200">Ajuste independiente</p>
                                  <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-500">Se aplica solo a este contenido.</p>
                                </div>
                                <button
                                  type="button"
                                  onClick={resetSubtitleTiming}
                                  className="shrink-0 text-[10px] text-zinc-500 transition hover:text-zinc-200"
                                >
                                  Restablecer
                                </button>
                              </div>
                              <label className="block text-[10px] text-zinc-400">
                                Aplicar desde
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={subtitleStartInput}
                                  onChange={(event) => updateSubtitleTiming('startAt', event.target.value)}
                                  onBlur={() => normalizeSubtitleTimingInput('startAt')}
                                  placeholder="00:00"
                                  aria-label="Aplicar ajuste de subtítulos desde"
                                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none transition focus:border-emerald-400/70"
                                />
                              </label>
                              <label className="block text-[10px] text-zinc-400">
                                Desfase en segundos
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={subtitleOffsetInput}
                                  onChange={(event) => updateSubtitleTiming('offset', event.target.value)}
                                  onBlur={() => normalizeSubtitleTimingInput('offset')}
                                  placeholder="+00:00"
                                  aria-label="Desfase de subtítulos en segundos"
                                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none transition focus:border-emerald-400/70"
                                />
                                <span className="mt-1 block leading-relaxed text-zinc-600">Positivo retrasa los subtítulos; negativo los adelanta.</span>
                              </label>
                            </div>
                          )}

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
                          {subtitleGroups.map(({ key, items }) => {
                            const expanded = Boolean(expandedSubtitleLanguages[key]);
                            const visible = expanded ? items : items.slice(0, 1);
                            return (
                              <div key={`subtitle-group-${key}`} className="mb-1 last:mb-0">
                                {visible.map((sub: SubtitleTrack) => (
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
                                    <span className="truncate">{items.length > 1 ? `${languageDisplayName(key)} · ${sub.label}` : sub.label}</span>
                                    {activeSubtitleId === sub.id && <Check size={12} />}
                                  </button>
                                ))}
                                {items.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={() => setExpandedSubtitleLanguages((state) => ({ ...state, [key]: !expanded }))}
                                    className="w-full px-2.5 py-1 text-left text-[10px] text-zinc-400 hover:text-zinc-200"
                                  >
                                    {expanded ? 'Ocultar opciones' : `Ver ${items.length - 1} pista${items.length > 2 ? 's' : ''} más`}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* MENÚ DE VELOCIDAD DE REPRODUCCIÓN */}
                  <div className="relative" data-mobile-player-secondary>
                    <button
                      type="button"
                      onClick={() => setActiveMenu((m) => (m === 'speed' ? 'none' : 'speed'))}
                      className={`text-[10px] sm:text-xs font-mono font-medium px-1 py-0.5 sm:px-2 sm:py-1 rounded sm:rounded-lg transition sm:border ${
                        playbackRate !== 1
                          ? 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10'
                          : activeMenu === 'speed'
                          ? 'border-zinc-600 bg-zinc-800 text-white'
                          : 'sm:border-zinc-700/50 sm:bg-zinc-800/60 text-zinc-300 hover:text-white'
                      }`}
                      title="Velocidad de reproducción"
                    >
                      {playbackRate}x
                    </button>
                    {activeMenu === 'speed' && (
                      <div className="absolute bottom-10 right-0 z-[100] w-32 rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
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
                      className={`p-1 sm:p-1.5 rounded-md sm:rounded-lg transition ${
                        activeMenu === 'quality' ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:text-white'
                      }`}
                      title="Calidad de video"
                    >
                      <Settings size={15} className="sm:w-[17px] sm:h-[17px]" />
                    </button>
                    {activeMenu === 'quality' && (
                      <div className="absolute bottom-10 right-0 z-[100] w-44 rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
                        {/* ACCESO RÁPIDO: cambio de servidor desde la tuerquita de configuración */}
                        {showServerSelector && servers.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setActiveMenu('servers')}
                            className="quality-server-shortcut flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs rounded-lg transition text-amber-300 hover:bg-zinc-800/60 border-b border-zinc-800 rounded-b-none mb-1 pb-2"
                          >
                            <span className="flex items-center gap-1.5 font-semibold">
                              <Server size={12} />
                              Cambiar servidor
                            </span>
                            <ChevronRight size={12} />
                          </button>
                        )}
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

                  {/* BOTÓN TRANSMITIR A CHROMECAST / SMART TV */}
                  <button
                    type="button"
                    data-mobile-player-secondary
                    onClick={() => {
                      if (isCasting) {
                        endCastSession();
                      } else {
                        requestCastSession();
                      }
                    }}
                    className={`relative p-1 sm:p-1.5 rounded-md sm:rounded-lg transition flex items-center justify-center ${
                      isCasting
                        ? 'text-purple-400 bg-purple-500/20 shadow-sm'
                        : 'text-zinc-300 hover:text-white hover:bg-zinc-800/60'
                    }`}
                    title={
                      isCasting
                        ? `Transmitiendo en ${castDeviceName || 'Smart TV'} (clic para desconectar)`
                        : 'Transmitir a Smart TV / Chromecast'
                    }
                  >
                    <Cast size={15} className={`sm:w-[18px] sm:h-[18px] ${isCasting ? 'animate-pulse text-purple-400' : ''}`} />
                    <google-cast-launcher
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        opacity: 0,
                        cursor: 'pointer',
                      } as any}
                    />
                  </button>

                  {/* BLOQUEO DE PANTALLA / MODO FOCUS */}
                  <button
                    type="button"
                    data-mobile-player-secondary
                    onClick={handleLockScreen}
                    className="p-0.5 sm:p-1.5 rounded-md sm:rounded-lg text-zinc-300 hover:text-white hover:bg-zinc-800/60 transition"
                    title="Bloquear pantalla (Modo Focus)"
                    aria-label="Bloquear pantalla"
                  >
                    <Lock size={14} className="sm:w-[17px] sm:h-[17px]" />
                  </button>

                  {/* PICTURE IN PICTURE */}
                  <button
                    type="button"
                    data-mobile-player-secondary
                    onClick={togglePictureInPicture}
                    className={`p-0.5 sm:p-1.5 rounded-md sm:rounded-lg transition hidden sm:inline-flex ${
                      isPipActive ? 'text-emerald-400 bg-emerald-500/10' : 'text-zinc-300 hover:text-white'
                    }`}
                    title="Ventana flotante (PiP)"
                  >
                    <PictureInPicture size={14} className="sm:w-[17px] sm:h-[17px]" />
                  </button>

                  {/* PANTALLA COMPLETA */}
                  <button
                    type="button"
                    data-mobile-player-secondary
                    onClick={toggleFullscreen}
                    className="text-zinc-300 hover:text-white p-0.5 sm:p-1.5 rounded-md sm:rounded-lg transition"
                    title="Pantalla completa (F)"
                  >
                    {isFullscreen ? <Minimize size={14} className="sm:w-[17px] sm:h-[17px]" /> : <Maximize size={14} className="sm:w-[17px] sm:h-[17px]" />}
                  </button>

                  {/* Android/mobile overflow: secondary actions stay available
                      without occupying the control row permanently. */}
                  <div className="relative sm:hidden" data-mobile-player-overflow>
                    <button
                      type="button"
                      onClick={() => setActiveMenu((m) => (m === 'more' ? 'none' : 'more'))}
                      className={`p-1 rounded-md transition ${activeMenu === 'more' ? 'bg-zinc-800 text-white' : 'text-zinc-300'}`}
                      aria-label="Más controles"
                      title="Más controles"
                    >
                      <MoreVertical size={17} />
                    </button>
                    {activeMenu === 'more' && (
                      <>
                        <button
                          type="button"
                          className="native-player-more-backdrop"
                          aria-label="Cerrar más controles"
                          onClick={() => setActiveMenu('none')}
                        />
                        <div className="native-player-more-sheet">
                          <div className="native-player-more-handle" />
                          <div className="grid grid-cols-2 gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveMenu('none');
                              if (teleparty.isInRoom) setIsWatchPartyPanelOpen(true);
                              else setIsJoinModalOpen(true);
                            }}
                            className="mobile-player-more-action"
                          >
                            <Users size={14} /> {teleparty.isInRoom ? 'Watch Party' : 'Ver en grupo'}
                          </button>
                          <Suspense fallback={<div className="mobile-player-more-action opacity-60">Cargando reporte…</div>}>
                            <LazyReportControl
                              title={props.title || media?.title || 'esta obra'}
                              showId={props.showId || null}
                              tmdbId={props.tmdbId || null}
                              kind={props.kind || null}
                              episodeId={props.episodeId || null}
                              episodeNumber={props.episodeNumber || null}
                              sourceProvider={activeServer?.sourceSite || activeServer?.provider || null}
                              sourceUrl={activeServer?.canonical_locator || null}
                              className="mobile-player-more-action"
                            />
                          </Suspense>
                          <button type="button" onClick={() => { seekOffset(-10); setActiveMenu('none'); }} className="mobile-player-more-action">
                            <RotateCcw size={14} /> -10 s
                          </button>
                          <button type="button" onClick={() => { seekOffset(10); setActiveMenu('none'); }} className="mobile-player-more-action">
                            <RotateCw size={14} /> +10 s
                          </button>
                          {props.onNextEpisode && (
                            <button type="button" onClick={() => { setActiveMenu('none'); props.onNextEpisode?.(); }} className="mobile-player-more-action">
                              <SkipForward size={14} /> Siguiente
                            </button>
                          )}
                          <button type="button" onClick={() => { toggleMute(); setActiveMenu('none'); }} className="mobile-player-more-action">
                            {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />} {isMuted ? 'Activar audio' : 'Silenciar'}
                          </button>
                          <button
                            type="button"
                            className="mobile-player-more-action"
                            onClick={() => {
                              const title = props.title || media?.title || 'MeriStream';
                              setActiveMenu('none');
                              void nativeShare({
                                title,
                                text: `Estoy viendo ${title} en MeriStream`,
                                url: publicAppUrl(),
                                dialogTitle: 'Compartir desde MeriStream',
                              });
                            }}
                          >
                            <Share2 size={14} /> Compartir
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (isCasting) endCastSession();
                              else requestCastSession();
                              setActiveMenu('none');
                            }}
                            className="mobile-player-more-action"
                          >
                            <Cast size={14} /> {isCasting ? 'Desconectar TV' : 'Transmitir'}
                          </button>
                          <button type="button" onClick={() => { setActiveMenu('none'); handleLockScreen(); }} className="mobile-player-more-action">
                            <Lock size={14} /> Bloquear
                          </button>
                          <button type="button" onClick={() => { setActiveMenu('none'); void toggleFullscreen(); }} className="mobile-player-more-action">
                            {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />} Pantalla
                          </button>
                          <button type="button" onClick={() => { setActiveMenu('none'); void togglePictureInPicture(); }} className="mobile-player-more-action">
                            <PictureInPicture size={14} /> PiP
                          </button>
                        </div>
                        <div className="mt-2 border-t border-zinc-800 pt-2">
                          <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Velocidad</span>
                          <div className="grid grid-cols-6 gap-1">
                            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                              <button
                                key={rate}
                                type="button"
                                onClick={() => { handleSpeedChange(rate); setActiveMenu('none'); }}
                                className={`rounded-md px-1 py-1.5 text-[10px] font-mono ${playbackRate === rate ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-800 text-zinc-300'}`}
                              >
                                {rate}x
                              </button>
                            ))}
                          </div>
                        </div>
                        {servers.length > 1 && (
                          <div className="mt-2 border-t border-zinc-800 pt-2">
                            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Servidores</span>
                            <div className="max-h-40 space-y-1 overflow-y-auto overscroll-contain">
                              {servers.map((server, index) => {
                                const status = serverHealthMap[server.id] || 'unverified';
                                return (
                                  <button
                                    key={server.id}
                                    type="button"
                                    onClick={() => {
                                      handleServerChange(index);
                                      setActiveMenu('none');
                                    }}
                                    className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${
                                      activeServerIndex === index ? 'bg-emerald-500/12 text-emerald-300' : 'bg-zinc-800/70 text-zinc-200'
                                    }`}
                                  >
                                    <span className={`h-2 w-2 shrink-0 rounded-full ${
                                      status === 'online' ? 'bg-emerald-400' : status === 'failed' ? 'bg-rose-400' : status === 'checking' ? 'bg-amber-400' : 'bg-zinc-500'
                                    }`} />
                                    <span className="min-w-0 flex-1 truncate">
                                      {server.sourceSite ? String(server.sourceSite).toUpperCase() : server.provider || server.label}
                                    </span>
                                    <span className="text-[10px] text-zinc-500">{index + 1}/{servers.length}</span>
                                    {activeServerIndex === index && <Check size={13} />}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ========================================================================= */}
        {/* BLOQUEO DE PANTALLA (MODO FOCUS / NATIVE SCREEN LOCK)                     */}
        {/* ========================================================================= */}
        {isScreenLocked && (
          <div
            className="absolute inset-0 z-[85] flex items-center justify-center pointer-events-auto"
            onClick={(e) => {
              e.stopPropagation();
              showLockWidgetTemporarily();
            }}
          >
            {/* Botón flotante central de desbloqueo (se muestra al tocar la pantalla) */}
            <div
              className={`transition-all duration-300 transform ${
                showLockWidget
                  ? 'opacity-100 scale-100 pointer-events-auto'
                  : 'opacity-0 scale-90 pointer-events-none'
              }`}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleUnlockScreen();
                }}
                className="flex items-center gap-3 px-6 py-3 rounded-full bg-zinc-950/95 hover:bg-zinc-900 border-2 border-amber-400 text-white shadow-[0_0_35px_rgba(245,158,11,0.4)] backdrop-blur-lg transition hover:scale-105 active:scale-95 cursor-pointer"
                title="Toca para desbloquear la pantalla"
                aria-label="Desbloquear pantalla"
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-400/20 text-amber-400">
                  <Unlock size={18} />
                </div>
                <div className="flex flex-col text-left">
                  <span className="text-xs font-bold text-white tracking-wide">
                    Pantalla protegida
                  </span>
                  <span className="text-[10px] text-amber-300">
                    Toca para desbloquear controles
                  </span>
                </div>
              </button>
            </div>

            {/* Salida de emergencia en esquina superior cuando el botón está visible */}
            <div
              className={`absolute top-4 right-4 z-[90] transition-opacity duration-300 ${
                showLockWidget ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
              }`}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleUnlockScreen();
                  handleClose();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white text-xs shadow-xl transition"
                title="Cerrar reproductor"
              >
                <X size={14} />
                <span>Salir</span>
              </button>
            </div>
          </div>
        )}

        {/* TOAST DE CONTROLES BLOQUEADOS PARA ESPECTADOR */}
        {viewerLockToast && (
          <div
            data-testid="viewer-lock-toast"
            className="absolute top-20 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-950/90 border border-amber-500/60 text-amber-200 text-xs font-medium shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-150 pointer-events-none"
          >
            <Lock size={14} className="text-amber-400 shrink-0" />
            <span>{viewerLockToast}</span>
          </div>
        )}

        {/* PANEL LATERAL / BOTTOM-SHEET DE WATCH PARTY */}
        <WatchPartyPanel
          isOpen={isWatchPartyPanelOpen}
          onClose={() => setIsWatchPartyPanelOpen(false)}
          room={teleparty.room}
          participants={teleparty.participants}
          messages={teleparty.messages}
          reactions={teleparty.reactions}
          isHost={teleparty.isHost}
          sendMessage={teleparty.sendMessage}
          sendReaction={teleparty.sendReaction}
          currentUserId={props.userId || null}
          onLeaveRoom={handleLeaveWatchParty}
        />

        {/* MODAL PARA CREAR O UNIRSE A SALA DE WATCH PARTY */}
        <WatchPartyJoinModal
          isOpen={isJoinModalOpen}
          onClose={() => setIsJoinModalOpen(false)}
          onJoin={handleJoinWatchParty}
          media={{
            title: displayTitle,
            posterUrl: media?.poster_url || props.item?.poster_url || null,
            poster_url: media?.poster_url || props.item?.poster_url || null,
            kind: props.kind || (media as any)?.kind || 'movie',
            showId: props.showId || null,
            episodeId: props.episodeId || null,
            episodeNumber: props.episodeNumber || null,
            streamUrl: activeServer?.url || props.streamUrl || null,
            tmdbId: props.tmdbId || null,
            serverId: activeServer?.id || null,
            sourceSite: activeServer?.sourceSite || null,
            provider: activeServer?.provider || null,
            canonicalLocator: activeServer?.canonical_locator || activeServer?.original_url || null,
          }}
        />
      </div>
    );
}
