import { Router, Request, Response } from "express";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { verifyAuthToken } from "./auth";

export interface MediaInfo {
  showId?: string;
  tmdbId?: string | number;
  episodeId?: string;
  title: string;
  kind?: "movie" | "tv" | "series" | "anime" | string;
  posterUrl?: string;
  streamUrl?: string;
  serverId?: string;
  sourceSite?: string;
  provider?: string;
  canonicalLocator?: string;
}

export type MediaPayload = MediaInfo;

export interface Participant {
  userId: string;
  username: string;
  ws?: WebSocket;
  joinedAt: number;
  isHost: boolean;
  avatar?: string;
}

export interface ParticipantPayload {
  userId: string;
  username: string;
  isHost: boolean;
  joinedAt: number;
  avatar?: string;
}

export interface PlaybackTimeline {
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
  updatedAt: number;
}

export interface Room {
  code: string;
  hostId: string;
  hostUsername: string;
  media: MediaInfo;
  timeline: PlaybackTimeline;
  participants: Map<string, Participant>;
  createdAt: number;
  emptySince?: number;
  emptyTimer?: NodeJS.Timeout;
}

export interface RoomStatePayload {
  roomCode: string;
  code: string;
  hostId: string;
  hostUsername: string;
  media: MediaInfo;
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
  updatedAt: number;
  timeline?: PlaybackTimeline;
  participantCount: number;
  participants: ParticipantPayload[];
  createdAt: number;
}

export interface ChatMessagePayload {
  id: string;
  userId: string;
  username: string;
  text: string;
  isEmoji: boolean;
  timestamp: number;
}

export function sanitizeParticipant(p: Participant): ParticipantPayload {
  return {
    userId: p.userId,
    username: p.username,
    isHost: p.isHost,
    joinedAt: p.joinedAt,
    avatar: p.avatar,
  };
}

export function sanitizeRoom(room: Room): RoomStatePayload {
  return {
    roomCode: room.code,
    code: room.code,
    hostId: room.hostId,
    hostUsername: room.hostUsername,
    media: room.media,
    isPlaying: room.timeline.isPlaying,
    currentTime: room.timeline.currentTime,
    playbackRate: room.timeline.playbackRate,
    updatedAt: room.timeline.updatedAt,
    timeline: {
      isPlaying: room.timeline.isPlaying,
      currentTime: room.timeline.currentTime,
      playbackRate: room.timeline.playbackRate,
      updatedAt: room.timeline.updatedAt,
    },
    participantCount: room.participants.size,
    participants: Array.from(room.participants.values()).map(sanitizeParticipant),
    createdAt: room.createdAt,
  };
}

/**
 * In-memory RoomManager handling Watch Party rooms:
 * - 6-character uppercase alphanumeric code generation
 * - 20-participant capacity limit
 * - 5-minute empty room garbage collection
 * - Host migration to oldest participant
 * - Real-time state broadcasting and synchronization
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  public nowFn: () => number = () => Date.now();

  /**
   * Generates a 6-character uppercase alphanumeric room code.
   * Uses unambiguous characters (no 0/O, 1/I confusion).
   */
  public generateRoomCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    do {
      code = "";
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (this.rooms.has(code));
    return code;
  }

  /**
   * Creates a new watch party room.
   */
  public createRoom(hostId: string, hostUsername: string, media: MediaInfo): Room {
    const code = this.generateRoomCode();
    const now = this.nowFn();

    const room: Room = {
      code,
      hostId,
      hostUsername,
      media,
      timeline: {
        isPlaying: false,
        currentTime: 0,
        playbackRate: 1.0,
        updatedAt: now,
      },
      participants: new Map(),
      createdAt: now,
    };

    this.rooms.set(code, room);
    return room;
  }

  /**
   * Retrieves a room by its code (case-insensitive).
   */
  public getRoom(code: string): Room | null {
    if (!code) return null;
    const normalized = code.toUpperCase().trim();
    return this.rooms.get(normalized) || null;
  }

  /**
   * Adds or reconnects a participant in a room.
   * Enforces 20 participants capacity cap.
   */
  public addParticipant(
    code: string,
    userId: string,
    username: string,
    ws?: WebSocket
  ): {
    success: boolean;
    error?: "ROOM_NOT_FOUND" | "ROOM_FULL";
    isHost?: boolean;
    room?: Room;
  } {
    const room = this.getRoom(code);
    if (!room) {
      return { success: false, error: "ROOM_NOT_FOUND" };
    }

    // Cancel empty room GC timer if active
    if (room.emptyTimer) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = undefined;
      room.emptySince = undefined;
    }

    // Capacity check: max 20 participants (allow reconnection)
    if (room.participants.size >= 20 && !room.participants.has(userId)) {
      return { success: false, error: "ROOM_FULL" };
    }

    // If first participant joining or room has no host, designate as host
    if (room.participants.size === 0 || !room.hostId) {
      room.hostId = userId;
      room.hostUsername = username;
    }

    const isHost = userId === room.hostId;
    const existing = room.participants.get(userId);
    const joinedAt = existing ? existing.joinedAt : this.nowFn();

    const participant: Participant = {
      userId,
      username,
      ws,
      joinedAt,
      isHost,
    };

    room.participants.set(userId, participant);
    return { success: true, isHost, room };
  }

  /**
   * Removes a participant from a room.
   * If host leaves, migrates host role to the oldest remaining participant.
   * If room becomes empty, starts 5-minute GC timer.
   */
  public removeParticipant(
    code: string,
    userId: string
  ): {
    removed: boolean;
    promotedHost?: { hostId: string; hostUsername: string };
  } {
    const room = this.getRoom(code);
    if (!room) return { removed: false };

    room.participants.delete(userId);

    let promotedHost: { hostId: string; hostUsername: string } | undefined;

    // Host migration if host left and participants remain
    if (userId === room.hostId && room.participants.size > 0) {
      let oldestParticipant: Participant | null = null;
      for (const p of room.participants.values()) {
        if (!oldestParticipant || p.joinedAt < oldestParticipant.joinedAt) {
          oldestParticipant = p;
        }
      }

      if (oldestParticipant) {
        oldestParticipant.isHost = true;
        room.hostId = oldestParticipant.userId;
        room.hostUsername = oldestParticipant.username;
        promotedHost = { hostId: oldestParticipant.userId, hostUsername: oldestParticipant.username };
      }
    }

    // Empty room Garbage Collection: 5-minute countdown
    if (room.participants.size === 0) {
      const GC_MS = 5 * 60 * 1000;
      room.emptySince = this.nowFn();
      if (room.emptyTimer) clearTimeout(room.emptyTimer);
      room.emptyTimer = setTimeout(() => {
        if (room.participants.size === 0) {
          this.rooms.delete(room.code);
        }
      }, GC_MS);
    }

    return { removed: true, promotedHost };
  }

  /**
   * Broadcasts a JSON message to all connected participants in a room (with optional exclusion).
   */
  public broadcast(code: string, message: any, excludeUserId?: string): void {
    const room = this.getRoom(code);
    if (!room) return;

    const payload = JSON.stringify(message);
    for (const [userId, participant] of room.participants.entries()) {
      if (excludeUserId && userId === excludeUserId) continue;
      if (participant.ws && participant.ws.readyState === WebSocket.OPEN) {
        try {
          participant.ws.send(payload);
        } catch {
          // ignore write errors on closing socket
        }
      }
    }
  }

  /**
   * Manually triggers GC purge for testing or admin cleanup.
   */
  public triggerGcPurge(code: string): void {
    const room = this.getRoom(code);
    if (room) {
      if (room.emptyTimer) clearTimeout(room.emptyTimer);
      this.rooms.delete(room.code);
    }
  }

  /**
   * Deletes a room completely and closes all active sockets.
   */
  public deleteRoom(code: string): void {
    const room = this.getRoom(code);
    if (room) {
      if (room.emptyTimer) clearTimeout(room.emptyTimer);
      for (const participant of room.participants.values()) {
        if (participant.ws && participant.ws.readyState === WebSocket.OPEN) {
          try {
            participant.ws.close(1000, "Room closed");
          } catch {
            // ignore
          }
        }
      }
      this.rooms.delete(room.code);
    }
  }

  /**
   * Cleans up all active rooms and timers (used for graceful shutdown / tests).
   */
  public clearAll(): void {
    for (const room of this.rooms.values()) {
      if (room.emptyTimer) clearTimeout(room.emptyTimer);
      for (const participant of room.participants.values()) {
        if (participant.ws && participant.ws.readyState === WebSocket.OPEN) {
          try {
            participant.ws.close(1000, "Server shutdown");
          } catch {
            // ignore
          }
        }
      }
    }
    this.rooms.clear();
  }
}

export const roomManager = new RoomManager();

// ============================================================================
// REST API Router (/api/rooms)
// ============================================================================

export const roomsRouter = Router();

// POST /api/rooms - Create Room
roomsRouter.post("/", (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user || !user.id) {
    return res.status(401).json({ error: "No autorizado. Token no proporcionado." });
  }

  const { media } = req.body;
  if (!media || !media.title) {
    return res.status(400).json({ error: "Invalid media payload" });
  }

  const room = roomManager.createRoom(user.id, user.username || "Anonymous", media);
  return res.status(201).json({
    roomCode: room.code,
    code: room.code,
    room: sanitizeRoom(room),
  });
});

// GET /api/rooms/:code - Check Room State
roomsRouter.get("/:code", (req: Request, res: Response) => {
  const rawCode = req.params.code;
  const code = Array.isArray(rawCode) ? rawCode[0] : String(rawCode || "");
  if (!code || !/^[a-zA-Z0-9]{6}$/.test(code)) {
    return res.status(400).json({ error: "Invalid room code format (must be 6 alphanumeric chars)" });
  }

  const room = roomManager.getRoom(code);
  if (!room) {
    return res.status(404).json({ exists: false, error: "Room not found" });
  }

  return res.json({
    exists: true,
    roomCode: room.code,
    code: room.code,
    media: room.media,
    participantCount: room.participants.size,
    isFull: room.participants.size >= 20,
    hostId: room.hostId,
    hostUsername: room.hostUsername,
  });
});

// GET /api/rooms/:code/participants - Get Room Participants
roomsRouter.get("/:code/participants", (req: Request, res: Response) => {
  const rawCode = req.params.code;
  const code = Array.isArray(rawCode) ? rawCode[0] : String(rawCode || "");
  if (!code || !/^[a-zA-Z0-9]{6}$/.test(code)) {
    return res.status(400).json({ error: "Invalid room code format" });
  }

  const room = roomManager.getRoom(code);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  return res.json({
    participants: Array.from(room.participants.values()).map(sanitizeParticipant),
  });
});

// DELETE /api/rooms/:code - Close Room (Host only or Admin)
roomsRouter.delete("/:code", (req: Request, res: Response) => {
  const rawCode = req.params.code;
  const code = Array.isArray(rawCode) ? rawCode[0] : String(rawCode || "");
  const user = (req as any).user;

  const room = roomManager.getRoom(code);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  if (user && room.hostId !== user.id && !user.is_admin) {
    return res.status(403).json({ error: "Solo el anfitrión puede cerrar la sala" });
  }

  roomManager.deleteRoom(code);
  return res.json({ message: "Sala cerrada correctamente" });
});

// ============================================================================
// WebSocket Server & Upgrade Integration
// ============================================================================

export function setupWatchPartyWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const urlObj = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
    if (urlObj.pathname !== "/ws/watch-party" && urlObj.pathname !== "/ws/rooms") {
      // Not a watch party WS route - do not interfere with other potential listeners (e.g. Vite HMR)
      return;
    }

    const token = urlObj.searchParams.get("token");
    const roomCode = urlObj.searchParams.get("room");

    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const user = verifyAuthToken(token);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!roomCode || !/^[a-zA-Z0-9]{6}$/.test(roomCode)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, user, roomCode.toUpperCase().trim());
    });
  });

  wss.on("connection", (ws: WebSocket, _req: http.IncomingMessage, user: { id: string; username: string }, roomCode: string) => {
    // Sliding window per-connection rate limiter (max 10 msg/sec)
    let messageCount = 0;
    let windowStart = Date.now();

    const isRateLimited = (): boolean => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        messageCount = 0;
      }
      messageCount++;
      return messageCount > 10;
    };

    const joinResult = roomManager.addParticipant(roomCode, user.id, user.username, ws);
    if (!joinResult.success) {
      ws.send(
        JSON.stringify({
          type: "ERROR",
          code: joinResult.error,
          message:
            joinResult.error === "ROOM_FULL"
              ? "La sala ha alcanzado la capacidad máxima de 20 participantes (Room has reached capacity of 20 participants)."
              : "Sala no encontrada (Room not found).",
        })
      );
      ws.close(4003, joinResult.error);
      return;
    }

    const room = roomManager.getRoom(roomCode);
    if (!room) return;

    // Send initial ROOM_STATE to joining client
    ws.send(
      JSON.stringify({
        type: "ROOM_STATE",
        room: sanitizeRoom(room),
        isHost: joinResult.isHost,
      })
    );

    // Broadcast PARTICIPANT_JOINED to other participants (excluding new joiner)
    roomManager.broadcast(
      roomCode,
      {
        type: "PARTICIPANT_JOINED",
        participant: {
          userId: user.id,
          username: user.username,
          isHost: joinResult.isHost,
          joinedAt: Date.now(),
        },
      },
      user.id
    );

    ws.on("message", (raw) => {
      if (isRateLimited()) {
        ws.send(
          JSON.stringify({
            type: "ERROR",
            code: "RATE_LIMITED",
            message: "Excedido límite de mensajes WebSocket (máximo 10 messages/sec / 10 por segundo).",
          })
        );
        return;
      }

      try {
        const msg = JSON.parse(raw.toString());
        const currentRoom = roomManager.getRoom(roomCode);
        if (!currentRoom) return;

        const isHost = user.id === currentRoom.hostId;

        switch (msg.type) {
          case "PLAY": {
            if (!isHost) {
              ws.send(
                JSON.stringify({
                  type: "ERROR",
                  code: "UNAUTHORIZED_HOST_ONLY",
                  message: "Solo el anfitrión puede controlar la reproducción.",
                })
              );
              return;
            }
            const now = Date.now();
            currentRoom.timeline.isPlaying = true;
            if (typeof msg.currentTime === "number") {
              currentRoom.timeline.currentTime = msg.currentTime;
            }
            currentRoom.timeline.updatedAt = now;
            roomManager.broadcast(roomCode, {
              type: "PLAY",
              currentTime: currentRoom.timeline.currentTime,
              updatedAt: now,
            });
            break;
          }

          case "PAUSE": {
            if (!isHost) {
              ws.send(
                JSON.stringify({
                  type: "ERROR",
                  code: "UNAUTHORIZED_HOST_ONLY",
                  message: "Solo el anfitrión puede controlar la reproducción.",
                })
              );
              return;
            }
            const now = Date.now();
            currentRoom.timeline.isPlaying = false;
            if (typeof msg.currentTime === "number") {
              currentRoom.timeline.currentTime = msg.currentTime;
            }
            currentRoom.timeline.updatedAt = now;
            roomManager.broadcast(roomCode, {
              type: "PAUSE",
              currentTime: currentRoom.timeline.currentTime,
              updatedAt: now,
            });
            break;
          }

          case "SEEK": {
            if (!isHost) {
              ws.send(
                JSON.stringify({
                  type: "ERROR",
                  code: "UNAUTHORIZED_HOST_ONLY",
                  message: "Solo el anfitrión puede controlar la reproducción.",
                })
              );
              return;
            }
            const now = Date.now();
            if (typeof msg.currentTime === "number") {
              currentRoom.timeline.currentTime = msg.currentTime;
            }
            currentRoom.timeline.updatedAt = now;
            roomManager.broadcast(roomCode, {
              type: "SEEK",
              currentTime: currentRoom.timeline.currentTime,
              updatedAt: now,
            });
            break;
          }

          case "SPEED": {
            if (!isHost) {
              ws.send(
                JSON.stringify({
                  type: "ERROR",
                  code: "UNAUTHORIZED_HOST_ONLY",
                  message: "Solo el anfitrión puede controlar la reproducción.",
                })
              );
              return;
            }
            const rate = typeof msg.playbackRate === "number" ? msg.playbackRate : 1.0;
            currentRoom.timeline.playbackRate = rate;
            currentRoom.timeline.updatedAt = Date.now();
            roomManager.broadcast(roomCode, {
              type: "SPEED",
              playbackRate: rate,
            });
            break;
          }

          case "CHANGE_MEDIA": {
            if (!isHost) {
              ws.send(
                JSON.stringify({
                  type: "ERROR",
                  code: "UNAUTHORIZED_HOST_ONLY",
                  message: "Solo el anfitrión puede controlar la reproducción.",
                })
              );
              return;
            }
            const now = Date.now();
            currentRoom.media = msg.media;
            currentRoom.timeline.currentTime = 0;
            currentRoom.timeline.isPlaying = false;
            currentRoom.timeline.updatedAt = now;
            roomManager.broadcast(roomCode, {
              type: "CHANGE_MEDIA",
              media: msg.media,
            });
            break;
          }

          case "SYNC_CHECK": {
            const now = Date.now();
            let currentPlayhead = currentRoom.timeline.currentTime;
            if (currentRoom.timeline.isPlaying) {
              const elapsedSec = (now - currentRoom.timeline.updatedAt) / 1000;
              currentPlayhead += elapsedSec * currentRoom.timeline.playbackRate;
            }
            const clientTime = typeof msg.currentTime === "number" ? msg.currentTime : 0;
            const drift = Math.abs(clientTime - currentPlayhead);

            // El heartbeat se comparte con toda la sala. Antes se devolvía
            // únicamente al host, así que los espectadores acumulaban
            // desfase mientras la reproducción seguía avanzando.
            roomManager.broadcast(roomCode, {
              type: "SYNC_CHECK",
              currentTime: currentPlayhead,
              isPlaying: currentRoom.timeline.isPlaying,
              playbackRate: currentRoom.timeline.playbackRate,
              updatedAt: now,
              drift,
            });
            break;
          }

          case "CHAT": {
            const text = String(msg.text || "").trim();
            if (!text) return;
            const chatMsg: ChatMessagePayload = {
              id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              userId: user.id,
              username: user.username,
              text: text.slice(0, 500),
              isEmoji: Boolean(msg.isEmoji),
              timestamp: Date.now(),
            };
            roomManager.broadcast(roomCode, {
              type: "CHAT",
              message: chatMsg,
            });
            break;
          }
        }
      } catch {
        // ignore malformed frame
      }
    });

    ws.on("close", () => {
      const { promotedHost } = roomManager.removeParticipant(roomCode, user.id);

      roomManager.broadcast(roomCode, {
        type: "PARTICIPANT_LEFT",
        userId: user.id,
        username: user.username,
      });

      if (promotedHost) {
        roomManager.broadcast(roomCode, {
          type: "HOST_CHANGED",
          hostId: promotedHost.hostId,
          hostUsername: promotedHost.hostUsername,
        });
      }
    });

    ws.on("error", (err) => {
      console.error(`[WatchParty WS Error] Room ${roomCode}, User ${user.id}:`, err);
    });
  });

  return wss;
}
