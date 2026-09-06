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
  Check,
  Languages,
  PictureInPicture,
  ChevronRight,
  Zap,
  Info,
} from 'lucide-react';
import { api, type PlaybackResolution } from '../api/client';
import type { MediaStreamOut, SubtitleTrack, MediaStreamVariant, RankedStream } from '../types';
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
  DIRECT_WATCHDOG_MS,
  DIRECT_BLACK_SCREEN_MS,
  EMBED_FAILOVER_TIMEOUT_MS,
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
  const autoFailoverCountRef = useRef<number>(0);

  // Identificador creciente por intento (protección contra carreras): cualquier
  // temporizador o promesa que termine después de cambiar de servidor se ignora.
  const attemptIdRef = useRef<number>(0);
  // Regla 7: Un servidor no puede intentarse más de una vez por modo dentro del mismo intento de reproducción.
  const attemptedModesRef = useRef<Set<string>>(new Set());

  // Telemetría de salud y detección de pantalla negra / stalls
  const loadStartMsRef = useRef<number>(Date.now());
  const blackScreenTimerRef = useRef<NodeJS.Timeout | null>(null);
  const proxyRequestInFlightRef = useRef<boolean>(false);
  const playbackConfirmedRef = useRef<boolean>(false);
  const bufferCountRef = useRef<number>(0);
  const bufferingStartMsRef = useRef<number | null>(null);
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
  // Aviso con acción manual: un embed sin confirmar deja de hacer failover
  // automático; se muestra una notificación interactiva para que el usuario elija.
  const [embedStall, setEmbedStall] = useState<{ message: string; targetIndex: number } | null>(null);

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
  const [deliveryState, setDeliveryState] = useState<DeliveryState>('resolving');
  const [, setActiveSessionUrl] = useState<string | null>(null);
  const directWatchdogRef = useRef<NodeJS.Timeout | null>(null);
  const renewalTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Limpieza de listeners nativos del <video> para poder eliminarlos en cada
  // cambio de servidor (fantasmas de un intento anterior).
  const nativeListenersCleanupRef = useRef<(() => void) | null>(null);

  // SELECTOR MANUAL: SIEMPRE visible con >1 servidor. Antes era "oculto por defecto"
  // (gate serverSelectorVisible / toggle en Configuración / F4), pero un embed que
  // falla en silencio —ej. Mega con archivo muerto— nunca activaba playbackError ni
  // agotaba la cascada, y el usuario quedaba atrapado en un servidor muerto sin
  // forma de cambiar. El toggle de Configuración y su listener quedaron obsoletos.

  // Controles de UI & Auto-Hide
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hoverTime, setHoverTime] = useState<{ time: number; posPercent: number } | null>(null);
  const [activeMenu, setActiveMenu] = useState<'none' | 'quality' | 'audio' | 'subtitles' | 'speed' | 'servers'>('none');

  // Listener de eventos postMessage para ZokoAnime embed
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://zokoanime.video') return;
      const { type, payload } = event.data || {};
      if (type === 'progress' && payload && typeof payload.currentTime === 'number') {
        const duration = payload.duration || 0;
        props.onProgressUpdate?.(payload.currentTime, duration);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [props.onProgressUpdate]);

  // Menús de Configuración de Video
  const [qualityLevels, setQualityLevels] = useState<{ index: number; label: string; height?: number }[]>([]);
  const [activeQuality, setActiveQuality] = useState<number>(-1); // -1 = Auto
  const [currentResolutionLabel, setCurrentResolutionLabel] = useState<string>('Auto (Máxima Calidad)');
  const [audioTracks, setAudioTracks] = useState<AudioOption[]>([]);
  const [activeAudioTrack, setActiveAudioTrack] = useState<number>(-1);
  const [activeSubtitleId, setActiveSubtitleId] = useState<string | 'off'>('off');

  const subtitleTracks: SubtitleTrack[] = resolvedSubtitleTracks.length > 0
    ? resolvedSubtitleTracks
    : (streamInfo?.subtitles || []);
  const renditionServers = servers
    .map((server, index) => ({ server, index }))
    .filter(({ server }) => Boolean(server.link_type || server.language || server.audio_language || server.subtitle_language));

  const renditionLabel = (server: ScoredServer): string => {
    const linkType = (server.link_type || '').toLowerCase();
    const rendition = (server.language || '').toLowerCase();
    const audio = server.audio_language?.toUpperCase();
    const subtitle = server.subtitle_language?.toUpperCase();
    if (rendition === 'dub' || linkType === 'dub' || audio === 'ES' || audio === 'EN') {
      return `Audio ${audio || 'Doblado'}`;
    }
    if (rendition === 'sub' || linkType === 'sub' || subtitle) {
      return `Subtítulos ${subtitle || 'Originales'}`;
    }
    return server.language?.toUpperCase() || 'Idioma alternativo';
  };

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
        setServers(ranked);
        const firstPlayableIdx = ranked.findIndex((s) => !isExpiredWithoutLocator(s) && !s.notPlayable);
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

  const activeServer = servers[activeServerIndex] || null;

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

    const isDirectMedia =
      /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(server.url) ||
      server.url.includes('/m3u8/') ||
      server.url.includes('/api/v1/stream/mega');

    const signedNeedsJit =
      hasExpiringSignature(server.url) &&
      (!server.expires_at || server.expires_at <= Date.now()) &&
      !server.resolved_at;

    const embedNeedsJit = server.isEmbed && !server.resolved_at && !isDirectMedia;
    const needsJit = server.notPlayable === true || isUnresolvedCanonical(server.url) || signedNeedsJit || embedNeedsJit;
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
          const isMediaUrl = (value: string) =>
            /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(value) ||
            value.includes('/m3u8/') ||
            value.includes('.m3u8') ||
            value.includes('/api/v1/proxy/stream');
          const ranked = Array.isArray(episodeResult.ranked_streams) ? episodeResult.ranked_streams : [];
          const first = ranked.find((candidate) => candidate?.url && (candidate.type === 'direct' || isMediaUrl(candidate.url))) || ranked[0];
          const resolvedUrl = first?.url || episodeResult.stream_url || '';
          const resolved = Boolean(episodeResult.resolved && resolvedUrl && resolvedUrl !== locator && !isUnresolvedCanonical(resolvedUrl));
          return {
            url: resolved ? resolvedUrl : locator,
            original_url: locator,
            canonical_locator: locator,
            resolved,
            type: resolved && first?.type !== 'embed' ? 'direct' as const : 'embed' as const,
            delivery_mode: resolved && first?.type !== 'embed' ? 'direct_trial' as const : 'embed' as const,
            is_proxyable: resolved,
            is_refreshable: true,
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
          if (isUnresolvedCanonical(server.url)) {
            setCanonicalResolveError('No se pudo extraer un stream reproducible de esta página.');
            setDeliveryState('error');
          } else {
            setDeliveryState('playing_direct');
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
                return false;
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

  // Fallback Mega: dado un stream local /api/v1/stream/mega?url=..., derivar la URL
  // /embed/ oficial para inyectarla como iframe si el descifrado nativo falla (cuota).
  const megaEmbedFallback = (streamLocalUrl: string): string | null => {
    try {
      const q = new URL(streamLocalUrl, window.location.origin).searchParams.get('url');
      if (!q || !q.includes('mega.nz')) return null;
      const m = /^https?:\/\/(www\.)?mega\.nz\/file\/([A-Za-z0-9_-]+)#(.+)$/.exec(q);
      return m ? `https://mega.nz/embed/${m[2]}#${m[3]}` : null;
    } catch {
      return null;
    }
  };

  // Convierte el servidor activo Mega-nativo a modo iframe embed (fallback por cuota)
  const failoverMegaToEmbed = () => {
    if (!activeServer) return false;
    const embedUrl = megaEmbedFallback(activeServer.url);
    if (!embedUrl) return false;

    if (blackScreenTimerRef.current) clearTimeout(blackScreenTimerRef.current);
    api.reportPlayerEvent({
      eventType: "quota_fallback",
      provider: activeServer.provider || "MEGA",
      serverUrl: activeServer.url,
      mediaTitle: props.title || media?.title,
      details: "Cuota MEGA excedida -> fallback a embed",
    });

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }

    setServers((prev) => {
      const copy = [...prev];
      if (copy[activeServerIndex]) {
        copy[activeServerIndex] = {
          ...copy[activeServerIndex],
          url: embedUrl,
          isEmbed: true,
          streamType: 'embed',
          label: `${copy[activeServerIndex].provider} (Embed)`,
        };
      }
      return copy;
    });
    setFailoverNotice('Cuota de MEGA agotada: cambiando al reproductor embebido...');
    setTimeout(() => setFailoverNotice(null), 4000);
    return true;
  };

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
    proxyRequestInFlightRef.current = false;
    setActiveSessionUrl(null);
    playbackConfirmedRef.current = false;
    loadStartMsRef.current = Date.now();
    // Descartar cualquier aviso manual de embed pendiente al cambiar de servidor.
    setEmbedStall(null);

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
    }

    // Destruir la instancia HLS anterior y eliminar listeners nativos pendientes.
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
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

    // Watchdog de pantalla negra: si tras 6.5s no arranca frames ni playback, reportar stall
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

    const setupHls = (playUrl: string) => {
      const isHlsUrl = playUrl.includes('.m3u8') || playUrl.includes('/m3u8/');
      if (isHlsUrl && Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 60,
          maxBufferLength: 30, // Front buffer moderado
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
          setEmbedStall(null);
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
            return;
          }
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
          if (sessionIsHls && Hls.isSupported()) {
            setupHls(finalUrl);
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
    if (isHls && Hls.isSupported()) {
      setupHls(finalUrl);
    } else if (video.canPlayType('application/vnd.apple.mpegurl') || true) {
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
    if (activeServer && !activeServer.isEmbed && !isCanonicalPending && lastAttachmentKey.current !== key) {
      if (videoRef.current) {
        lastAttachmentKey.current = key;
        attachSource(activeServer.url || '');
      } else {
        // Si el elemento <video> aún no está montado (transición desde iframe), reintentar en el siguiente frame
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
  }, [activeServer, attachSource]);

  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (directWatchdogRef.current) clearTimeout(directWatchdogRef.current);
      if (renewalTimerRef.current) clearTimeout(renewalTimerRef.current);
      if (blackScreenTimerRef.current) clearTimeout(blackScreenTimerRef.current);
      if (nativeListenersCleanupRef.current) {
        nativeListenersCleanupRef.current();
        nativeListenersCleanupRef.current = null;
      }
    };
  }, []);

  // 3.1 INTENTO DE RESOLUCIÓN ON-DEMAND PARA SERVIDORES EMBED
  // Un embed NO resoluble por HTTP (resolved:false) NO se descarta: el iframe puede
  // seguir siendo válido. Solo se degrada/propaga a si el backend extrae un stream
  // nativo, y el failover de un iframe ocurre únicamente por error verificable,
  // acción manual, timeout largo controlado o mensaje explícito del iframe.
  useEffect(() => {
    let cancelled = false;
    if (!activeServer || !activeServer.isEmbed) return;
    if (activeServer.url.includes("mega.nz/embed")) {
      recordAttemptedMode(attemptedModesRef.current, activeServer.id, 'embed');
      setDeliveryState('playing_embed');
      return;
    }

    const attemptId = attemptIdRef.current;
    recordAttemptedMode(attemptedModesRef.current, activeServer.id, 'embed');

    const isPlaceholderUrl = (u: string) => {
      const lower = u.toLowerCase();
      return (
        lower.includes('big_buck_bunny') ||
        lower.includes('big-buck-bunny') ||
        lower.includes('bigbuckbunny') ||
        lower.endsWith('_5mb.mp4')
      );
    };

    // Timeout largo y controlado: tras ese tiempo sin señal de vida, NO failover
    // automático — solo mostramos un aviso con acción manual para que el usuario
    // decida si cambiar de servidor (un embed cross-origin puede estar sano aunque
    // no podamos verificar su reproducción).
    let resolveTimer: NodeJS.Timeout | null = null;
    const startResolveTimeout = () => {
      resolveTimer = setTimeout(() => {
        if (cancelled || attemptId !== attemptIdRef.current) return;
        if (!playbackConfirmedRef.current && activeServerIndex < servers.length - 1) {
          setDeliveryState('awaiting_manual_choice');
          setEmbedStall({
            message: `El reproductor embebido no confirmó reproducción tras ${Math.round(
              EMBED_FAILOVER_TIMEOUT_MS / 1000
            )}s. ¿Deseas mantenerlo o probar el siguiente servidor?`,
            targetIndex: activeServerIndex + 1,
          });
        }
      }, EMBED_FAILOVER_TIMEOUT_MS);
    };

    setDeliveryState('resolving');

    api.resolveEmbed(activeServer.url)
      .then((res) => {
        if (cancelled || attemptId !== attemptIdRef.current) return;

        // Regla 1: expired_without_locator jamás entra en trying_direct ni requesting_proxy
        if (res.failure_reason === 'expired_without_locator') {
          if (activeServerIndex < servers.length - 1) {
            handleServerChange(activeServerIndex + 1, true);
          } else {
            setDeliveryState('error');
            setPlaybackError(MSG_EXPIRED_WITHOUT_LOCATOR);
          }
          return;
        }

        // Embed NO resoluble por HTTP o página canónica:
        if (!res || !res.resolved || !res.url) {
          if (isUnresolvedCanonical(activeServer.url)) {
            // Una página web canónica no resuelta NO es un embed real reproducible.
            setDeliveryState('resolving');
            setFailoverNotice('Página no reproducible directamente. Esperando resolución...');
            return;
          }
          setDeliveryState('playing_embed');
          setFailoverNotice('El servidor se mantiene como reproductor embebido.');
          setTimeout(() => setFailoverNotice(null), 2500);
          return;
        }

        // El host sirve un demo placeholder (ej. VOE -> Big Buck Bunny): failover al
        // siguiente server solo si hay más opciones.
        if (isPlaceholderUrl(res.url)) {
          if (activeServerIndex < servers.length - 1) {
            setFailoverNotice('Servidor sin contenido real, cambiando de servidor...');
            setTimeout(() => setFailoverNotice(null), 3000);
            handleServerChange(activeServerIndex + 1, true);
          } else {
            setDeliveryState('error');
            setPlaybackError(MSG_NO_SERVERS);
          }
          return;
        }

        // El servidor logró extraer el .m3u8 o .mp4 nativo: actualizamos con TODA
        // la metadata de resolución (no solo la url) conservando el embed original.
        setServers((prev) => {
          const copy = [...prev];
          if (copy[activeServerIndex]) {
              copy[activeServerIndex] = applyResolution(copy[activeServerIndex], {
              url: res.url,
              original_url: res.original_url,
              resolved: true,
              type: res.type,
              delivery_mode: res.delivery_mode,
              provider: res.provider,
              canonical_locator: res.canonical_locator,
              resolution_id: res.resolution_id,
              generation: res.generation,
              is_proxyable: res.is_proxyable,
              is_refreshable: res.is_refreshable,
              refresh_after: res.refresh_after,
              expires_at: res.expires_at,
              resolved_at: res.resolved_at,
              failure_reason: res.failure_reason,
                requiredHeaders: res.requiredHeaders,
                subtitles: res.subtitles,
              });
          }
          return copy;
        });

        if (res.subtitles && res.subtitles.length > 0) {
          setResolvedSubtitleTracks(res.subtitles.map((track, index) => ({
            id: track.id || `resolved-sub-${index}`,
            label: track.label || track.language || `Subtítulo ${index + 1}`,
            language: track.language || 'en',
            url: track.url || track.src || '',
            is_default: Boolean(track.is_default ?? index === 0),
          })).filter((track) => Boolean(track.url)));
        }

        if (res.type === 'direct' || res.delivery_mode === 'direct' || res.delivery_mode === 'proxy_required') {
          setFailoverNotice(`Stream nativo optimizado con éxito (${res.provider || 'Servidor'})`);
          setTimeout(() => setFailoverNotice(null), 3000);
        } else {
          setDeliveryState('playing_embed');
        }
      })
      .catch(() => {
        // Error de red/timeout del resolve: NO failover automático; el iframe sigue
        // siendo válido si era un embed real y el timeout largo controlado decidirá si finalmente falla.
        if (!cancelled && attemptId === attemptIdRef.current) {
          if (!isUnresolvedCanonical(activeServer.url)) {
            setDeliveryState('playing_embed');
          } else {
            setDeliveryState('resolving');
          }
        }
      })
      .finally(() => {
        if (!cancelled && attemptId === attemptIdRef.current && !resolveTimer) {
          startResolveTimeout();
        }
      });

    return () => {
      cancelled = true;
      if (resolveTimer) clearTimeout(resolveTimer);
    };
  }, [activeServerIndex, activeServer?.url, activeServer?.isEmbed, servers.length]);

  // 3.2 TELEMETRÍA Y WATCHDOG PARA SERVIDORES EMBED
  useEffect(() => {
    if (!activeServer || !activeServer.isEmbed) return;

    loadStartMsRef.current = Date.now();
    playbackConfirmedRef.current = false;
    if (blackScreenTimerRef.current) clearTimeout(blackScreenTimerRef.current);

    api.reportPlayerEvent({
      eventType: "embed_opened",
      provider: activeServer.provider || "Servidor Embed",
      serverUrl: activeServer.url,
      mediaTitle: props.title || media?.title,
      details: "Abierto reproductor embebido (iframe con posibles anuncios o redirects)",
    });

    // Watchdog para embeds: si tarda >8s sin confirmación
    blackScreenTimerRef.current = setTimeout(() => {
      if (!playbackConfirmedRef.current) {
        api.reportPlayerEvent({
          eventType: "black_screen_stalled",
          provider: activeServer.provider || "Servidor Embed",
          serverUrl: activeServer.url,
          mediaTitle: props.title || media?.title,
          durationBeforeErrorMs: Date.now() - loadStartMsRef.current,
          details: "El embed tardó >8s en responder o quedó bloqueado",
        });
      }
    }, 8000);

    return () => {
      if (blackScreenTimerRef.current) clearTimeout(blackScreenTimerRef.current);
    };
  }, [activeServer?.url, activeServer?.isEmbed, props.title, media?.title]);

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
        setEmbedStall(null);
      }

      // Confirmar playback saludable y cancelar watchdog de pantalla negra y directo
      if (!playbackConfirmedRef.current && video.currentTime > 0.3) {
        playbackConfirmedRef.current = true;
        if (blackScreenTimerRef.current) clearTimeout(blackScreenTimerRef.current);
        if (directWatchdogRef.current) clearTimeout(directWatchdogRef.current);
        setPlaybackError(null);
        setEmbedStall(null);
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
      setEmbedStall(null);
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

    const onPlaying = () => {
      if (listenerAttemptId !== attemptIdRef.current) return;
      setIsPlaying(true);
      setPlaybackError(null);
      setEmbedStall(null);
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
    };

    const onStalled = () => {
      api.reportPlayerEvent({
        eventType: "playback_buffering",
        provider: activeServer.provider || "Servidor",
        serverUrl: activeServer.url,
        mediaTitle: props.title || media?.title,
        details: "Descarga de datos de video detenida por lentitud de CDN (stalled)",
      });
    };

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

        // Fallback específico Mega: cuota de transferencia agotada → iframe /embed/ oficial
        if (activeServer.url.includes('/api/v1/stream/mega') && failoverMegaToEmbed()) return;
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
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('error', onError);
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

  // REINTENTO REAL (R4): reinicia el estado del servidor activo y fuerza el
  // pipeline completo (re-resolve JIT si aplica → attachSource/embed). Antes el
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
      // El iframe se remonta por la key={activeServer.url}; forzar remount
      // cambiando temporalmente el índice no es necesario: recrear el objeto
      // servidor dispara los efectos de resolución/attach.
      setServers((prev) => {
        const copy = [...prev];
        if (copy[activeServerIndex]) {
          copy[activeServerIndex] = { ...copy[activeServerIndex] };
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
        className={`relative flex h-full w-full flex-col justify-between bg-black sm:h-[92vh] sm:w-[96vw] sm:rounded-2xl sm:border sm:border-zinc-800/80 shadow-2xl overflow-hidden ${
          !controlsVisible && isPlaying ? 'cursor-none' : ''
        }`}
      >
        {/* ========================================================================= */}
        {/* 1. TOP BAR MODERNA Y ELEGANTE (SIN SLOP)                                   */}
        {/* ========================================================================= */}
        <div
          data-player-topbar
          className={`absolute top-0 inset-x-0 z-40 flex items-center justify-between px-4 sm:px-6 py-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-300 ${
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
            {/* SELECTOR DE SERVIDORES: SIEMPRE disponible mientras haya >1 opción.
                (Antes dependía de serverSelectorVisible, pero un embed que falla
                "silenciosamente" —ej. Mega con archivo muerto— nunca activaba
                playbackError y el selector jamás aparecía.) */}
            {/* SELECTOR DE SERVIDORES DESDE EL HEADER SUPERIOR (Visible siempre que haya al menos 1 servidor) */}
            {servers.length >= 1 && (
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
                  <div className="absolute right-0 top-11 w-64 rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-2 shadow-2xl backdrop-blur-xl z-50">
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
                                      ? 'Reproductor Web (Embed)'
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

        {/* AVISO CON ACCIÓN MANUAL: embed sin confirmar (NO failover automático) */}
        {embedStall && (
          <div className="absolute top-16 inset-x-0 z-50 flex justify-center animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="rounded-lg bg-zinc-900/95 border border-amber-500/50 px-4 py-3 text-xs text-amber-200 shadow-xl backdrop-blur-md flex flex-col gap-2 max-w-md">
              <div className="flex items-center gap-2 font-medium">
                <Zap size={14} className="animate-pulse text-amber-400" />
                <span>{embedStall.message}</span>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setEmbedStall(null);
                    setDeliveryState('playing_embed');
                  }}
                  className="pointer-events-auto rounded-md border border-zinc-600 px-3 py-1 text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  Mantener
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const target = embedStall.targetIndex;
                    setEmbedStall(null);
                    handleServerChange(target, false);
                  }}
                  className="pointer-events-auto rounded-md bg-amber-500 px-3 py-1 font-semibold text-zinc-950 hover:bg-amber-400 transition-colors"
                >
                  Cambiar al siguiente servidor
                </button>
              </div>
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
              {isUnresolvedCanonical(activeServer.url) || activeServer.notPlayable ? (
                /* ESTADO RESOLVIENDO FUENTE CANÓNICA NO RESUELTA */
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
                      {canonicalResolveError || 'Esta página canónica no contiene un reproductor directo y se está extrayendo su stream nativo.'}
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
              ) : activeServer.isEmbed && !isUnresolvedCanonical(activeServer.url) ? (
                /* REPRODUCTOR EMBEBIDO CON PROTECCIÓN SANDBOX ANTI-POPUPS */
                <div className="relative w-full h-full flex flex-col items-center justify-center bg-black">
                  <iframe
                    key={activeServer.id}
                    src={activeServer.url}
                    className="w-full h-full border-0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                    allowFullScreen
                    sandbox={
                      activeServer.url.includes('megaplay') || activeServer.url.includes('zokoanime')
                        ? undefined
                        : 'allow-forms allow-scripts allow-same-origin allow-presentation'
                    }
                    title={activeServer.label || 'Reproductor Embebido'}
                  />
                </div>
              ) : (
                /* MODO NATIVO HLS */
                <>
                  <video
                    ref={videoRef}
                    className="h-full w-full object-contain"
                    playsInline
                    preload="auto"
                  >
                    {subtitleTracks.map((sub: SubtitleTrack) => (
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
                          {renditionServers.length > 0 && (
                            <>
                              <span className="mt-1 block border-t border-zinc-800 px-2.5 pt-2 text-[10px] font-bold text-zinc-400 uppercase">
                                Fuentes por idioma
                              </span>
                              {renditionServers.map(({ server, index }) => (
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
                                  <span className="truncate">{renditionLabel(server)} · {server.provider}</span>
                                  {activeServerIndex === index && <Check size={12} />}
                                </button>
                              ))}
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
                          {subtitleTracks.map((sub: SubtitleTrack) => (
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
                        {/* ACCESO RÁPIDO: cambio de servidor desde la tuerquita de configuración */}
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
