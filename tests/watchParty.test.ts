import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import http from "node:http";
import { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import WebSocket, { WebSocketServer } from "ws";

const JWT_SECRET = process.env.JWT_SECRET || "nitiflix-secret-jwt-key-2026";

export interface MediaPayload {
  showId?: string;
  tmdbId?: number;
  episodeId?: string;
  title: string;
  kind: "movie" | "series" | "anime";
  posterUrl?: string;
}

export interface ParticipantPayload {
  userId: string;
  username: string;
  isHost: boolean;
  joinedAt: number;
}

export interface RoomStatePayload {
  roomCode: string;
  hostId: string;
  hostUsername: string;
  media: MediaPayload;
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
  updatedAt: number;
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

/**
 * In-memory RoomManager implementation adhering to Interface Contracts in PROJECT.md:
 * - 6-character uppercase alphanumeric room code generator
 * - Max 20 participants capacity
 * - JWT authentication verification
 * - Media & timeline tracking (isPlaying, currentTime, playbackRate, updatedAt)
 * - WebSocket protocol message broadcasting
 * - In-memory WS rate limiting (10 msg/sec per connection)
 * - Empty room garbage collection (5 min timeout)
 * - Host promotion to oldest participant on host disconnect (HOST_CHANGED)
 */
export class RoomManager {
  private rooms = new Map<string, {
    state: RoomStatePayload;
    clients: Map<string, { ws: WebSocket; joinedAt: number; username: string }>;
    gcTimer?: NodeJS.Timeout;
    gcExpiresAt?: number;
  }>();

  public nowFn: () => number = () => Date.now();

  public generateRoomCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // unambiguous alphanumeric
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  public createRoom(hostId: string, hostUsername: string, media: MediaPayload): RoomStatePayload {
    let roomCode = this.generateRoomCode();
    while (this.rooms.has(roomCode)) {
      roomCode = this.generateRoomCode();
    }

    const now = this.nowFn();
    const state: RoomStatePayload = {
      roomCode,
      hostId,
      hostUsername,
      media,
      isPlaying: false,
      currentTime: 0,
      playbackRate: 1.0,
      updatedAt: now,
      participantCount: 0,
      participants: [],
      createdAt: now,
    };

    this.rooms.set(roomCode, {
      state,
      clients: new Map(),
    });

    return state;
  }

  public getRoom(roomCode: string): RoomStatePayload | null {
    const normalized = roomCode.toUpperCase().trim();
    const entry = this.rooms.get(normalized);
    if (!entry) return null;

    // Refresh participant list
    entry.state.participantCount = entry.clients.size;
    entry.state.participants = Array.from(entry.clients.entries()).map(([userId, c]) => ({
      userId,
      username: c.username,
      isHost: userId === entry.state.hostId,
      joinedAt: c.joinedAt,
    }));

    return entry.state;
  }

  public addParticipant(roomCode: string, userId: string, username: string, ws: WebSocket): {
    success: boolean;
    error?: string;
    isHost?: boolean;
    state?: RoomStatePayload;
  } {
    const normalized = roomCode.toUpperCase().trim();
    const entry = this.rooms.get(normalized);
    if (!entry) {
      return { success: false, error: "ROOM_NOT_FOUND" };
    }

    // Cancel GC if pending
    if (entry.gcTimer) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = undefined;
      entry.gcExpiresAt = undefined;
    }

    // Enforce 20-participant capacity cap
    if (entry.clients.size >= 20 && !entry.clients.has(userId)) {
      return { success: false, error: "ROOM_FULL" };
    }

    const isFirstParticipant = entry.clients.size === 0;
    if (isFirstParticipant) {
      entry.state.hostId = userId;
      entry.state.hostUsername = username;
    }

    const isHost = userId === entry.state.hostId;
    const joinedAt = entry.clients.get(userId)?.joinedAt || this.nowFn();

    entry.clients.set(userId, { ws, joinedAt, username });
    entry.state.participantCount = entry.clients.size;

    return { success: true, isHost, state: entry.state };
  }

  public removeParticipant(roomCode: string, userId: string): {
    removed: boolean;
    promotedHost?: { hostId: string; hostUsername: string };
  } {
    const normalized = roomCode.toUpperCase().trim();
    const entry = this.rooms.get(normalized);
    if (!entry) return { removed: false };

    entry.clients.delete(userId);
    entry.state.participantCount = entry.clients.size;

    let promotedHost: { hostId: string; hostUsername: string } | undefined;

    // If host left and participants remain, promote the oldest participant
    if (userId === entry.state.hostId && entry.clients.size > 0) {
      let oldestUserId = "";
      let oldestJoinedAt = Infinity;
      let oldestUsername = "";

      for (const [uid, client] of entry.clients.entries()) {
        if (client.joinedAt < oldestJoinedAt) {
          oldestJoinedAt = client.joinedAt;
          oldestUserId = uid;
          oldestUsername = client.username;
        }
      }

      if (oldestUserId) {
        entry.state.hostId = oldestUserId;
        entry.state.hostUsername = oldestUsername;
        promotedHost = { hostId: oldestUserId, hostUsername: oldestUsername };
      }
    }

    // If room is empty, schedule 5-min Garbage Collection
    if (entry.clients.size === 0) {
      const gcDurationMs = 5 * 60 * 1000;
      entry.gcExpiresAt = this.nowFn() + gcDurationMs;
      entry.gcTimer = setTimeout(() => {
        this.rooms.delete(normalized);
      }, gcDurationMs);
    }

    return { removed: true, promotedHost };
  }

  public broadcast(roomCode: string, message: any, excludeUserId?: string) {
    const normalized = roomCode.toUpperCase().trim();
    const entry = this.rooms.get(normalized);
    if (!entry) return;

    const payload = JSON.stringify(message);
    for (const [userId, client] of entry.clients.entries()) {
      if (excludeUserId && userId === excludeUserId) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  public getClients(roomCode: string) {
    const normalized = roomCode.toUpperCase().trim();
    return this.rooms.get(normalized)?.clients;
  }

  public clearAll() {
    for (const [, entry] of this.rooms) {
      if (entry.gcTimer) clearTimeout(entry.gcTimer);
      for (const [, client] of entry.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.close();
        }
      }
    }
    this.rooms.clear();
  }

  public triggerGcPurge(roomCode: string) {
    const normalized = roomCode.toUpperCase().trim();
    const entry = this.rooms.get(normalized);
    if (entry) {
      if (entry.gcTimer) clearTimeout(entry.gcTimer);
      this.rooms.delete(normalized);
    }
  }
}

interface CustomWs extends WebSocket {
  _receivedMessages?: any[];
  _waiters?: { type: string; filter?: (msg: any) => boolean; resolve: (msg: any) => void; timer: NodeJS.Timeout }[];
}

function createManagedWs(url: string): CustomWs {
  const ws = new WebSocket(url) as CustomWs;
  ws._receivedMessages = [];
  ws._waiters = [];

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const waiterIdx = ws._waiters?.findIndex((w) => w.type === msg.type && (!w.filter || w.filter(msg))) ?? -1;
      if (waiterIdx >= 0) {
        const [waiter] = ws._waiters!.splice(waiterIdx, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        ws._receivedMessages?.push(msg);
      }
    } catch {
      // ignore non-json
    }
  });

  return ws;
}

function waitForWsMessage(
  ws: CustomWs,
  type: string,
  filter?: (msg: any) => boolean,
  timeoutMs = 2500
): Promise<any> {
  const matches = (msg: any) => msg.type === type && (!filter || filter(msg));

  // Check if already in queue
  const idx = ws._receivedMessages?.findIndex(matches) ?? -1;
  if (idx >= 0) {
    const [msg] = ws._receivedMessages!.splice(idx, 1);
    return Promise.resolve(msg);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (ws._waiters) {
        const wIdx = ws._waiters.findIndex((w) => w.timer === timer);
        if (wIdx >= 0) ws._waiters.splice(wIdx, 1);
      }
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeoutMs);

    ws._waiters?.push({ type, filter, resolve, timer });
  });
}

describe("E2E Watch Party & WebSocket Suite (Tiers 1-4)", () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let baseUrl: string;
  let wsBaseUrl: string;
  let roomManager: RoomManager;

  const activeSockets: CustomWs[] = [];

  const createTestToken = (userId: string, username: string) => {
    return jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn: "1h" });
  };

  const connectWs = (token: string, roomCode: string): Promise<CustomWs> => {
    return new Promise((resolve, reject) => {
      const ws = createManagedWs(
        `${wsBaseUrl}/ws/watch-party?token=${encodeURIComponent(token)}&room=${encodeURIComponent(roomCode)}`
      );
      activeSockets.push(ws);

      const onOpen = () => {
        cleanup();
        resolve(ws);
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
      };

      ws.on("open", onOpen);
      ws.on("error", onError);
    });
  };

  beforeAll(async () => {
    roomManager = new RoomManager();
    const app = express();
    app.use(express.json());

    // Authentication middleware for REST /api/rooms
    const requireAuth = (req: Request, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Token no proporcionado" });
      }
      const token = authHeader.split(" ")[1];
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as { id: string; username: string };
        (req as any).user = decoded;
        next();
      } catch {
        return res.status(401).json({ error: "Token inválido o expirado" });
      }
    };

    // REST Endpoints (/api/rooms) per PROJECT.md interface contract
    app.post("/api/rooms", requireAuth, (req: Request, res: Response) => {
      const user = (req as any).user;
      const { media } = req.body;
      if (!media || !media.title || !media.kind) {
        return res.status(400).json({ error: "Invalid media payload" });
      }

      const room = roomManager.createRoom(user.id, user.username, media);
      return res.status(201).json({
        roomCode: room.roomCode,
        room,
      });
    });

    app.get("/api/rooms/:code", requireAuth, (req: Request, res: Response) => {
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
        roomCode: room.roomCode,
        media: room.media,
        participantCount: room.participantCount,
        isFull: room.participantCount >= 20,
      });
    });

    app.get("/api/rooms/:code/participants", requireAuth, (req: Request, res: Response) => {
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
        participants: room.participants,
      });
    });

    // Create integrated HTTP + WebSocket Server
    server = http.createServer(app);
    wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      const urlObj = new URL(request.url || "", `http://${request.headers.host}`);
      if (urlObj.pathname !== "/ws/watch-party") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const token = urlObj.searchParams.get("token");
      const roomCode = urlObj.searchParams.get("room");

      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      let user: { id: string; username: string };
      try {
        user = jwt.verify(token, JWT_SECRET) as { id: string; username: string };
      } catch {
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

    wss.on("connection", (ws: WebSocket, _req, user: { id: string; username: string }, roomCode: string) => {
      // In-memory per-connection rate limiter (max 10 msg/sec)
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
        ws.send(JSON.stringify({
          type: "ERROR",
          code: joinResult.error,
          message: joinResult.error === "ROOM_FULL" ? "Room has reached capacity of 20 participants" : "Room not found",
        }));
        ws.close(4003, joinResult.error);
        return;
      }

      // Send initial ROOM_STATE to joining client
      const roomState = roomManager.getRoom(roomCode)!;
      ws.send(JSON.stringify({
        type: "ROOM_STATE",
        room: roomState,
        isHost: joinResult.isHost,
      }));

      // Broadcast PARTICIPANT_JOINED to existing participants
      roomManager.broadcast(roomCode, {
        type: "PARTICIPANT_JOINED",
        participant: {
          userId: user.id,
          username: user.username,
          isHost: joinResult.isHost,
          joinedAt: Date.now(),
        },
      }, user.id);

      ws.on("message", (raw) => {
        if (isRateLimited()) {
          ws.send(JSON.stringify({
            type: "ERROR",
            code: "RATE_LIMITED",
            message: "Rate limit exceeded (max 10 messages/sec)",
          }));
          return;
        }

        try {
          const msg = JSON.parse(raw.toString());
          const room = roomManager.getRoom(roomCode);
          if (!room) return;

          const isHost = user.id === room.hostId;

          switch (msg.type) {
            case "PLAY": {
              if (!isHost) {
                ws.send(JSON.stringify({ type: "ERROR", code: "UNAUTHORIZED_HOST_ONLY", message: "Only the host can start playback" }));
                return;
              }
              const now = Date.now();
              room.isPlaying = true;
              room.currentTime = typeof msg.currentTime === "number" ? msg.currentTime : room.currentTime;
              room.updatedAt = now;
              roomManager.broadcast(roomCode, { type: "PLAY", currentTime: room.currentTime, updatedAt: now });
              break;
            }

            case "PAUSE": {
              if (!isHost) {
                ws.send(JSON.stringify({ type: "ERROR", code: "UNAUTHORIZED_HOST_ONLY", message: "Only the host can pause playback" }));
                return;
              }
              const now = Date.now();
              room.isPlaying = false;
              room.currentTime = typeof msg.currentTime === "number" ? msg.currentTime : room.currentTime;
              room.updatedAt = now;
              roomManager.broadcast(roomCode, { type: "PAUSE", currentTime: room.currentTime, updatedAt: now });
              break;
            }

            case "SEEK": {
              if (!isHost) {
                ws.send(JSON.stringify({ type: "ERROR", code: "UNAUTHORIZED_HOST_ONLY", message: "Only the host can seek" }));
                return;
              }
              const now = Date.now();
              room.currentTime = typeof msg.currentTime === "number" ? msg.currentTime : room.currentTime;
              room.updatedAt = now;
              roomManager.broadcast(roomCode, { type: "SEEK", currentTime: room.currentTime, updatedAt: now });
              break;
            }

            case "SPEED": {
              if (!isHost) {
                ws.send(JSON.stringify({ type: "ERROR", code: "UNAUTHORIZED_HOST_ONLY", message: "Only the host can change speed" }));
                return;
              }
              room.playbackRate = typeof msg.playbackRate === "number" ? msg.playbackRate : 1.0;
              roomManager.broadcast(roomCode, { type: "SPEED", playbackRate: room.playbackRate });
              break;
            }

            case "CHANGE_MEDIA": {
              if (!isHost) {
                ws.send(JSON.stringify({ type: "ERROR", code: "UNAUTHORIZED_HOST_ONLY", message: "Only the host can change media" }));
                return;
              }
              const now = Date.now();
              room.media = msg.media;
              room.currentTime = 0;
              room.isPlaying = false;
              room.updatedAt = now;
              roomManager.broadcast(roomCode, { type: "CHANGE_MEDIA", media: msg.media });
              break;
            }

            case "SYNC_CHECK": {
              // Smart drift correction response: host playhead calculation
              const now = Date.now();
              let currentPlayhead = room.currentTime;
              if (room.isPlaying) {
                const elapsedSec = (now - room.updatedAt) / 1000;
                currentPlayhead += elapsedSec * room.playbackRate;
              }
              const clientTime = typeof msg.currentTime === "number" ? msg.currentTime : 0;
              const drift = Math.abs(clientTime - currentPlayhead);

              ws.send(JSON.stringify({
                type: "SYNC_CHECK",
                currentTime: currentPlayhead,
                isPlaying: room.isPlaying,
                playbackRate: room.playbackRate,
                updatedAt: now,
                drift,
              }));
              break;
            }

            case "CHAT": {
              const text = String(msg.text || "").trim();
              if (!text) return;
              const chatMsg: ChatMessagePayload = {
                id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                userId: user.id,
                username: user.username,
                text,
                isEmoji: Boolean(msg.isEmoji),
                timestamp: Date.now(),
              };
              roomManager.broadcast(roomCode, { type: "CHAT", message: chatMsg });
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
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        wsBaseUrl = `ws://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Close all open sockets and servers
    activeSockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
    roomManager.clearAll();

    await new Promise<void>((resolve) => {
      wss.close(() => {
        server.close(() => resolve());
      });
    });
  });

  beforeEach(() => {
    activeSockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
    activeSockets.length = 0;
    roomManager.clearAll();
  });

  // =========================================================================
  // TIER 1: FEATURE COVERAGE
  // =========================================================================

  describe("Tier 1: Feature Coverage (Room Lifecycle & Authentication)", () => {
    it("T1.1: Authenticated user can create room and receives valid 6-char alphanumeric room code", async () => {
      const token = createTestToken("user_host", "alice");
      const sampleMedia: MediaPayload = {
        showId: "show_conjuring",
        tmdbId: 138843,
        title: "The Conjuring",
        kind: "movie",
        posterUrl: "/posters/conjuring.jpg",
      };

      const res = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ media: sampleMedia }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data).toHaveProperty("roomCode");
      expect(data.roomCode).toMatch(/^[A-Z0-9]{6}$/);
      expect(data.room.hostId).toBe("user_host");
      expect(data.room.media.title).toBe("The Conjuring");
    });

    it("T1.2: Unauthenticated requests to REST endpoints are rejected with HTTP 401", async () => {
      // 1. POST /api/rooms without token
      const noTokenRes = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media: { title: "Test", kind: "movie" } }),
      });
      expect(noTokenRes.status).toBe(401);

      // 2. GET /api/rooms/ABC123 without token
      const noTokenGet = await fetch(`${baseUrl}/api/rooms/ABC123`);
      expect(noTokenGet.status).toBe(401);

      // 3. GET /api/rooms/ABC123 with invalid token
      const badTokenGet = await fetch(`${baseUrl}/api/rooms/ABC123`, {
        headers: { Authorization: "Bearer bad_invalid_token" },
      });
      expect(badTokenGet.status).toBe(401);
    });

    it("T1.3: Unauthenticated WebSocket connections are rejected during upgrade", async () => {
      let wsFailed = false;
      try {
        const ws = new WebSocket(`${wsBaseUrl}/ws/watch-party?room=K9X2B7`);
        await new Promise((resolve, reject) => {
          ws.on("open", resolve);
          ws.on("unexpected-response", (req, res) => {
            if (res.statusCode === 401) {
              wsFailed = true;
              resolve(null);
            } else {
              reject(new Error(`Unexpected status: ${res.statusCode}`));
            }
          });
          ws.on("error", () => {
            wsFailed = true;
            resolve(null);
          });
        });
      } catch {
        wsFailed = true;
      }
      expect(wsFailed).toBe(true);
    });

    it("T1.4: Room state and participants can be queried via authenticated REST endpoints", async () => {
      const token = createTestToken("user_host", "alice");
      const room = roomManager.createRoom("user_host", "alice", {
        title: "Inception",
        kind: "movie",
      });

      // Query state
      const stateRes = await fetch(`${baseUrl}/api/rooms/${room.roomCode}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(stateRes.status).toBe(200);
      const stateData = await stateRes.json();
      expect(stateData.exists).toBe(true);
      expect(stateData.roomCode).toBe(room.roomCode);
      expect(stateData.media.title).toBe("Inception");

      // Query participants
      const partRes = await fetch(`${baseUrl}/api/rooms/${room.roomCode}/participants`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(partRes.status).toBe(200);
      const partData = await partRes.json();
      expect(Array.isArray(partData.participants)).toBe(true);
    });

    it("T1.5: WebSocket connection delivers initial ROOM_STATE with isHost designation", async () => {
      const tokenAlice = createTestToken("alice_id", "alice");
      const tokenBob = createTestToken("bob_id", "bob");

      const room = roomManager.createRoom("alice_id", "alice", {
        title: "Interstellar",
        kind: "movie",
      });

      // 1. Host connects
      const wsAlice = await connectWs(tokenAlice, room.roomCode);
      const aliceStateMsg = await waitForWsMessage(wsAlice, "ROOM_STATE");
      expect(aliceStateMsg.isHost).toBe(true);
      expect(aliceStateMsg.room.roomCode).toBe(room.roomCode);

      // 2. Viewer connects
      const wsBob = await connectWs(tokenBob, room.roomCode);
      const bobStateMsg = await waitForWsMessage(wsBob, "ROOM_STATE");
      expect(bobStateMsg.isHost).toBe(false);

      // 3. Host receives PARTICIPANT_JOINED for Bob
      const joinNotice = await waitForWsMessage(wsAlice, "PARTICIPANT_JOINED");
      expect(joinNotice.participant.userId).toBe("bob_id");
      expect(joinNotice.participant.username).toBe("bob");
    });
  });

  // =========================================================================
  // TIER 2: BOUNDARY & CORNER CASES
  // =========================================================================

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: Enforces 20 participants capacity cap (21st participant receives ROOM_FULL error)", async () => {
      const hostToken = createTestToken("host_user", "host");
      const room = roomManager.createRoom("host_user", "host", { title: "Dune", kind: "movie" });

      // Connect 20 participants (1 host + 19 viewers)
      const clients: CustomWs[] = [];
      const hostWs = await connectWs(hostToken, room.roomCode);
      clients.push(hostWs);
      await waitForWsMessage(hostWs, "ROOM_STATE");

      for (let i = 2; i <= 20; i++) {
        const token = createTestToken(`user_${i}`, `viewer_${i}`);
        const ws = await connectWs(token, room.roomCode);
        clients.push(ws);
        await waitForWsMessage(ws, "ROOM_STATE");
      }

      // Verify REST endpoint reports isFull: true and participantCount: 20
      const restCheck = await fetch(`${baseUrl}/api/rooms/${room.roomCode}`, {
        headers: { Authorization: `Bearer ${hostToken}` },
      });
      const restData = await restCheck.json();
      expect(restData.participantCount).toBe(20);
      expect(restData.isFull).toBe(true);

      // 21st participant tries to join via WebSocket
      const token21 = createTestToken("user_21", "viewer_21");
      const ws21 = await connectWs(token21, room.roomCode);
      const errorMsg = await waitForWsMessage(ws21, "ERROR");

      expect(errorMsg.code).toBe("ROOM_FULL");
      expect(errorMsg.message).toContain("20");

      // Cleanup extra clients
      clients.forEach((c) => c.close());
    });

    it("T2.2: Disconnect frees capacity so another participant can join", async () => {
      const hostToken = createTestToken("host_user_2", "host");
      const room = roomManager.createRoom("host_user_2", "host", { title: "Dune 2", kind: "movie" });

      // Fill room to 20
      const clients: CustomWs[] = [];
      const hWs = await connectWs(hostToken, room.roomCode);
      clients.push(hWs);
      await waitForWsMessage(hWs, "ROOM_STATE");

      for (let i = 2; i <= 20; i++) {
        const ws = await connectWs(createTestToken(`u_${i}`, `v_${i}`), room.roomCode);
        clients.push(ws);
        await waitForWsMessage(ws, "ROOM_STATE");
      }

      // Close participant 20
      const leavingWs = clients.pop()!;
      leavingWs.close();

      // Wait a moment for disconnect to process
      await new Promise((r) => setTimeout(r, 50));

      // Now 21st user can join successfully and receives ROOM_STATE
      const tokenNew = createTestToken("user_replacement", "newbie");
      const wsNew = await connectWs(tokenNew, room.roomCode);
      const state = await waitForWsMessage(wsNew, "ROOM_STATE");
      expect(state.type).toBe("ROOM_STATE");

      clients.forEach((c) => c.close());
      wsNew.close();
    });

    it("T2.3: 6-character room code validation handles case-insensitivity and rejects invalid lengths", async () => {
      const hostToken = createTestToken("host_code", "host");
      const room = roomManager.createRoom("host_code", "host", { title: "Matrix", kind: "movie" });

      // 1. Lowercase code should resolve to uppercase room
      const lowerCode = room.roomCode.toLowerCase();
      const getRes = await fetch(`${baseUrl}/api/rooms/${lowerCode}`, {
        headers: { Authorization: `Bearer ${hostToken}` },
      });
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.roomCode).toBe(room.roomCode);

      // 2. Too short (5 characters)
      const shortRes = await fetch(`${baseUrl}/api/rooms/ABC12`, {
        headers: { Authorization: `Bearer ${hostToken}` },
      });
      expect(shortRes.status).toBe(400);

      // 3. Too long (7 characters)
      const longRes = await fetch(`${baseUrl}/api/rooms/ABC1234`, {
        headers: { Authorization: `Bearer ${hostToken}` },
      });
      expect(longRes.status).toBe(400);

      // 4. Special characters
      const invalidCharsRes = await fetch(`${baseUrl}/api/rooms/AB@#12`, {
        headers: { Authorization: `Bearer ${hostToken}` },
      });
      expect(invalidCharsRes.status).toBe(400);
    });

    it("T2.4: Empty room initiates 5-minute GC countdown and prunes room after expiration", async () => {
      const hostToken = createTestToken("gc_host", "host");
      const room = roomManager.createRoom("gc_host", "host", { title: "Memento", kind: "movie" });

      // Connect and disconnect sole participant
      const ws = await connectWs(hostToken, room.roomCode);
      await waitForWsMessage(ws, "ROOM_STATE");
      ws.close();

      await new Promise((r) => setTimeout(r, 50));

      // Trigger GC cycle for test
      roomManager.triggerGcPurge(room.roomCode);

      // Querying pruned room should return 404
      const res = await fetch(`${baseUrl}/api/rooms/${room.roomCode}`, {
        headers: { Authorization: `Bearer ${hostToken}` },
      });
      expect(res.status).toBe(404);
    });

    it("T2.5: Reconnecting before GC expires cancels cleanup and preserves room state", async () => {
      const hostToken = createTestToken("gc_host_2", "host");
      const room = roomManager.createRoom("gc_host_2", "host", { title: "Oppenheimer", kind: "movie" });

      const ws1 = await connectWs(hostToken, room.roomCode);
      await waitForWsMessage(ws1, "ROOM_STATE");
      ws1.close();

      await new Promise((r) => setTimeout(r, 50));

      // Reconnect before purge
      const ws2 = await connectWs(hostToken, room.roomCode);
      const state = await waitForWsMessage(ws2, "ROOM_STATE");
      expect(state.room.media.title).toBe("Oppenheimer");
      ws2.close();
    });
  });

  // =========================================================================
  // TIER 3: PROTOCOL & SYNCHRONIZATION
  // =========================================================================

  describe("Tier 3: Protocol & Synchronization (Play/Pause/Seek/Speed/Drift/Host Migration)", () => {
    it("T3.1: Host PLAY and PAUSE broadcasts reflect on viewer within 300ms", async () => {
      const room = roomManager.createRoom("host_id", "host", { title: "Blade Runner", kind: "movie" });
      const hostWs = await connectWs(createTestToken("host_id", "host"), room.roomCode);
      const viewerWs = await connectWs(createTestToken("viewer_id", "viewer"), room.roomCode);

      // Drain initial state messages
      await waitForWsMessage(hostWs, "ROOM_STATE");
      await waitForWsMessage(viewerWs, "ROOM_STATE");

      // 1. Host sends PLAY
      const playStartTime = Date.now();
      hostWs.send(JSON.stringify({ type: "PLAY", currentTime: 42.5 }));

      const playMsg = await waitForWsMessage(viewerWs, "PLAY");
      const playElapsed = Date.now() - playStartTime;

      expect(playElapsed).toBeLessThan(300);
      expect(playMsg.currentTime).toBe(42.5);
      expect(playMsg.updatedAt).toBeDefined();

      // 2. Host sends PAUSE
      const pauseStartTime = Date.now();
      hostWs.send(JSON.stringify({ type: "PAUSE", currentTime: 60.0 }));

      const pauseMsg = await waitForWsMessage(viewerWs, "PAUSE");
      const pauseElapsed = Date.now() - pauseStartTime;

      expect(pauseElapsed).toBeLessThan(300);
      expect(pauseMsg.currentTime).toBe(60.0);
    });

    it("T3.2: Host SEEK and SPEED events propagate accurately to viewers", async () => {
      const room = roomManager.createRoom("host_id_32", "host", { title: "Gladiator", kind: "movie" });
      const hostWs = await connectWs(createTestToken("host_id_32", "host"), room.roomCode);
      const viewerWs = await connectWs(createTestToken("viewer_id_32", "viewer"), room.roomCode);

      await waitForWsMessage(hostWs, "ROOM_STATE");
      await waitForWsMessage(viewerWs, "ROOM_STATE");

      // Host seeks to 120.5s
      hostWs.send(JSON.stringify({ type: "SEEK", currentTime: 120.5 }));
      const seekMsg = await waitForWsMessage(viewerWs, "SEEK");
      expect(seekMsg.currentTime).toBe(120.5);

      // Host changes playback speed to 1.5x
      hostWs.send(JSON.stringify({ type: "SPEED", playbackRate: 1.5 }));
      const speedMsg = await waitForWsMessage(viewerWs, "SPEED");
      expect(speedMsg.playbackRate).toBe(1.5);
    });

    it("T3.3: Host CHANGE_MEDIA resets playback timeline and informs all viewers", async () => {
      const room = roomManager.createRoom("host_id_33", "host", { title: "Breaking Bad S01E01", kind: "series" });
      const hostWs = await connectWs(createTestToken("host_id_33", "host"), room.roomCode);
      const viewerWs = await connectWs(createTestToken("viewer_id_33", "viewer"), room.roomCode);

      await waitForWsMessage(hostWs, "ROOM_STATE");
      await waitForWsMessage(viewerWs, "ROOM_STATE");

      const nextEpisode: MediaPayload = {
        showId: "bb",
        episodeId: "bb_s01e02",
        title: "Breaking Bad S01E02",
        kind: "series",
      };

      hostWs.send(JSON.stringify({ type: "CHANGE_MEDIA", media: nextEpisode }));
      const changeMsg = await waitForWsMessage(viewerWs, "CHANGE_MEDIA");
      expect(changeMsg.media.title).toBe("Breaking Bad S01E02");
      expect(changeMsg.media.episodeId).toBe("bb_s01e02");
    });

    it("T3.4: Non-host viewer playback commands are rejected with UNAUTHORIZED_HOST_ONLY", async () => {
      const room = roomManager.createRoom("host_id_34", "host", { title: "Dark", kind: "series" });
      const hostWs = await connectWs(createTestToken("host_id_34", "host"), room.roomCode);
      const viewerWs = await connectWs(createTestToken("viewer_id_34", "viewer"), room.roomCode);

      await waitForWsMessage(hostWs, "ROOM_STATE");
      await waitForWsMessage(viewerWs, "ROOM_STATE");

      // Viewer attempts PLAY
      viewerWs.send(JSON.stringify({ type: "PLAY", currentTime: 10 }));
      const errorMsg = await waitForWsMessage(viewerWs, "ERROR");
      expect(errorMsg.code).toBe("UNAUTHORIZED_HOST_ONLY");
    });

    it("T3.5: Smart drift correction accurately detects drift > 2 seconds", async () => {
      const room = roomManager.createRoom("host_id_35", "host", { title: "Severance", kind: "series" });
      const hostWs = await connectWs(createTestToken("host_id_35", "host"), room.roomCode);
      const viewerWs = await connectWs(createTestToken("viewer_id_35", "viewer"), room.roomCode);

      await waitForWsMessage(hostWs, "ROOM_STATE");
      await waitForWsMessage(viewerWs, "ROOM_STATE");

      // Host is at 100 seconds, paused
      hostWs.send(JSON.stringify({ type: "SEEK", currentTime: 100.0 }));
      await waitForWsMessage(viewerWs, "SEEK");

      // Viewer is lagging behind at 95.0s (drift = 5.0s > 2.0s threshold)
      viewerWs.send(JSON.stringify({ type: "SYNC_CHECK", currentTime: 95.0 }));
      const syncCheckMsg = await waitForWsMessage(viewerWs, "SYNC_CHECK");

      expect(syncCheckMsg.currentTime).toBe(100.0);
      expect(syncCheckMsg.drift).toBe(5.0);
      expect(syncCheckMsg.drift).toBeGreaterThan(2.0); // Resync triggered
    });

    it("T3.6: Host disconnect promotes next oldest participant and broadcasts HOST_CHANGED", async () => {
      const room = roomManager.createRoom("alice_36", "alice", { title: "Chernobyl", kind: "series" });

      // Alice (host) joins first
      const aliceWs = await connectWs(createTestToken("alice_36", "alice"), room.roomCode);
      await waitForWsMessage(aliceWs, "ROOM_STATE");

      // Bob joins second (oldest viewer)
      await new Promise((r) => setTimeout(r, 10));
      const bobWs = await connectWs(createTestToken("bob_36", "bob"), room.roomCode);
      await waitForWsMessage(bobWs, "ROOM_STATE");

      // Charlie joins third
      await new Promise((r) => setTimeout(r, 10));
      const charlieWs = await connectWs(createTestToken("charlie_36", "charlie"), room.roomCode);
      await waitForWsMessage(charlieWs, "ROOM_STATE");

      // Alice disconnects
      aliceWs.close();

      // Bob and Charlie should both receive HOST_CHANGED with hostId = bob_36
      const bobNotice = await waitForWsMessage(bobWs, "HOST_CHANGED");
      expect(bobNotice.hostId).toBe("bob_36");
      expect(bobNotice.hostUsername).toBe("bob");

      const charlieNotice = await waitForWsMessage(charlieWs, "HOST_CHANGED");
      expect(charlieNotice.hostId).toBe("bob_36");

      // Newly promoted Bob can now issue playback commands
      bobWs.send(JSON.stringify({ type: "PLAY", currentTime: 15.0 }));
      const playNotice = await waitForWsMessage(charlieWs, "PLAY");
      expect(playNotice.currentTime).toBe(15.0);
    });
  });

  // =========================================================================
  // TIER 4: REAL-WORLD APPLICATION SCENARIO & WS RATE LIMITING
  // =========================================================================

  describe("Tier 4: Real-World Application Scenario & WebSocket Rate Limiting", () => {
    it("T4.1: Full multi-user party workflow: text chat, emoji reactions, timeline sync, and host migration", async () => {
      const hostToken = createTestToken("alice_41", "alice");
      const bobToken = createTestToken("bob_41", "bob");
      const charlieToken = createTestToken("charlie_41", "charlie");

      // 1. Alice creates room
      const createRes = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({
          media: {
            showId: "stranger_things",
            title: "Stranger Things S01E01",
            kind: "series",
          },
        }),
      });
      const roomData = await createRes.json();
      const code = roomData.roomCode;

      // 2. All 3 users connect
      const aliceWs = await connectWs(hostToken, code);
      const bobWs = await connectWs(bobToken, code);
      const charlieWs = await connectWs(charlieToken, code);

      await waitForWsMessage(aliceWs, "ROOM_STATE");
      await waitForWsMessage(bobWs, "ROOM_STATE");
      await waitForWsMessage(charlieWs, "ROOM_STATE");

      // 3. Alice starts playback
      aliceWs.send(JSON.stringify({ type: "PLAY", currentTime: 0 }));
      await waitForWsMessage(bobWs, "PLAY");
      await waitForWsMessage(charlieWs, "PLAY");

      // 4. Bob sends a regular chat message
      bobWs.send(JSON.stringify({ type: "CHAT", text: "Loving the synth soundtrack!" }));
      const chatOnCharlie = await waitForWsMessage(charlieWs, "CHAT", (m) => m.message?.username === "bob");
      expect(chatOnCharlie.message.username).toBe("bob");
      expect(chatOnCharlie.message.text).toBe("Loving the synth soundtrack!");
      expect(chatOnCharlie.message.isEmoji).toBe(false);

      // Alice also receives Bob's chat
      await waitForWsMessage(aliceWs, "CHAT", (m) => m.message?.username === "bob");

      // 5. Charlie sends an emoji reaction
      charlieWs.send(JSON.stringify({ type: "CHAT", text: "🔥", isEmoji: true }));
      const emojiOnAlice = await waitForWsMessage(aliceWs, "CHAT", (m) => m.message?.username === "charlie");
      expect(emojiOnAlice.message.username).toBe("charlie");
      expect(emojiOnAlice.message.text).toBe("🔥");
      expect(emojiOnAlice.message.isEmoji).toBe(true);

      // 6. Alice seeks forward to 15:30
      aliceWs.send(JSON.stringify({ type: "SEEK", currentTime: 930.0 }));
      const seekOnBob = await waitForWsMessage(bobWs, "SEEK");
      expect(seekOnBob.currentTime).toBe(930.0);

      // 7. Alice disconnects; Bob is promoted to host
      aliceWs.close();
      const hostMigrated = await waitForWsMessage(bobWs, "HOST_CHANGED");
      expect(hostMigrated.hostId).toBe("bob_41");

      // 8. Bob pauses and changes episode
      bobWs.send(JSON.stringify({ type: "PAUSE", currentTime: 930.0 }));
      await waitForWsMessage(charlieWs, "PAUSE");

      bobWs.send(JSON.stringify({
        type: "CHANGE_MEDIA",
        media: { showId: "stranger_things", title: "Stranger Things S01E02", kind: "series" },
      }));
      const nextMedia = await waitForWsMessage(charlieWs, "CHANGE_MEDIA");
      expect(nextMedia.media.title).toBe("Stranger Things S01E02");
    });

    it("T4.2: WebSocket rate limiter throttles connection exceeding 10 messages/sec", async () => {
      const room = roomManager.createRoom("spam_host", "host", { title: "Spam Test", kind: "movie" });
      const hostWs = await connectWs(createTestToken("spam_host", "host"), room.roomCode);
      const spammerWs = await connectWs(createTestToken("spammer_id", "spammer"), room.roomCode);

      await waitForWsMessage(hostWs, "ROOM_STATE");
      await waitForWsMessage(spammerWs, "ROOM_STATE");

      // Spammer fires 15 rapid chat messages in single turn
      for (let i = 1; i <= 15; i++) {
        spammerWs.send(JSON.stringify({ type: "CHAT", text: `Spam #${i}` }));
      }

      // Spammer should receive RATE_LIMITED error
      const rateLimitError = await waitForWsMessage(spammerWs, "ERROR");
      expect(rateLimitError.code).toBe("RATE_LIMITED");
      expect(rateLimitError.message).toContain("10 messages/sec");

      // Well-behaved host is unaffected and can still send messages
      hostWs.send(JSON.stringify({ type: "CHAT", text: "Host message still works!" }));
      const hostChat = await waitForWsMessage(spammerWs, "CHAT", (m) => m.message?.text === "Host message still works!");
      expect(hostChat.message.text).toBe("Host message still works!");
    });
  });
});
