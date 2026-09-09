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
  Check,
  Languages,
  PictureInPicture,
  ChevronRight,
  Zap,
  Info,
} from 'lucide-react';
import { api, type PlaybackResolution } from '../api/client';
import type { MediaStreamOut, SubtitleTrack, MediaStreamVariant, RankedStream } from '../types';
import { parseWebVttCues, type ParsedSubtitleCue } from '../utils/subtitleFormat';
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
  ranked_streams?: RankedStream[];
  /** Pistas externas opcionales (por ejemplo OpenSubtitles) ya normalizadas. */
  subtitleTracks?: SubtitleTrack[];
  initialTime?: number;
  onProgressUpdate?: (currentTime: number, duration: number) => void;
  onNextEpisode?: () => void;
  userId?: string | null;
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
  const { media, onClose, directSource = null } = props;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoNode, setVideoNode] = useState<HTMLVideoElement | null>(null);
  const videoCallbackRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    setVideoNode(node);
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  // dash.js se carga solo cuando se selecciona un manifiesto MPD.
  const dashRef = useRef<any>(null);
  const hideControlsTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastUpdateRef = useRef<number>(0);
  const autoFailoverCountRef = useRef<number>(0);

  // Identificador creciente por intento (protección contra carreras): cualquier
  // temporizador o promesa que termine después de cambiar de servidor se ignora.
  const attemptIdRef = useRef<number>(0);
  // Regla 7: Un servidor no puede intentarse más de una vez por modo dentro del mismo intento de reproducción.
  const attemptedModesRef = useRef<Set<string>>(new Set());
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
  const [serverHealthMap, setServerHealthMap] = useState<Record<string, 'online' | 'checking' | 'failed'>>({});
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

  // SELECTOR MANUAL: visible con >1 candidato para permitir elegir otra fuente
  // nativa cuando el watchdog o la resolución JIT marcan una fuente como caída.

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
  const [activeSubtitleCues, setActiveSubtitleCues] = useState<ParsedSubtitleCue[]>([]);
  const [expandedAudioLanguages, setExpandedAudioLanguages] = useState<Record<string, boolean>>({});
  const [expandedSubtitleLanguages, setExpandedSubtitleLanguages] = useState<Record<string, boolean>>({});
  const [preferencesRevision, setPreferencesRevision] = useState(0);
  const preferenceScope = props.userId || 'guest';
  const appPreferences = getAppPreferences(preferenceScope);

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
  const subtitleSourceUrl = (track: SubtitleTrack): string => {
    const parsedUrl = new URL(track.url, window.location.href);
    if (parsedUrl.origin === window.location.origin) return parsedUrl.toString();
    const isOpenSubtitles = /(^|\.)opensubtitles\.(org|com)$/i.test(parsedUrl.hostname);
    if (isOpenSubtitles) {
      return `/api/v1/proxy/subtitle?url=${encodeURIComponent(parsedUrl.toString())}`;
    }
    return `/api/v1/proxy/stream?referer=${encodeURIComponent(`${parsedUrl.origin}/`)}&url=${encodeURIComponent(parsedUrl.toString())}`;
  };

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

  const visibleSubtitleText = activeSubtitleCues
    .filter((cue) => currentTime >= cue.startTime && currentTime < cue.endTime)
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

  useEffect(() => {
    if (activeSubtitleId !== 'off' || subtitleTracks.length === 0) return;
    const preferred = appPreferences.preferredSubtitleLanguages
      .map((language) => normalizedLanguageKey(language));
    const track = subtitleTracks.find((candidate) => preferred.includes(normalizedLanguageKey(candidate.language || candidate.label)));
    if (track) setActiveSubtitleId(track.id);
  }, [subtitleSignature, activeSubtitleId, appPreferences.preferredSubtitleLanguages.join(',')]);

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

      // Inicializar todos los servidores como disponibles ('online') por defecto.
      // Probar latencia en segundo plano para enriquecer la UI sin bloquear ni marcar servidores falsamente como muertos.
      const initialMap: Record<string, 'online' | 'checking' | 'failed'> = {};
      ranked.forEach((s) => {
        initialMap[s.id] = 'online';
      });
      setServerHealthMap(initialMap);

      const probeCandidates = ranked.slice(0, MAX_PROBE_CANDIDATES);
      probeCandidates.forEach((srv) => {
        if (!srv.isEmbed && !srv.notPlayable) {
          quickProbeServerHealth(srv, 2500).then((lat) => {
            if (!cancelled && lat !== null) {
              setServerHealthMap((prev) => ({
                ...prev,
                [srv.id]: 'online',
              }));
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
    setCanonicalResolveError(null);
    setDeliveryState('resolving');

    // Las páginas canónicas de episodio necesitan el adaptador del proveedor
    // (AnimeFLV/TioAnime/Cinecalidad/etc.), no el resolver genérico de embeds.
    // Ese endpoint sigue siendo JIT y no escribe en la BD, pero sí ejecuta la
    // receta correcta de catálogo → episodio → media.
    const resolutionPromise = isUnresolvedCanonical(locator)
      ? api.getEpisodeServers(locator).then((episodeResult) => {
          const isMediaUrl = (value: string) => isNativeMediaUrl(value);
          const ranked = Array.isArray(episodeResult.ranked_streams) ? episodeResult.ranked_streams : [];
          const first = ranked.find((candidate) => candidate?.url && candidate.type !== 'embed' && isMediaUrl(candidate.url));
          const streamUrl = typeof episodeResult.stream_url === 'string' ? episodeResult.stream_url : '';
          const resolvedUrl = first?.url || (isMediaUrl(streamUrl) ? streamUrl : '');
          const resolved = Boolean(episodeResult.resolved && resolvedUrl && resolvedUrl !== locator && isMediaUrl(resolvedUrl));
          return {
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
      })
      .finally(() => {
        jitInFlightRef.current.delete(jitKey);
      });

    return () => {
      cancelled = true;
    };
  }, [activeServer?.id, activeServer?.url, activeServer?.isEmbed, activeServer?.notPlayable, activeServer?.canonical_locator, activeServerIndex, servers.length, canonicalResolveError]);

  // 2. CAMBIO DE SERVIDOR MANUAL O POR FAILOVER AUTOMÁTICO
  const handleServerChange = (index: number, isAutoFailover = false) => {
    if (index === activeServerIndex && !isAutoFailover) return;
    if (index >= servers.length || index < 0) return;

    // Protección contra carreras: invalidar TODOS los temporizadores/promesas del
    // intento anterior (punto 6 y 7).
    attemptIdRef.current += 1;
    const targetIndex = index;
    const currentPosition = videoRef.current?.currentTime || currentTime;
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

    const currentSrv = servers[activeServerIndex];
    if (isAutoFailover && currentSrv) {
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

    setPlaybackError(null);
    setHasEnded(false);
    setIsPlaying(false);
    setQualityLevels([]);
    setActiveQuality(-1);
    setAudioTracks([]);
    setActiveAudioTrack(-1);
    setActiveMenu('none');

    if (isAutoFailover) {
      const targetSrv = servers[targetIndex];
      setFailoverNotice(`Conectando automáticamente a servidor de respaldo (${targetSrv?.label || 'Respaldo'})...`);
      setTimeout(() => setFailoverNotice(null), 3000);
    }

    setActiveServerIndex(targetIndex);
  };

  // 3. CONEXIÓN NATIVA AL STREAM CON HLS.JS (SELECCIONANDO MÁXIMA CALIDAD AL INSTANTE)
  const attachSource = useCallback((url: string) => {
    const video = videoRef.current;
    if (!video || !url || activeServer?.isEmbed) return;

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

    // Watchdog de pantalla negra: si tras 6.5s no arranca frames ni playback,
    // registrar el fallo y avanzar al siguiente candidato nativo.
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
        setServerHealthMap((prev) => ({ ...prev, [activeServer.id]: 'failed' }));
        if (activeServerIndex < servers.length - 1) {
          handleServerChange(activeServerIndex + 1, true);
        } else {
          setDeliveryState('error');
          setPlaybackError(MSG_NO_SERVERS);
        }
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
      if (activeServer) {
        setServerHealthMap((prev) => ({ ...prev, [activeServer.id]: 'online' }));
      }
    };

    const setupDash = async (playUrl: string) => {
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

    const setupHls = (playUrl: string) => {
      const isHlsUrl = playUrl.includes('.m3u8') || playUrl.includes('/m3u8/');
      if (isHlsUrl && Hls.isSupported()) {
        const deviceMemory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory || 8);
        const constrainedDevice = (navigator.hardwareConcurrency || 8) <= 4 || deviceMemory <= 4;
        const hls = new Hls({
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

        // Cuando se analiza el manifiesto, extraemos las calidades e iniciamos en la más alta
        hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
          if (attemptId !== attemptIdRef.current) return;
          // MANIFEST_PARSED => el directo arrancó: cancelar el watchdog directo.
          if (directWatchdogRef.current) clearTimeout(directWatchdogRef.current);
          playbackConfirmedRef.current = true;
          // Un intento anterior puede haber dejado un mensaje de fallo mientras
          // este manifiesto se resolvía. Un manifiesto válido invalida ese aviso.
          setPlaybackError(null);
          setDeliveryState(prev => prev === 'trying_direct' ? 'playing_direct' : prev);
          if (activeServer) {
            setServerHealthMap((prev) => ({ ...prev, [activeServer.id]: 'online' }));
          }
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

          // Reproducir automáticamente de manera fluida
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

          // Watchdog congelado en segundo 0
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
        });

        // Extraer pistas de audio (multiaudio si el contenido lo incluye)
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_evt, data) => {
          if (attemptId !== attemptIdRef.current) return;
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
          if (attemptId !== attemptIdRef.current) return;
          const lvl = hls.levels[data.level];
          if (lvl && lvl.height) {
            setCurrentResolutionLabel(`${lvl.height}p ${lvl.height >= 1080 ? 'Full HD' : 'HD'}`);
          }
        });

        // Algunos hosts publican una variante HD que queda obsoleta antes que
        // las demás. HLS.js la marca como `levelLoadError` fatal después de
        // varios reintentos y el flujo anterior saltaba de inmediato a otro
        // proveedor, aunque el mismo manifiesto todavía tuviera una calidad
        // inferior reproducible. Retirar esa variante y continuar en la
        // siguiente evita el fallback en cascada sin ocultar un fallo real del
        // servidor completo.
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

        // ERRORES FATALES Y NO FATALES (SEGMENTOS, BUFFER, PROTOCOLO)
        hls.on(Hls.Events.ERROR, (_evt, data) => {
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

          if (recoverUnavailableLevel(data)) {
            console.warn('HLS variant unavailable; continuing with a lower quality level', data.level);
            return;
          }

          console.warn('HLS Fatal Error:', data.type, data.details);

          // Regla 3: Un fallo directo puede escalar a proxy únicamente si is_proxyable !== false
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

          // Servidor falló definitivamente en ambos modos (directo y proxy)
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

          // Si hay más servidores en la lista, pasar automáticamente al siguiente una sola vez
          if (activeServerIndex < servers.length - 1) {
            const nextIdx = activeServerIndex + 1;
            setFailoverNotice(`Cambiando a ${servers[nextIdx]?.label || 'siguiente servidor'}...`);
            setTimeout(() => setFailoverNotice(null), 3000);
            handleServerChange(nextIdx, true);
          } else {
            setDeliveryState('error');
            setPlaybackError(MSG_NO_SERVERS);
          }
        });
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
    let finalUrl = url;

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
          finalUrl = session.playback_url;
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
          const sessionIsHls = finalUrl.includes('.m3u8') || finalUrl.includes('/m3u8/');
          const sessionIsDash = /\.mpd(?:[?#]|$)/i.test(finalUrl);
          if (sessionIsHls && Hls.isSupported()) {
            setupHls(finalUrl);
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
      // Solo si el directo no produjo progreso ni manifest parsed.
      if (!playbackConfirmedRef.current) {
        directWatchdogRef.current = null;
        if (canEscalateToProxy(activeServer) && !hasAttemptedMode(attemptedModesRef.current, activeServer.id, 'proxy')) {
          console.warn("Direct stream sin confirmar, solicitando proxy...");
          setDeliveryCapability(url, 'proxy_required', activeServer.provider);
          setServers((prev) => {
            const copy = [...prev];
            if (copy[activeServerIndex]) {
              copy[activeServerIndex] = { ...copy[activeServerIndex], delivery_mode: 'proxy_required' };
            }
            return copy;
          });
          attachSource(url);
        } else {
          // No es proxyable o ya se intentó proxy: avanzar al siguiente servidor si existe
          if (activeServerIndex < servers.length - 1) {
            handleServerChange(activeServerIndex + 1, true);
          } else {
            setDeliveryState('error');
            setPlaybackError(MSG_NO_SERVERS);
          }
        }
      }
    }, DIRECT_WATCHDOG_MS);

    const isHls = finalUrl.includes('.m3u8') || finalUrl.includes('/m3u8/');
    const isDash = /\.mpd(?:[?#]|$)/i.test(finalUrl);
    if (isHls && Hls.isSupported()) {
      setupHls(finalUrl);
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
        if (activeServer) {
          setServerHealthMap((prev) => ({ ...prev, [activeServer.id]: 'online' }));
        }
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
  }, [activeServer, activeServerIndex, servers.length, props.initialTime, props.title, media?.title]);

  // CLAVE DE CONEXIÓN (punto 8): detecta cambios REALES de URL/generación/delivery,
  // no solo el índice. Una URL nueva en el mismo índice reconecta HLS.js.
  const lastAttachmentKey = useRef<string>('');
  useEffect(() => {
    const key = buildAttachmentKey(activeServer);
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
      // `attachSource` owns the direct/proxy decision. Calling it for every
      // resolved candidate lets sources that require request headers (for
      // example ZokoAnime's CDN) create the internal playback session instead
      // of being attached directly by this bookkeeping effect.
      if (videoRef.current) {
        lastAttachmentKey.current = key;
        attachSource(activeServer.url || '');
      } else {
        // Si el elemento <video> aún no está montado durante la transición, reintentar en el siguiente frame
        const timer = requestAnimationFrame(() => {
          if (videoRef.current) {
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
  }, [activeServer, activeSessionUrl, attachSource]);

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
      setCurrentTime(video.currentTime);

      // Si el elemento ya avanza, cualquier overlay de un intento anterior es
      // obsoleto. Esto cubre el caso en que un error nativo tardío llegó justo
      // después de que HLS.js había comenzado a reproducir.
      if (video.currentTime > 0.3 && !video.paused) {
        setPlaybackError(null);
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
        // Waiting is normal during a slow segment. Only move providers when the
        // playhead has not advanced at all during the grace window and the
        // element is still genuinely starved; a transient buffer gap must not
        // restart the whole source cascade.
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
          details: "El stream quedó detenido durante la reproducción; se activa failover automático",
        });
        setServerHealthMap((prev) => ({ ...prev, [activeServer.id]: 'failed' }));
        if (activeServerIndex < servers.length - 1) {
          handleServerChange(activeServerIndex + 1, true);
        } else {
          setDeliveryState('error');
          setPlaybackError(MSG_NO_SERVERS);
        }
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
      setIsPlaying(false);
      setHasEnded(true);
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
  }, [activeServer, activeServerIndex, servers.length, props.title, media?.title]);

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
  const subtitlePositionClass = appPreferences.subtitlePosition === 'top'
    ? 'top-20'
    : appPreferences.subtitlePosition === 'center'
    ? 'top-1/2 -translate-y-1/2'
    : 'bottom-20';
  const subtitleScaleClass = appPreferences.subtitleScale === 'large'
    ? 'text-lg sm:text-xl'
    : appPreferences.subtitleScale === 'small'
    ? 'text-sm sm:text-base'
    : 'text-base sm:text-lg';

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
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 backdrop-blur-xl p-0 sm:p-4 select-none animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      onMouseMove={showControlsTemporarily}
      onMouseDown={showControlsTemporarily}
    >
      <div
        ref={containerRef}
        className={`relative isolate flex h-full w-full flex-col justify-between bg-black sm:h-[92vh] sm:w-[96vw] sm:rounded-2xl sm:border sm:border-zinc-800/80 shadow-2xl overflow-hidden ${
          !controlsVisible && isPlaying ? 'cursor-none' : ''
        }`}
      >
        {/* ========================================================================= */}
        {/* 1. TOP BAR MODERNA Y ELEGANTE (SIN SLOP)                                   */}
        {/* ========================================================================= */}
        <div
          data-player-topbar
          className={`absolute top-0 inset-x-0 z-50 flex items-center justify-between px-4 sm:px-6 py-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-300 ${
            controlsVisible || !isPlaying || Boolean(playbackError) ? 'opacity-100' : 'opacity-0 pointer-events-none'
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
            {/* La cascada selecciona automáticamente, pero el selector queda
                disponible cuando existen varias fuentes. */}
            {showServerSelector && servers.length > 1 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setActiveMenu((m) => (m === 'servers' ? 'none' : 'servers'))}
                  className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border backdrop-blur-md transition ${
                    activeMenu === 'servers'
                      ? 'bg-zinc-800 text-white border-zinc-600'
                      : 'bg-zinc-900/80 text-zinc-300 hover:text-white border-zinc-700/60'
                  }`}
                  title="Cambiar o Inspeccionar Servidor de Streaming"
                >
                  <Server size={13} className="text-emerald-400" />
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
                  <ChevronRight size={12} className={activeMenu === 'servers' ? 'rotate-90' : ''} />
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
                          const status = serverHealthMap[srv.id] || 'online';
                          const isJit = Boolean(isUnresolvedCanonical(srv.url) || srv.canonical_locator || srv.is_refreshable);
                          const effectiveSiteLabel = siteLabel || (srv.sourceSite ? String(srv.sourceSite).toUpperCase() : '');
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
                                      : isJit && !srv.resolved_at
                                      ? 'bg-sky-400 shadow-sm shadow-sky-400/50'
                                      : 'bg-emerald-500 shadow-sm shadow-emerald-500/50'
                                  }`}
                                  title={
                                    status === 'failed'
                                      ? 'Falló reproducción previa (clic para reintentar)'
                                      : status === 'checking'
                                      ? 'Comprobando respuesta...'
                                      : isJit && !srv.resolved_at
                                      ? 'Servidor Canónico (Resolución JIT)'
                                      : 'Servidor Verificado (Online)'
                                  }
                                />
                                <div className="flex flex-col truncate">
                                  <span className="truncate">
                                    {srv.label}
                                  </span>
                                  <span className="text-[10px] text-zinc-500 font-mono">
                                    {isJit && !srv.resolved_at
                                      ? 'Resolución JIT al reproducir'
                                      : srv.isEmbed
                                      ? 'Locator de proveedor (se resuelve JIT)'
                                      : srv.url.includes('/api/v1/stream/mega')
                                      ? 'Mega Directo (Nativo, con subtítulos)'
                                      : 'Stream Directo (HLS)'}
                                    {srv.latencyMs ? ` • ${srv.latencyMs}ms` : ''}
                                    {status === 'failed' ? ' • Clic para reintentar' : ''}
                                  </span>
                                </div>
                              </div>
                              {effectiveSiteLabel && (
                                <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 uppercase font-bold tracking-wide">
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
              {activeServer.isEmbed || isUnresolvedCanonical(activeServer.url) || activeServer.notPlayable ? (
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
                /* MODO NATIVO HLS/DASH/MP4 */
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

                  {visibleSubtitleText && (
                    <div className={`pointer-events-none absolute inset-x-0 z-20 flex justify-center px-6 text-center ${subtitlePositionClass}`}>
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
                    <div className="absolute inset-0 flex items-center justify-center bg-black/45 px-6 text-center z-20 pointer-events-none">
                      <button
                        type="button"
                        onClick={props.onNextEpisode}
                        className="pointer-events-auto flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-xl hover:bg-emerald-500 transition"
                      >
                        Siguiente episodio <ChevronRight size={14} />
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
          className={`absolute bottom-0 inset-x-0 z-50 flex flex-col bg-gradient-to-t from-black/90 via-black/60 to-transparent px-4 sm:px-6 pt-6 pb-4 transition-opacity duration-300 ${
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
                  {hasBurnedInSubtitles && subtitleTracks.length === 0 && (
                    <span
                      className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-300"
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
                        className={`text-zinc-300 hover:text-white p-1.5 rounded-lg transition ${
                          activeMenu === 'audio' ? 'bg-zinc-800 text-white' : ''
                        }`}
                        title="Idioma de Audio"
                      >
                        <Languages size={17} />
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
                        <div className="absolute bottom-10 right-0 z-[100] w-56 max-w-[min(90vw,22rem)] max-h-[min(70vh,28rem)] overflow-y-auto overscroll-contain rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
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
                      className={`p-1.5 rounded-lg transition ${
                        activeMenu === 'quality' ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:text-white'
                      }`}
                      title="Calidad de video"
                    >
                      <Settings size={17} />
                    </button>
                    {activeMenu === 'quality' && (
                      <div className="absolute bottom-10 right-0 z-[100] w-44 rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
                        {/* ACCESO RÁPIDO: cambio de servidor desde la tuerquita de configuración */}
                        {showServerSelector && servers.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setActiveMenu('servers')}
                            className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs rounded-lg transition text-amber-300 hover:bg-zinc-800/60 border-b border-zinc-800 rounded-b-none mb-1 pb-2"
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

        </div>
      </div>
    </div>
  );
}
