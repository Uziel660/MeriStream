// src/hooks/useChromecast.ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { SubtitleTrack } from "../types";
import { isNativeShell } from "../utils/runtime";

declare global {
  interface Window {
    __onGCastApiAvailable?: (isAvailable: boolean) => void;
    cast?: any;
    chrome?: any;
  }
}


const GOOGLE_CAST_SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
let castSdkPromise: Promise<boolean> | null = null;

function ensureGoogleCastSdk(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.cast?.framework && window.chrome?.cast) return Promise.resolve(true);
  if (castSdkPromise) return castSdkPromise;

  castSdkPromise = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      if (ready) {
        window.dispatchEvent(new CustomEvent('google-cast-ready'));
      }
      resolve(ready);
    };

    const previous = window.__onGCastApiAvailable;
    window.__onGCastApiAvailable = (isAvailable: boolean) => {
      if (typeof previous === 'function') {
        try { previous(isAvailable); } catch {}
      }
      if (isAvailable) {
        queueMicrotask(() => finish(Boolean(window.cast?.framework && window.chrome?.cast)));
      } else {
        finish(false);
      }
    };

    let script = document.querySelector<HTMLScriptElement>('script[data-meristream-cast-sdk="true"]');
    if (!script) {
      script = document.createElement('script');
      script.src = GOOGLE_CAST_SDK_URL;
      script.async = true;
      script.defer = true;
      script.dataset.meristreamCastSdk = 'true';
      script.onerror = () => finish(false);
      document.head.appendChild(script);
    }

    window.setTimeout(() => finish(Boolean(window.cast?.framework && window.chrome?.cast)), 12_000);
  });

  return castSdkPromise;
}

export interface CastMediaOptions {
  url: string;
  title?: string;
  seriesTitle?: string;
  poster?: string;
  currentTime?: number;
  isHls?: boolean;
  isDash?: boolean;
  subtitles?: SubtitleTrack[];
  activeSubtitleId?: string | number | null;
}

export interface UseChromecastReturn {
  isCastAvailable: boolean;
  isCasting: boolean;
  deviceName: string | null;
  remoteCurrentTime: number;
  remoteDuration: number;
  remoteIsPaused: boolean;
  remoteLoadState: 'idle' | 'loading' | 'playing' | 'error';
  remoteLoadError: string | null;
  requestCastSession: () => void;
  endCastSession: () => void;
  loadMediaOnCast: (opts: CastMediaOptions) => Promise<boolean>;
  castPlay: () => void;
  castPause: () => void;
  castStop: () => void;
  castSeek: (time: number) => void;
  castSetVolume: (vol: number) => void;
  castSetMuted: (muted: boolean) => void;
}

export function useChromecast(
  onRemoteTimeUpdate?: (time: number) => void,
  onRemoteEnded?: () => void
): UseChromecastReturn {
  const [isCastAvailable, setIsCastAvailable] = useState<boolean>(false);
  const [isCasting, setIsCasting] = useState<boolean>(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [remoteCurrentTime, setRemoteCurrentTime] = useState<number>(0);
  const [remoteDuration, setRemoteDuration] = useState<number>(0);
  const [remoteIsPaused, setRemoteIsPaused] = useState<boolean>(true);
  const [remoteLoadState, setRemoteLoadState] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [remoteLoadError, setRemoteLoadError] = useState<string | null>(null);

  const remotePlayerRef = useRef<any>(null);
  const remotePlayerControllerRef = useRef<any>(null);
  const onRemoteTimeUpdateRef = useRef(onRemoteTimeUpdate);
  const onRemoteEndedRef = useRef(onRemoteEnded);

  useEffect(() => {
    onRemoteTimeUpdateRef.current = onRemoteTimeUpdate;
  }, []);

  useEffect(() => {
    onRemoteEndedRef.current = onRemoteEnded;
  }, [onRemoteEnded]);

  // 1. Inicialización del SDK de Google Cast.
  // Desktop loads it after the first render; Android defers the external SDK
  // until the user actually taps Cast so low-end startup stays cheap.
  useEffect(() => {
    const setupRemotePlayer = () => {
      if (!window.cast?.framework || !window.chrome?.cast || remotePlayerRef.current) return;
      try {
        const context = window.cast.framework.CastContext.getInstance();
        if (!(window as any).__gcast_initialized) {
          context.setOptions({
            receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
            androidReceiverCompatible: false,
          });
          (window as any).__gcast_initialized = true;
        }
        setIsCastAvailable(true);

        const player = new window.cast.framework.RemotePlayer();
        const controller = new window.cast.framework.RemotePlayerController(player);
        remotePlayerRef.current = player;
        remotePlayerControllerRef.current = controller;

        controller.addEventListener(
          window.cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
          () => {
            const connected = Boolean(player.isConnected);
            setIsCasting(connected);
            if (connected) {
              const session = context.getCurrentSession();
              setDeviceName(session?.getCastDevice()?.friendlyName || "Chromecast");
            } else {
              setDeviceName(null);
              setRemoteLoadState('idle');
              setRemoteLoadError(null);
            }
          }
        );

        controller.addEventListener(
          window.cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED,
          () => setRemoteIsPaused(Boolean(player.isPaused))
        );

        controller.addEventListener(
          window.cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
          () => {
            const time = Number(player.currentTime || 0);
            setRemoteCurrentTime(time);
            onRemoteTimeUpdateRef.current?.(time);
          }
        );

        controller.addEventListener(
          window.cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED,
          () => {
            const state = player.playerState;
            const idleReason = player.idleReason;
            const duration = Number(player.duration || 0);
            const currentTime = Number(player.currentTime || 0);

            if (state === 'PLAYING' || state === 'PAUSED') {
              setRemoteLoadState('playing');
              setRemoteLoadError(null);
            } else if (state === 'BUFFERING') {
              setRemoteLoadState('loading');
            } else if (state === 'IDLE' && (idleReason === 'ERROR' || idleReason === window.chrome?.cast?.media?.IdleReason?.ERROR)) {
              setRemoteLoadState('error');
              setRemoteLoadError('El Chromecast no pudo descargar o decodificar esta fuente.');
            }

            const isFinished =
              idleReason === window.chrome?.cast?.media?.IdleReason?.FINISHED ||
              idleReason === 'FINISHED' ||
              (state === 'IDLE' && duration > 0 && currentTime >= duration - 2);
            if (isFinished) onRemoteEndedRef.current?.();
          }
        );

        controller.addEventListener(
          window.cast.framework.RemotePlayerEventType.DURATION_CHANGED,
          () => setRemoteDuration(Number(player.duration || 0))
        );

        const currentSession = context.getCurrentSession();
        if (currentSession) {
          setIsCasting(true);
          setDeviceName(currentSession.getCastDevice()?.friendlyName || "Chromecast");
        }
      } catch (err) {
        console.warn("[Chromecast] Error configurando RemotePlayer:", err);
      }
    };

    const onReady = () => setupRemotePlayer();
    window.addEventListener('google-cast-ready', onReady);

    if (window.cast?.framework && window.chrome?.cast) {
      setupRemotePlayer();
    } else if (!isNativeShell()) {
      const schedule = typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback(() => { void ensureGoogleCastSdk().then((ready) => ready && setupRemotePlayer()); }, { timeout: 2500 })
        : window.setTimeout(() => { void ensureGoogleCastSdk().then((ready) => ready && setupRemotePlayer()); }, 1500);
      return () => {
        window.removeEventListener('google-cast-ready', onReady);
        if (typeof schedule === 'number') {
          if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(schedule);
          else window.clearTimeout(schedule);
        }
      };
    }

    return () => window.removeEventListener('google-cast-ready', onReady);
  }, []);

  // 2. Solicitar conexión directa a dispositivo
  const requestCastSession = useCallback(async () => {
    try {
      if (!window.cast?.framework || !window.chrome?.cast) {
        const ready = await ensureGoogleCastSdk();
        if (!ready) {
          setRemoteLoadState('error');
          setRemoteLoadError('Google Cast no está disponible en este dispositivo.');
          return;
        }
        window.dispatchEvent(new CustomEvent('google-cast-ready'));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      if (window.cast?.framework) {
        const context = window.cast.framework.CastContext.getInstance();
        if (!(window as any).__gcast_initialized && window.chrome?.cast) {
          context.setOptions({
            receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
            androidReceiverCompatible: false,
          });
          (window as any).__gcast_initialized = true;
        }
        await context.requestSession().catch((err: any) => {
          if (err !== "cancel") {
            console.warn("[Chromecast] Error en requestSession:", err);
          }
        });
        return;
      }

      if (window.chrome?.cast?.requestSession) {
        window.chrome.cast.requestSession(
          (session: any) => {
            setIsCasting(true);
            setDeviceName(session?.receiver?.friendlyName || "TV");
          },
          (err: any) => {
            if (err?.code !== "cancel") console.warn("[Chromecast] Request error:", err);
          }
        );
      }
    } catch (err: any) {
      if (err !== 'cancel') {
        console.warn("[Chromecast] Error invocando selector nativo:", err);
        setRemoteLoadState('error');
        setRemoteLoadError('No se pudo abrir el selector de dispositivos.');
      }
    }
  }, []);

  // 3. Finalizar sesión
  const endCastSession = useCallback(() => {
    if (!window.cast?.framework) return;
    try {
      const context = window.cast.framework.CastContext.getInstance();
      context.endCurrentSession(true);
      setIsCasting(false);
      setDeviceName(null);
      setRemoteLoadState('idle');
      setRemoteLoadError(null);
    } catch (err) {
      console.warn("[Chromecast] Error terminando sesión:", err);
    }
  }, []);

  // 4. Cargar video / stream en el Chromecast
  const loadMediaOnCast = useCallback(
    async (opts: CastMediaOptions): Promise<boolean> => {
      if (!window.cast?.framework || !window.chrome?.cast) return false;
      const context = window.cast.framework.CastContext.getInstance();
      const session = context.getCurrentSession();
      if (!session) return false;

      try {
        setRemoteLoadState('loading');
        setRemoteLoadError(null);
        // Asegurar URL absoluta
        let absoluteUrl = opts.url;
        if (!/^https?:\/\//i.test(absoluteUrl)) {
          absoluteUrl = new URL(opts.url, window.location.origin).href;
        }

        console.log("[Chromecast] Invocando loadMedia en TV:", absoluteUrl, opts);

        const isHls = opts.isHls || absoluteUrl.includes(".m3u8") || absoluteUrl.includes("/m3u8/");
        const isDash = opts.isDash || /\.mpd(?:[?#]|$)/i.test(absoluteUrl);
        const contentType = isHls
          ? "application/x-mpegurl"
          : isDash
          ? "application/dash+xml"
          : "video/mp4";

        const mediaInfo = new window.chrome.cast.media.MediaInfo(absoluteUrl, contentType);

        // Metadata para mostrar en pantalla de TV
        const metadata = new window.chrome.cast.media.GenericMediaMetadata();
        metadata.title = opts.title || "MeriStream";
        if (opts.seriesTitle) {
          metadata.subtitle = opts.seriesTitle;
        }
        if (opts.poster) {
          let posterUrl = opts.poster;
          if (!/^https?:\/\//i.test(posterUrl)) {
            posterUrl = new URL(opts.poster, window.location.origin).href;
          }
          metadata.images = [new window.chrome.cast.Image(posterUrl)];
        }
        mediaInfo.metadata = metadata;

        // Subtítulos
        let activeTrackIds: number[] = [];
        if (opts.subtitles && opts.subtitles.length > 0) {
          const tracks: any[] = [];
          opts.subtitles.forEach((sub, idx) => {
            const trackId = idx + 1;
            const track = new window.chrome.cast.media.Track(
              trackId,
              window.chrome.cast.media.TrackType.TEXT
            );
            let subUrl = sub.url;
            if (!/^https?:\/\//i.test(subUrl)) {
              subUrl = new URL(sub.url, window.location.origin).href;
            }
            track.trackContentId = subUrl;
            track.trackContentType = "text/vtt";
            track.subtype = window.chrome.cast.media.TextTrackSubtype.SUBTITLES;
            track.name = sub.label || sub.language || `Subtítulo ${trackId}`;
            track.language = sub.language || "es";
            tracks.push(track);

            if (opts.activeSubtitleId && (sub.id === opts.activeSubtitleId || sub.url === opts.activeSubtitleId)) {
              activeTrackIds.push(trackId);
            }
          });
          mediaInfo.tracks = tracks;

          const textTrackStyle = new window.chrome.cast.media.TextTrackStyle();
          textTrackStyle.backgroundColor = "#000000B0";
          textTrackStyle.foregroundColor = "#FFFFFF";
          textTrackStyle.fontScale = 1.1;
          textTrackStyle.fontFamily = "sans-serif";
          mediaInfo.textTrackStyle = textTrackStyle;
        }

        const request = new window.chrome.cast.media.LoadRequest(mediaInfo);
        request.currentTime = opts.currentTime || 0;
        request.autoplay = true;
        if (activeTrackIds.length > 0) {
          request.activeTrackIds = activeTrackIds;
        }

        const loadResult = await session.loadMedia(request);
        console.log("[Chromecast] loadMedia exitoso en TV:", loadResult);
        setIsCasting(true);
        setDeviceName(session.getCastDevice()?.friendlyName || "Chromecast");
        return true;
      } catch (err) {
        console.warn("[Chromecast] Error cargando media en TV:", err);
        setRemoteLoadState('error');
        setRemoteLoadError('El Chromecast rechazó la fuente de reproducción.');
        return false;
      }
    },
    []
  );

  // 5. Controles remotos
  const castPlay = useCallback(() => {
    if (remotePlayerControllerRef.current && remotePlayerRef.current?.isPaused) {
      remotePlayerControllerRef.current.playOrPause();
    }
  }, []);

  const castPause = useCallback(() => {
    if (remotePlayerControllerRef.current && !remotePlayerRef.current?.isPaused) {
      remotePlayerControllerRef.current.playOrPause();
    }
  }, []);

  const castStop = useCallback(() => {
    try {
      if (remotePlayerControllerRef.current) {
        remotePlayerControllerRef.current.stop();
      }
    } catch (err) {
      console.warn("[Chromecast] Error en castStop:", err);
    }
  }, []);

  const castSeek = useCallback((time: number) => {
    if (remotePlayerRef.current && remotePlayerControllerRef.current) {
      remotePlayerRef.current.currentTime = time;
      remotePlayerControllerRef.current.seek();
    }
  }, []);

  const castSetVolume = useCallback((vol: number) => {
    if (remotePlayerRef.current && remotePlayerControllerRef.current) {
      remotePlayerRef.current.volumeLevel = Math.max(0, Math.min(1, vol));
      remotePlayerControllerRef.current.setVolumeLevel();
    }
  }, []);

  const castSetMuted = useCallback((muted: boolean) => {
    if (remotePlayerControllerRef.current && remotePlayerRef.current?.isMuted !== muted) {
      remotePlayerControllerRef.current.muteOrUnmute();
    }
  }, []);

  return {
    isCastAvailable,
    isCasting,
    deviceName,
    remoteCurrentTime,
    remoteDuration,
    remoteIsPaused,
    remoteLoadState,
    remoteLoadError,
    requestCastSession,
    endCastSession,
    loadMediaOnCast,
    castPlay,
    castPause,
    castStop,
    castSeek,
    castSetVolume,
    castSetMuted,
  };
}
