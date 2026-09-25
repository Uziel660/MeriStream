// src/hooks/useTeleparty.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAuthToken } from "../api/client";
import { backendWsUrl } from "../utils/runtime";

export interface WatchPartyMedia {
  showId?: string | null;
  tmdbId?: string | number | null;
  episodeId?: string | null;
  episodeNumber?: number | null;
  title: string;
  kind?: "movie" | "tv" | "series" | "anime" | string | null;
  posterUrl?: string | null;
  streamUrl?: string | null;
  /** Identidad estable de la fuente elegida por el anfitrión. */
  serverId?: string | null;
  sourceSite?: string | null;
  provider?: string | null;
  canonicalLocator?: string | null;
}

export interface WatchPartyParticipant {
  userId: string;
  id?: string;
  username: string;
  isHost: boolean;
  joinedAt: number;
  avatar?: string;
}

export interface WatchPartyChatMessage {
  id: string;
  userId: string;
  username: string;
  text: string;
  isEmoji: boolean;
  timestamp: number;
  senderId?: string;
  senderName?: string;
}

export interface WatchPartyReaction {
  id: string;
  emoji: string;
  userId: string;
  username: string;
  timestamp: number;
}

export interface WatchPartyRoom {
  roomCode: string;
  code?: string;
  hostId: string;
  hostUsername: string;
  media: WatchPartyMedia;
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
  updatedAt: number;
  participantCount: number;
  participants: WatchPartyParticipant[];
  createdAt: number;
}

export interface UseTelepartyOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  roomCode?: string | null;
  initialRoomCode?: string | null; // Compatibility alias
  media?: WatchPartyMedia | null;
  currentMedia?: WatchPartyMedia | null; // Compatibility alias
  authToken?: string | null;
  onHostChange?: (isHost: boolean) => void;
  onMediaChange?: (media: WatchPartyMedia) => void;
  onMediaChangeRequest?: (media: WatchPartyMedia) => void; // Compatibility alias
  onError?: (error: string) => void;
  onNotification?: (msg: { type: "info" | "warn" | "error"; text: string }) => void;
  wsUrl?: string; // Optional custom WS URL (useful for test environments)
}

export interface UseTelepartyReturn {
  isConnected: boolean;
  isHost: boolean;
  room: WatchPartyRoom | null;
  participants: WatchPartyParticipant[];
  messages: WatchPartyChatMessage[];
  reactions: WatchPartyReaction[];
  error: string | null;
  sendMessage: (text: string, isEmoji?: boolean) => void;
  sendReaction: (emoji: string) => void;
  syncPlay: (time?: number) => void;
  syncPause: (time?: number) => void;
  syncSeek: (time: number, isFinal?: boolean) => void;
  syncSpeed: (rate: number) => void;
  syncMedia: (media: WatchPartyMedia) => void;
  reconnect: () => void;
  disconnect: () => void;

  // Compatibility & UI convenience aliases
  isInRoom: boolean;
  roomCode: string | null;
  hostParticipant: WatchPartyParticipant | null;
  chatMessages: WatchPartyChatMessage[];
  recentReactions: WatchPartyReaction[];
  errorMessage: string | null;
  clearError: () => void;
  syncChangeMedia: (media: WatchPartyMedia) => void;
  currentMedia: WatchPartyMedia | null;
}

/**
 * Computes exponential backoff delay capped at 15000ms:
 * Math.min(15000, 1000 * Math.pow(1.5, retryCount))
 */
export function computeBackoffDelay(retryCount: number): number {
  return Math.min(15000, 1000 * Math.pow(1.5, retryCount));
}

/**
 * Computes expected remote playhead taking into account elapsed time and playback rate.
 */
export function computeExpectedPlayhead(
  remoteCurrentTime: number,
  remoteUpdatedAt: number,
  isPlaying: boolean,
  playbackRate: number = 1.0,
  now: number = Date.now()
): number {
  if (!isPlaying) {
    return Math.max(0, remoteCurrentTime);
  }
  const elapsedSec = Math.max(0, (now - remoteUpdatedAt) / 1000);
  return Math.max(0, remoteCurrentTime + elapsedSec * (playbackRate || 1.0));
}

/**
 * Evaluates playhead drift against tolerance threshold (default: 2.0s).
 */
export function checkDrift(
  localTime: number,
  expectedTime: number,
  threshold: number = 2.0
): { drift: number; shouldCorrect: boolean } {
  const rawDrift = localTime - expectedTime;
  const drift = Math.round(rawDrift * 1000) / 1000;
  return {
    drift,
    shouldCorrect: Math.abs(rawDrift) > threshold,
  };
}

const SOFT_DRIFT_MIN = 0.25;
const SOFT_DRIFT_MAX = 2.0;
const SOFT_RATE_LIMIT = 0.06;

/**
 * Corrige pequeños desfases acelerando o frenando unos instantes. El salto
 * duro se conserva para desfases grandes y para los eventos explícitos de
 * pausa/seek, pero los espectadores no ven un seek cada vez que llega un
 * heartbeat.
 */
function getSoftCorrectionRate(localTime: number, expectedTime: number, playbackRate: number): number {
  const delta = expectedTime - localTime;
  if (Math.abs(delta) < SOFT_DRIFT_MIN || Math.abs(delta) > SOFT_DRIFT_MAX) return playbackRate;
  const adjustment = Math.max(-SOFT_RATE_LIMIT, Math.min(SOFT_RATE_LIMIT, delta * 0.04));
  return Math.max(0.25, playbackRate + adjustment);
}

/**
 * Extracts userId from JWT token payload safely.
 */
export function extractUserIdFromToken(token: string | null | undefined): string | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const jsonStr = typeof atob !== "undefined"
      ? atob(base64)
      : Buffer.from(base64, "base64").toString("utf-8");
    const payload = JSON.parse(jsonStr);
    return payload.id || payload.userId || payload.sub || null;
  } catch {
    return null;
  }
}

export function useTeleparty(options: UseTelepartyOptions): UseTelepartyReturn {
  const { videoRef } = options;
  const activeRoomCode = options.roomCode ?? options.initialRoomCode ?? null;
  const activeMedia = options.media ?? options.currentMedia ?? null;

  // Primary reactive state
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isHost, setIsHost] = useState<boolean>(false);
  const [room, setRoom] = useState<WatchPartyRoom | null>(null);
  const [participants, setParticipants] = useState<WatchPartyParticipant[]>([]);
  const [messages, setMessages] = useState<WatchPartyChatMessage[]>([]);
  const [reactions, setReactions] = useState<WatchPartyReaction[]>([]);
  const [error, setError] = useState<string | null>(null);

  // References
  const wsRef = useRef<WebSocket | null>(null);
  const isApplyingRemoteUpdateRef = useRef<boolean>(false);
  const suppressLocalEventsUntilRef = useRef<number>(0);
  const retryCountRef = useRef<number>(0);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const intentionalDisconnectRef = useRef<boolean>(false);
  const isHostRef = useRef<boolean>(false);
  const viewerSoftCorrectionRateRef = useRef<number | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Throttling references for outgoing seeks (max 4 msg/sec => 250ms)
  const lastSeekSentRef = useRef<number>(0);
  const pendingSeekTimeRef = useRef<number | null>(null);
  const seekThrottleTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Keep isHostRef synchronized with isHost state
  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  // Clean error callback
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Safe WebSocket message dispatcher
  const sendWsMessage = useCallback((payload: Record<string, any>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) { // 1 === WebSocket.OPEN
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        console.error("[useTeleparty] Failed to dispatch WebSocket message:", err);
      }
    }
  }, []);

  /**
   * Anti-Echo Guard Wrapper:
   * Wraps changes to the local native <video> element so that synthetic
   * events (play, pause, seeked, ratechange) triggered by remote state updates
   * are identified and blocked from broadcasting back to the server.
   */
  const applyRemoteUpdate = useCallback((action: () => void) => {
    isApplyingRemoteUpdateRef.current = true;
    suppressLocalEventsUntilRef.current = Date.now() + 300;

    try {
      action();
    } catch (err) {
      console.error("[useTeleparty] Error applying remote video update:", err);
    } finally {
      // Cooldown timer to allow browser synthetic event queues to finish
      setTimeout(() => {
        isApplyingRemoteUpdateRef.current = false;
      }, 50);
    }
  }, []);

  /**
   * Throttled seek dispatcher:
   * Enforces max 4 seek messages per second (250ms interval) during scrubbing,
   * while ensuring the final seek position is immediately flushed.
   */
  const throttledSeek = useCallback((time: number, isFinal: boolean = false) => {
    const now = Date.now();
    const timeSinceLast = now - lastSeekSentRef.current;

    const flush = (targetTime: number) => {
      lastSeekSentRef.current = Date.now();
      pendingSeekTimeRef.current = null;
      if (seekThrottleTimerRef.current) {
        clearTimeout(seekThrottleTimerRef.current);
        seekThrottleTimerRef.current = null;
      }
      sendWsMessage({ type: "SEEK", currentTime: targetTime });
    };

    if (isFinal) {
      flush(time);
      return;
    }

    pendingSeekTimeRef.current = time;

    if (timeSinceLast >= 250) {
      flush(time);
    } else if (!seekThrottleTimerRef.current) {
      const remainingTime = Math.max(0, 250 - timeSinceLast);
      seekThrottleTimerRef.current = setTimeout(() => {
        seekThrottleTimerRef.current = null;
        if (pendingSeekTimeRef.current !== null) {
          flush(pendingSeekTimeRef.current);
        }
      }, remainingTime);
    }
  }, [sendWsMessage]);

  /**
   * Host Actions (dispatched to WebSocket when user is host)
   */
  const syncPlay = useCallback((time?: number) => {
    if (isApplyingRemoteUpdateRef.current || Date.now() < suppressLocalEventsUntilRef.current) return;
    if (!isHostRef.current) return;
    const video = videoRef.current;
    const t = typeof time === "number" ? time : video ? video.currentTime : 0;
    sendWsMessage({ type: "PLAY", currentTime: t });
  }, [sendWsMessage, videoRef]);

  const syncPause = useCallback((time?: number) => {
    if (isApplyingRemoteUpdateRef.current || Date.now() < suppressLocalEventsUntilRef.current) return;
    if (!isHostRef.current) return;
    const video = videoRef.current;
    const t = typeof time === "number" ? time : video ? video.currentTime : 0;
    sendWsMessage({ type: "PAUSE", currentTime: t });
  }, [sendWsMessage, videoRef]);

  const syncSeek = useCallback((time: number, isFinal: boolean = false) => {
    if (isApplyingRemoteUpdateRef.current || Date.now() < suppressLocalEventsUntilRef.current) return;
    if (!isHostRef.current) return;
    throttledSeek(time, isFinal);
  }, [throttledSeek]);

  const syncSpeed = useCallback((rate: number) => {
    if (isApplyingRemoteUpdateRef.current || Date.now() < suppressLocalEventsUntilRef.current) return;
    if (!isHostRef.current) return;
    sendWsMessage({ type: "SPEED", playbackRate: rate });
  }, [sendWsMessage]);

  const syncMedia = useCallback((mediaToSync: WatchPartyMedia) => {
    if (!isHostRef.current) return;
    sendWsMessage({ type: "CHANGE_MEDIA", media: mediaToSync });
  }, [sendWsMessage]);

  const sendMessage = useCallback((text: string, isEmoji: boolean = false) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendWsMessage({ type: "CHAT", text: trimmed, isEmoji: Boolean(isEmoji) });
  }, [sendWsMessage]);

  const sendReaction = useCallback((emoji: string) => {
    const trimmed = emoji.trim();
    if (!trimmed) return;
    sendWsMessage({ type: "CHAT", text: trimmed, isEmoji: true });
  }, [sendWsMessage]);

  /**
   * Core Connection Function
   */
  const connect = useCallback(() => {
    if (!activeRoomCode || !activeRoomCode.trim()) return;

    // Clear existing reconnect timers
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Close any previous active connection
    if (wsRef.current) {
      try {
        wsRef.current.close(1000, "Reconnecting");
      } catch {
        // ignore
      }
      wsRef.current = null;
    }

    const token = optionsRef.current.authToken || getAuthToken();
    if (!token) {
      const err = "No auth token provided or found in storage.";
      setError(err);
      optionsRef.current.onError?.(err);
      return;
    }

    const cleanCode = activeRoomCode.trim().toUpperCase();

    // Construct WebSocket URL
    let url = optionsRef.current.wsUrl;
    if (!url) {
      url = backendWsUrl("/ws/watch-party");
    }
    const fullUrl = `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}&room=${encodeURIComponent(cleanCode)}`;

    try {
      const ws = new WebSocket(fullUrl);
      wsRef.current = ws;
      intentionalDisconnectRef.current = false;

      ws.onopen = () => {
        setError(null);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.type) {
            case "ROOM_STATE": {
              const currentUserId = extractUserIdFromToken(token);
              const roomPayload = msg.room || {};
              const hostId = roomPayload.hostId || msg.hostId;
              const isUserHost = Boolean(msg.isHost ?? (currentUserId && hostId === currentUserId));

              setIsConnected(true);
              setRoom(roomPayload);
              setIsHost(isUserHost);
              isHostRef.current = isUserHost;
              optionsRef.current.onHostChange?.(isUserHost);

              // Normalize participants list
              if (Array.isArray(roomPayload.participants)) {
                const normParticipants: WatchPartyParticipant[] = roomPayload.participants.map((p: any) => ({
                  userId: p.userId || p.id,
                  id: p.userId || p.id,
                  username: p.username || "Usuario",
                  isHost: Boolean(p.isHost || (hostId && (p.userId || p.id) === hostId)),
                  joinedAt: p.joinedAt || Date.now(),
                  avatar: p.avatar,
                }));
                setParticipants(normParticipants);
              }

              // Notify initial media
              if (roomPayload.media) {
                optionsRef.current.onMediaChange?.(roomPayload.media);
                optionsRef.current.onMediaChangeRequest?.(roomPayload.media);
              } else if (isUserHost && activeMedia) {
                sendWsMessage({ type: "CHANGE_MEDIA", media: activeMedia });
              }

              // Reset exponential retry count on successful connection
              retryCountRef.current = 0;

              // If viewer, align playback state immediately
              if (!isUserHost && videoRef.current) {
                const video = videoRef.current;
                const remoteTime = typeof roomPayload.currentTime === "number" ? roomPayload.currentTime : 0;
                const remoteUpdated = typeof roomPayload.updatedAt === "number" ? roomPayload.updatedAt : Date.now();
                const isPlaying = Boolean(roomPayload.isPlaying);
                const rate = typeof roomPayload.playbackRate === "number" ? roomPayload.playbackRate : 1.0;

                const expected = computeExpectedPlayhead(remoteTime, remoteUpdated, isPlaying, rate);

                applyRemoteUpdate(() => {
                  video.currentTime = expected;
                  if (rate > 0) video.playbackRate = rate;
                  viewerSoftCorrectionRateRef.current = null;
                  if (isPlaying) {
                    video.play().catch(() => {});
                  } else {
                    video.pause();
                  }
                });
              }
              break;
            }

            case "PLAY": {
              if (videoRef.current) {
                const video = videoRef.current;
                const remoteTime = typeof msg.currentTime === "number" ? msg.currentTime : video.currentTime;
                const remoteUpdated = typeof msg.updatedAt === "number" ? msg.updatedAt : Date.now();
                const expected = computeExpectedPlayhead(remoteTime, remoteUpdated, true, video.playbackRate);
                const { shouldCorrect } = checkDrift(video.currentTime, expected);
                const baseRate = video.playbackRate || 1;
                const softRate = shouldCorrect
                  ? baseRate
                  : getSoftCorrectionRate(video.currentTime, expected, baseRate);

                applyRemoteUpdate(() => {
                  if (shouldCorrect) {
                    video.currentTime = expected;
                    viewerSoftCorrectionRateRef.current = null;
                  } else if (Math.abs(softRate - baseRate) > 0.005) {
                    video.playbackRate = softRate;
                    viewerSoftCorrectionRateRef.current = softRate;
                  }
                  if (video.paused) {
                    video.play().catch(() => {});
                  }
                });
              }
              break;
            }

            case "PAUSE": {
              if (videoRef.current) {
                const video = videoRef.current;
                const remoteTime = typeof msg.currentTime === "number" ? msg.currentTime : video.currentTime;

                applyRemoteUpdate(() => {
                  video.currentTime = remoteTime;
                  viewerSoftCorrectionRateRef.current = null;
                  if (!video.paused) {
                    video.pause();
                  }
                });
              }
              break;
            }

            case "SEEK": {
              if (videoRef.current) {
                const video = videoRef.current;
                const target = typeof msg.currentTime === "number" ? msg.currentTime : 0;

                applyRemoteUpdate(() => {
                  video.currentTime = target;
                });
              }
              break;
            }

            case "SPEED": {
              if (videoRef.current) {
                const video = videoRef.current;
                const rate = typeof msg.playbackRate === "number" ? msg.playbackRate : 1.0;

                applyRemoteUpdate(() => {
                  video.playbackRate = rate;
                  viewerSoftCorrectionRateRef.current = null;
                });
              }
              break;
            }

            case "CHANGE_MEDIA": {
              if (msg.media) {
                setRoom((prev) => (prev ? { ...prev, media: msg.media } : null));
                optionsRef.current.onMediaChange?.(msg.media);
                optionsRef.current.onMediaChangeRequest?.(msg.media);

                if (!isHostRef.current && videoRef.current) {
                  applyRemoteUpdate(() => {
                    videoRef.current!.currentTime = 0;
                    videoRef.current!.pause();
                    viewerSoftCorrectionRateRef.current = null;
                  });
                }
              }
              break;
            }

            case "SYNC_CHECK": {
              if (!isHostRef.current && videoRef.current) {
                const video = videoRef.current;
                const remoteTime = typeof msg.currentTime === "number" ? msg.currentTime : 0;
                const remoteUpdated = typeof msg.updatedAt === "number" ? msg.updatedAt : Date.now();
                const isPlaying = Boolean(msg.isPlaying);
                const playbackRate = typeof msg.playbackRate === "number" ? msg.playbackRate : 1.0;

                const expectedTime = computeExpectedPlayhead(remoteTime, remoteUpdated, isPlaying, playbackRate);
                const { drift, shouldCorrect } = checkDrift(video.currentTime, expectedTime);
                const continuingSoftCorrection = viewerSoftCorrectionRateRef.current !== null
                  && Math.abs(video.playbackRate - viewerSoftCorrectionRateRef.current) < 0.02;
                const canSoftCorrect = !shouldCorrect
                  && (Math.abs(video.playbackRate - playbackRate) < 0.01 || continuingSoftCorrection);
                const softRate = canSoftCorrect
                  ? getSoftCorrectionRate(video.currentTime, expectedTime, playbackRate)
                  : playbackRate;

                // Smart Drift Correction: small offsets converge through a
                // short rate nudge; only offsets above the existing 2s
                // tolerance perform a visible seek.
                if (shouldCorrect) {
                  console.log(
                    `[useTeleparty] Smart drift correction applied: drift=${drift.toFixed(2)}s, adjusting to ${expectedTime.toFixed(2)}s`
                  );
                  applyRemoteUpdate(() => {
                    video.currentTime = expectedTime;
                    viewerSoftCorrectionRateRef.current = null;
                  });
                } else if (canSoftCorrect && Math.abs(softRate - video.playbackRate) > 0.005) {
                  applyRemoteUpdate(() => {
                    video.playbackRate = softRate;
                    viewerSoftCorrectionRateRef.current = Math.abs(softRate - playbackRate) > 0.005 ? softRate : null;
                  });
                } else if (canSoftCorrect && Math.abs(softRate - playbackRate) <= 0.005) {
                  viewerSoftCorrectionRateRef.current = null;
                }

                // Converge play/pause state
                if (isPlaying && video.paused) {
                  applyRemoteUpdate(() => {
                    video.play().catch(() => {});
                  });
                } else if (!isPlaying && !video.paused) {
                  applyRemoteUpdate(() => {
                    video.pause();
                  });
                }

                // Converge speed
                if (!canSoftCorrect && Math.abs(video.playbackRate - playbackRate) > 0.01) {
                  applyRemoteUpdate(() => {
                    video.playbackRate = playbackRate;
                    viewerSoftCorrectionRateRef.current = null;
                  });
                }
              }
              break;
            }

            case "PARTICIPANT_JOINED": {
              if (msg.participant) {
                const p = msg.participant;
                const normP: WatchPartyParticipant = {
                  userId: p.userId || p.id,
                  id: p.userId || p.id,
                  username: p.username || "Usuario",
                  isHost: Boolean(p.isHost),
                  joinedAt: p.joinedAt || Date.now(),
                  avatar: p.avatar,
                };
                setParticipants((prev) => {
                  const filtered = prev.filter((item) => item.userId !== normP.userId);
                  return [...filtered, normP];
                });
              }
              break;
            }

            case "PARTICIPANT_LEFT": {
              const leftId = msg.userId || msg.participantId;
              if (leftId) {
                setParticipants((prev) => prev.filter((p) => p.userId !== leftId));
              }
              break;
            }

            case "HOST_CHANGED": {
              const currentUserId = extractUserIdFromToken(token);
              const newHostId = msg.hostId || msg.newHostId;
              const newHostUsername = msg.hostUsername || msg.newHostUsername;
              const isNowHost = Boolean(currentUserId && newHostId === currentUserId);

              setIsHost(isNowHost);
              isHostRef.current = isNowHost;
              optionsRef.current.onHostChange?.(isNowHost);

              setParticipants((prev) =>
                prev.map((p) => ({
                  ...p,
                  isHost: p.userId === newHostId,
                }))
              );

              setRoom((prev) =>
                prev
                  ? {
                      ...prev,
                      hostId: newHostId,
                      hostUsername: newHostUsername || prev.hostUsername,
                    }
                  : null
              );
              break;
            }

            case "CHAT": {
              if (msg.message) {
                const chatMsg: WatchPartyChatMessage = {
                  id: msg.message.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  userId: msg.message.userId || msg.message.senderId || "",
                  username: msg.message.username || msg.message.senderName || "Usuario",
                  text: msg.message.text || "",
                  isEmoji: Boolean(msg.message.isEmoji),
                  timestamp: msg.message.timestamp || Date.now(),
                  senderId: msg.message.userId || msg.message.senderId,
                  senderName: msg.message.username || msg.message.senderName,
                };

                setMessages((prev) => [...prev, chatMsg]);

                if (chatMsg.isEmoji) {
                  const rx: WatchPartyReaction = {
                    id: chatMsg.id,
                    emoji: chatMsg.text,
                    userId: chatMsg.userId,
                    username: chatMsg.username,
                    timestamp: chatMsg.timestamp,
                  };
                  setReactions((prev) => [...prev.slice(-29), rx]);
                }
              }
              break;
            }

            case "REACTION": {
              const rx: WatchPartyReaction = {
                id: msg.id || `rx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                emoji: msg.emoji,
                userId: msg.senderId || msg.userId || "",
                username: msg.senderName || msg.username || "Usuario",
                timestamp: msg.timestamp || Date.now(),
              };
              setReactions((prev) => [...prev.slice(-29), rx]);
              break;
            }

            case "ERROR": {
              const errMsg = msg.message || msg.code || "Error en Watch Party";
              setError(errMsg);
              optionsRef.current.onError?.(errMsg);
              break;
            }
          }
        } catch {
          // Ignore malformed payloads
        }
      };

      ws.onerror = () => {
        const errMsg = "WebSocket connection error";
        setError(errMsg);
        optionsRef.current.onError?.(errMsg);
      };

      ws.onclose = (event) => {
        setIsConnected(false);
        wsRef.current = null;

        // Auto-Reconnect with Exponential Backoff
        const isAbnormal =
          event.code !== 1000 &&
          event.code !== 4001 &&
          event.code !== 4003 &&
          !intentionalDisconnectRef.current;

        if (isAbnormal) {
          const backoffDelay = computeBackoffDelay(retryCountRef.current);
          retryCountRef.current++;
          console.log(
            `[useTeleparty] WebSocket closed (code: ${event.code}). Reconnecting in ${backoffDelay}ms (attempt ${retryCountRef.current})...`
          );

          reconnectTimerRef.current = setTimeout(() => {
            connect();
          }, backoffDelay);
        }
      };
    } catch (err: any) {
      const errMsg = err?.message || "Failed to initialize WebSocket connection";
      setError(errMsg);
      optionsRef.current.onError?.(errMsg);
    }
  }, [activeRoomCode, applyRemoteUpdate, videoRef]);

  /**
   * Explicit Disconnect Action
   */
  const disconnect = useCallback(() => {
    intentionalDisconnectRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (seekThrottleTimerRef.current) {
      clearTimeout(seekThrottleTimerRef.current);
      seekThrottleTimerRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close(1000, "User disconnected");
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
    setIsConnected(false);
    setRoom(null);
    setParticipants([]);
    setIsHost(false);
    isHostRef.current = false;
  }, []);

  /**
   * Explicit Reconnect Action
   */
  const reconnect = useCallback(() => {
    intentionalDisconnectRef.current = false;
    retryCountRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    connect();
  }, [connect]);

  // Connect on roomCode change, cleanup on unmount
  useEffect(() => {
    if (!activeRoomCode || !activeRoomCode.trim()) {
      disconnect();
      return;
    }

    connect();

    return () => {
      disconnect();
    };
  }, [activeRoomCode, connect, disconnect]);

  /**
   * Local Video Element Listeners (play, pause, seeked, ratechange)
   * Equipped with Anti-Echo Guard and Host Authority checks.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => {
      if (isApplyingRemoteUpdateRef.current || Date.now() < suppressLocalEventsUntilRef.current) return;
      if (!isHostRef.current) return;
      sendWsMessage({ type: "PLAY", currentTime: video.currentTime });
    };

    const handlePause = () => {
      if (isApplyingRemoteUpdateRef.current || Date.now() < suppressLocalEventsUntilRef.current) return;
      if (!isHostRef.current) return;
      sendWsMessage({ type: "PAUSE", currentTime: video.currentTime });
    };

    const handleSeeked = () => {
      if (isApplyingRemoteUpdateRef.current || Date.now() < suppressLocalEventsUntilRef.current) return;
      if (!isHostRef.current) return;
      throttledSeek(video.currentTime);
    };

    const handleRateChange = () => {
      if (isApplyingRemoteUpdateRef.current || Date.now() < suppressLocalEventsUntilRef.current) return;
      if (!isHostRef.current) return;
      sendWsMessage({ type: "SPEED", playbackRate: video.playbackRate });
    };

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("ratechange", handleRateChange);

    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("ratechange", handleRateChange);
    };
  }, [videoRef.current, sendWsMessage, throttledSeek]);

  /**
   * Periodic Host SYNC_CHECK Heartbeat (every 2500ms when connected & host)
   */
  useEffect(() => {
    if (!isConnected) return;

    const interval = setInterval(() => {
      const video = videoRef.current;
      if (isHostRef.current && video && wsRef.current && wsRef.current.readyState === 1) {
        sendWsMessage({
          type: "SYNC_CHECK",
          currentTime: video.currentTime,
          isPlaying: !video.paused,
          playbackRate: video.playbackRate || 1.0,
        });
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [isConnected, sendWsMessage, videoRef]);

  // Host Participant convenience selector
  const hostParticipant = useMemo(() => {
    return participants.find((p) => p.isHost) || null;
  }, [participants]);

  return {
    isConnected,
    isHost,
    room,
    participants,
    messages,
    reactions,
    error,
    sendMessage,
    sendReaction,
    syncPlay,
    syncPause,
    syncSeek,
    syncSpeed,
    syncMedia,
    reconnect,
    disconnect,

    // Aliases and UI helpers
    isInRoom: isConnected && Boolean(activeRoomCode),
    roomCode: activeRoomCode,
    hostParticipant,
    chatMessages: messages,
    recentReactions: reactions,
    errorMessage: error,
    clearError,
    syncChangeMedia: syncMedia,
    currentMedia: room?.media ?? activeMedia,
  };
}
