import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express, { Request, Response } from "express";
import http from "node:http";
import { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import {
  RoomManager,
  roomManager,
  roomsRouter,
  setupWatchPartyWebSocket,
  sanitizeRoom,
  sanitizeParticipant,
  MediaPayload,
} from "../server/watchParty";
import { JWT_SECRET, requireAuth, verifyAuthToken } from "../server/auth";

interface ManagedWs extends WebSocket {
  _messages?: any[];
  _waiters?: { type: string; filter?: (msg: any) => boolean; resolve: (msg: any) => void; timer: NodeJS.Timeout }[];
}

function createClientWs(url: string): ManagedWs {
  const ws = new WebSocket(url) as ManagedWs;
  ws._messages = [];
  ws._waiters = [];

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      const idx = ws._waiters?.findIndex((w) => w.type === parsed.type && (!w.filter || w.filter(parsed))) ?? -1;
      if (idx >= 0) {
        const [waiter] = ws._waiters!.splice(idx, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      } else {
        ws._messages?.push(parsed);
      }
    } catch {
      // ignore non-json
    }
  });

  return ws;
}

function waitForMessage(
  ws: ManagedWs,
  type: string,
  filter?: (msg: any) => boolean,
  timeoutMs = 2500
): Promise<any> {
  const matches = (msg: any) => msg.type === type && (!filter || filter(msg));
  const idx = ws._messages?.findIndex(matches) ?? -1;
  if (idx >= 0) {
    const [msg] = ws._messages!.splice(idx, 1);
    return Promise.resolve(msg);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (ws._waiters) {
        const wIdx = ws._waiters.findIndex((w) => w.timer === timer);
        if (wIdx >= 0) ws._waiters.splice(wIdx, 1);
      }
      reject(new Error(`Timeout waiting for WS message type: ${type}`));
    }, timeoutMs);

    ws._waiters?.push({ type, filter, resolve, timer });
  });
}

describe("Empirical Reviewer M2-1 Suite: Direct Verification of server/watchParty.ts", () => {
  let server: http.Server;
  let baseUrl: string;
  let wsBaseUrl: string;
  const activeSockets: ManagedWs[] = [];

  const createToken = (userId: string, username: string, isAdmin = false) => {
    return jwt.sign({ id: userId, username, is_admin: isAdmin }, JWT_SECRET, { expiresIn: "1h" });
  };

  const connectWs = (token: string, roomCode: string): Promise<ManagedWs> => {
    return new Promise((resolve, reject) => {
      const url = `${wsBaseUrl}/ws/watch-party?token=${encodeURIComponent(token)}&room=${encodeURIComponent(roomCode)}`;
      const ws = createClientWs(url);
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
    const app = express();
    app.use(express.json());
    app.use("/api/rooms", requireAuth, roomsRouter);

    server = http.createServer(app);
    setupWatchPartyWebSocket(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    wsBaseUrl = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    for (const ws of activeSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    roomManager.clearAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    roomManager.clearAll();
  });

  describe("1. Room Code Generation & Entropy Invariants", () => {
    it("generates clean 6-character alphanumeric codes without ambiguous characters", () => {
      const codes = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const code = roomManager.generateRoomCode();
        expect(code).toHaveLength(6);
        expect(code).toMatch(/^[A-Z0-9]{6}$/);
        // Ensure no ambiguous characters: 0, 1, O, I
        expect(code).not.toMatch(/[01OI]/);
        codes.add(code);
      }
      expect(codes.size).toBe(1000);
    });
  });

  describe("2. RoomManager Unit & Capacity Invariants", () => {
    it("enforces strict 20 participant capacity cap and allows reconnection", () => {
      const mgr = new RoomManager();
      const media: MediaPayload = { title: "Test Film", kind: "movie" };
      const room = mgr.createRoom("user_host", "HostUser", media);

      // Add 20 participants
      for (let i = 1; i <= 20; i++) {
        const res = mgr.addParticipant(room.code, `user_${i}`, `User${i}`);
        expect(res.success).toBe(true);
      }
      expect(room.participants.size).toBe(20);

      // 21st unique participant is rejected with ROOM_FULL
      const res21 = mgr.addParticipant(room.code, "user_21", "User21");
      expect(res21.success).toBe(false);
      expect(res21.error).toBe("ROOM_FULL");

      // Reconnecting existing participant succeeds
      const reconnectRes = mgr.addParticipant(room.code, "user_5", "User5Renamed");
      expect(reconnectRes.success).toBe(true);
      expect(room.participants.size).toBe(20);

      // Participant leaving frees capacity
      mgr.removeParticipant(room.code, "user_5");
      expect(room.participants.size).toBe(19);

      // Now 21 can join
      const res21Retry = mgr.addParticipant(room.code, "user_21", "User21");
      expect(res21Retry.success).toBe(true);
      expect(room.participants.size).toBe(20);
    });

    it("promotes the oldest participant upon host disconnect", () => {
      const mgr = new RoomManager();
      let simulatedTime = 1000;
      mgr.nowFn = () => simulatedTime;

      const media: MediaPayload = { title: "Host Test", kind: "movie" };
      const room = mgr.createRoom("host_user", "OriginalHost", media);

      // Host joins as participant
      mgr.addParticipant(room.code, "host_user", "OriginalHost");

      simulatedTime = 1100;
      mgr.addParticipant(room.code, "viewer_1", "OldestViewer");

      simulatedTime = 1200;
      mgr.addParticipant(room.code, "viewer_2", "NewerViewer");

      expect(room.hostId).toBe("host_user");

      // Host leaves
      const removeResult = mgr.removeParticipant(room.code, "host_user");
      expect(removeResult.removed).toBe(true);
      expect(removeResult.promotedHost).toBeDefined();
      expect(removeResult.promotedHost?.hostId).toBe("viewer_1");
      expect(removeResult.promotedHost?.hostUsername).toBe("OldestViewer");
      expect(room.hostId).toBe("viewer_1");
      expect(room.participants.get("viewer_1")?.isHost).toBe(true);
    });

    it("handles 5-minute empty room GC and cancels on participant rejoin", () => {
      const mgr = new RoomManager();
      const media: MediaPayload = { title: "GC Test", kind: "movie" };
      const room = mgr.createRoom("user_1", "User1", media);

      mgr.addParticipant(room.code, "user_1", "User1");
      expect(room.emptyTimer).toBeUndefined();

      // User leaves -> room empty -> GC timer starts
      mgr.removeParticipant(room.code, "user_1");
      expect(room.emptyTimer).toBeDefined();
      expect(room.emptySince).toBeDefined();

      // User rejoins before GC fires -> timer cleared
      mgr.addParticipant(room.code, "user_2", "User2");
      expect(room.emptyTimer).toBeUndefined();
      expect(room.emptySince).toBeUndefined();
    });
  });

  describe("3. WebSocket Handshake & Security Authentication", () => {
    it("rejects WS upgrade with HTTP 401 when token is missing", async () => {
      const media: MediaPayload = { title: "Auth Test", kind: "movie" };
      const room = roomManager.createRoom("h1", "Host1", media);

      await expect(new Promise((_, reject) => {
        const ws = new WebSocket(`${wsBaseUrl}/ws/watch-party?room=${room.code}`);
        ws.on("unexpected-response", (_req, res) => {
          reject(new Error(`Status ${res.statusCode}`));
        });
        ws.on("error", (err) => reject(err));
      })).rejects.toThrow("Status 401");
    });

    it("rejects WS upgrade with HTTP 401 when token is invalid", async () => {
      const media: MediaPayload = { title: "Auth Test", kind: "movie" };
      const room = roomManager.createRoom("h1", "Host1", media);

      await expect(new Promise((_, reject) => {
        const ws = new WebSocket(`${wsBaseUrl}/ws/watch-party?token=invalid.jwt.token&room=${room.code}`);
        ws.on("unexpected-response", (_req, res) => {
          reject(new Error(`Status ${res.statusCode}`));
        });
        ws.on("error", (err) => reject(err));
      })).rejects.toThrow("Status 401");
    });

    it("rejects WS upgrade with HTTP 400 when room code is malformed", async () => {
      const token = createToken("u1", "User1");

      await expect(new Promise((_, reject) => {
        const ws = new WebSocket(`${wsBaseUrl}/ws/watch-party?token=${encodeURIComponent(token)}&room=BAD`);
        ws.on("unexpected-response", (_req, res) => {
          reject(new Error(`Status ${res.statusCode}`));
        });
        ws.on("error", (err) => reject(err));
      })).rejects.toThrow("Status 400");
    });

    it("sends ROOM_NOT_FOUND and closes with 4003 when room does not exist", async () => {
      const token = createToken("u1", "User1");
      const client = new WebSocket(`${wsBaseUrl}/ws/watch-party?token=${encodeURIComponent(token)}&room=ZZZZ99`);
      activeSockets.push(client as ManagedWs);

      const messagePromise = new Promise<{ code: number; reason: string; errorMsg: any }>((resolve) => {
        let errorMsg: any;
        client.on("message", (raw) => {
          errorMsg = JSON.parse(raw.toString());
        });
        client.on("close", (code, reason) => {
          resolve({ code, reason: reason.toString(), errorMsg });
        });
      });

      const res = await messagePromise;
      expect(res.code).toBe(4003);
      expect(res.errorMsg.type).toBe("ERROR");
      expect(res.errorMsg.code).toBe("ROOM_NOT_FOUND");
    });
  });

  describe("4. Real-Time Protocol & Host Control Enforcement", () => {
    it("delivers ROOM_STATE and broadcasts PARTICIPANT_JOINED", async () => {
      const media: MediaPayload = { title: "Avatar 2", kind: "movie" };
      const room = roomManager.createRoom("host_user", "HostUser", media);

      const hostToken = createToken("host_user", "HostUser");
      const hostWs = await connectWs(hostToken, room.code);

      const hostState = await waitForMessage(hostWs, "ROOM_STATE");
      expect(hostState.room.roomCode).toBe(room.code);
      expect(hostState.isHost).toBe(true);

      // Join viewer
      const viewerToken = createToken("viewer_user", "ViewerUser");
      const viewerWs = await connectWs(viewerToken, room.code);

      const viewerState = await waitForMessage(viewerWs, "ROOM_STATE");
      expect(viewerState.isHost).toBe(false);

      const joinedMsg = await waitForMessage(hostWs, "PARTICIPANT_JOINED");
      expect(joinedMsg.participant.userId).toBe("viewer_user");
      expect(joinedMsg.participant.username).toBe("ViewerUser");
    });

    it("allows host to broadcast PLAY, PAUSE, SEEK, SPEED, and CHANGE_MEDIA", async () => {
      const media: MediaPayload = { title: "Dune 2", kind: "movie" };
      const room = roomManager.createRoom("host_user", "HostUser", media);

      const hostToken = createToken("host_user", "HostUser");
      const viewerToken = createToken("viewer_user", "ViewerUser");

      const hostWs = await connectWs(hostToken, room.code);
      await waitForMessage(hostWs, "ROOM_STATE");

      const viewerWs = await connectWs(viewerToken, room.code);
      await waitForMessage(viewerWs, "ROOM_STATE");

      // Host sends PLAY
      hostWs.send(JSON.stringify({ type: "PLAY", currentTime: 42.5 }));
      const playMsg = await waitForMessage(viewerWs, "PLAY");
      expect(playMsg.currentTime).toBe(42.5);

      // Host sends PAUSE
      hostWs.send(JSON.stringify({ type: "PAUSE", currentTime: 50 }));
      const pauseMsg = await waitForMessage(viewerWs, "PAUSE");
      expect(pauseMsg.currentTime).toBe(50);

      // Host sends SEEK
      hostWs.send(JSON.stringify({ type: "SEEK", currentTime: 120.0 }));
      const seekMsg = await waitForMessage(viewerWs, "SEEK");
      expect(seekMsg.currentTime).toBe(120.0);

      // Host sends SPEED
      hostWs.send(JSON.stringify({ type: "SPEED", playbackRate: 1.5 }));
      const speedMsg = await waitForMessage(viewerWs, "SPEED");
      expect(speedMsg.playbackRate).toBe(1.5);

      // Host sends CHANGE_MEDIA
      const newMedia: MediaPayload = { title: "Oppenheimer", kind: "movie" };
      hostWs.send(JSON.stringify({ type: "CHANGE_MEDIA", media: newMedia }));
      const mediaMsg = await waitForMessage(viewerWs, "CHANGE_MEDIA");
      expect(mediaMsg.media.title).toBe("Oppenheimer");
    });

    it("rejects non-host playback controls with UNAUTHORIZED_HOST_ONLY", async () => {
      const media: MediaPayload = { title: "Interstellar", kind: "movie" };
      const room = roomManager.createRoom("host_user", "HostUser", media);

      const hostToken = createToken("host_user", "HostUser");
      const viewerToken = createToken("viewer_user", "ViewerUser");

      const hostWs = await connectWs(hostToken, room.code);
      await waitForMessage(hostWs, "ROOM_STATE");

      const viewerWs = await connectWs(viewerToken, room.code);
      await waitForMessage(viewerWs, "ROOM_STATE");

      // Viewer attempts PLAY
      viewerWs.send(JSON.stringify({ type: "PLAY", currentTime: 10 }));
      const errPlay = await waitForMessage(viewerWs, "ERROR");
      expect(errPlay.code).toBe("UNAUTHORIZED_HOST_ONLY");

      // Viewer attempts PAUSE
      viewerWs.send(JSON.stringify({ type: "PAUSE", currentTime: 10 }));
      const errPause = await waitForMessage(viewerWs, "ERROR");
      expect(errPause.code).toBe("UNAUTHORIZED_HOST_ONLY");

      // Viewer attempts SEEK
      viewerWs.send(JSON.stringify({ type: "SEEK", currentTime: 10 }));
      const errSeek = await waitForMessage(viewerWs, "ERROR");
      expect(errSeek.code).toBe("UNAUTHORIZED_HOST_ONLY");

      // Viewer attempts SPEED
      viewerWs.send(JSON.stringify({ type: "SPEED", playbackRate: 2.0 }));
      const errSpeed = await waitForMessage(viewerWs, "ERROR");
      expect(errSpeed.code).toBe("UNAUTHORIZED_HOST_ONLY");

      // Viewer attempts CHANGE_MEDIA
      viewerWs.send(JSON.stringify({ type: "CHANGE_MEDIA", media: { title: "Hacked", kind: "movie" } }));
      const errMedia = await waitForMessage(viewerWs, "ERROR");
      expect(errMedia.code).toBe("UNAUTHORIZED_HOST_ONLY");
    });

    it("handles SYNC_CHECK and calculates drift accurately", async () => {
      const media: MediaPayload = { title: "Inception", kind: "movie" };
      const room = roomManager.createRoom("host_user", "HostUser", media);

      const hostToken = createToken("host_user", "HostUser");
      const hostWs = await connectWs(hostToken, room.code);
      await waitForMessage(hostWs, "ROOM_STATE");

      // Set playback to playing at currentTime = 100
      hostWs.send(JSON.stringify({ type: "PLAY", currentTime: 100 }));
      await waitForMessage(hostWs, "PLAY");

      // Send SYNC_CHECK with client time = 95 (drift ~5s)
      hostWs.send(JSON.stringify({ type: "SYNC_CHECK", currentTime: 95 }));
      const syncMsg = await waitForMessage(hostWs, "SYNC_CHECK");
      expect(syncMsg.isPlaying).toBe(true);
      expect(syncMsg.currentTime).toBeGreaterThanOrEqual(100);
      expect(syncMsg.drift).toBeGreaterThanOrEqual(4.9);
    });

    it("broadcasts CHAT messages and emoji reactions", async () => {
      const media: MediaPayload = { title: "The Matrix", kind: "movie" };
      const room = roomManager.createRoom("host_user", "HostUser", media);

      const hostToken = createToken("host_user", "HostUser");
      const viewerToken = createToken("viewer_user", "ViewerUser");

      const hostWs = await connectWs(hostToken, room.code);
      await waitForMessage(hostWs, "ROOM_STATE");

      const viewerWs = await connectWs(viewerToken, room.code);
      await waitForMessage(viewerWs, "ROOM_STATE");

      // Viewer sends chat
      viewerWs.send(JSON.stringify({ type: "CHAT", text: "Hello room!", isEmoji: false }));
      const chatOnHost = await waitForMessage(hostWs, "CHAT");
      expect(chatOnHost.message.text).toBe("Hello room!");
      expect(chatOnHost.message.userId).toBe("viewer_user");
      expect(chatOnHost.message.isEmoji).toBe(false);

      // Viewer sends emoji reaction
      viewerWs.send(JSON.stringify({ type: "CHAT", text: "🔥", isEmoji: true }));
      const emojiOnHost = await waitForMessage(hostWs, "CHAT");
      expect(emojiOnHost.message.text).toBe("🔥");
      expect(emojiOnHost.message.isEmoji).toBe(true);
    });

    it("enforces WebSocket message rate limiter (max 10 msg/sec per socket)", async () => {
      const media: MediaPayload = { title: "Speed", kind: "movie" };
      const room = roomManager.createRoom("host_user", "HostUser", media);

      const viewerToken = createToken("viewer_spammer", "SpamUser");
      const viewerWs = await connectWs(viewerToken, room.code);
      await waitForMessage(viewerWs, "ROOM_STATE");

      // Send 15 messages rapidly
      for (let i = 0; i < 15; i++) {
        viewerWs.send(JSON.stringify({ type: "CHAT", text: `Spam ${i}` }));
      }

      const rateLimitErr = await waitForMessage(viewerWs, "ERROR", (m) => m.code === "RATE_LIMITED");
      expect(rateLimitErr.code).toBe("RATE_LIMITED");
      expect(rateLimitErr.message).toContain("10");
    });

    it("promotes oldest participant and broadcasts HOST_CHANGED on host disconnect", async () => {
      const media: MediaPayload = { title: "Succession", kind: "series" };
      const room = roomManager.createRoom("host_user", "HostUser", media);

      const hostToken = createToken("host_user", "HostUser");
      const viewer1Token = createToken("viewer_1", "ViewerOne");
      const viewer2Token = createToken("viewer_2", "ViewerTwo");

      const hostWs = await connectWs(hostToken, room.code);
      await waitForMessage(hostWs, "ROOM_STATE");

      // Wait a tick to ensure distinct joinedAt
      await new Promise((r) => setTimeout(r, 20));
      const viewer1Ws = await connectWs(viewer1Token, room.code);
      await waitForMessage(viewer1Ws, "ROOM_STATE");

      await new Promise((r) => setTimeout(r, 20));
      const viewer2Ws = await connectWs(viewer2Token, room.code);
      await waitForMessage(viewer2Ws, "ROOM_STATE");

      // Close host socket
      hostWs.close();

      // viewer1 and viewer2 receive HOST_CHANGED
      const hostChangedMsg = await waitForMessage(viewer1Ws, "HOST_CHANGED");
      expect(hostChangedMsg.hostId).toBe("viewer_1");
      expect(hostChangedMsg.hostUsername).toBe("ViewerOne");

      const partLeftMsg = await waitForMessage(viewer2Ws, "PARTICIPANT_LEFT");
      expect(partLeftMsg.userId).toBe("host_user");
    });
  });

  describe("5. REST Endpoints (/api/rooms) Verification", () => {
    it("rejects unauthenticated REST requests with HTTP 401", async () => {
      const resPost = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media: { title: "No Auth" } }),
      });
      expect(resPost.status).toBe(401);

      const resGet = await fetch(`${baseUrl}/api/rooms/TEST01`);
      expect(resGet.status).toBe(401);
    });

    it("allows authenticated user to create a room (POST /api/rooms)", async () => {
      const token = createToken("rest_user_1", "RestUser1");
      const res = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          media: { title: "Interstellar", kind: "movie" },
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.roomCode).toMatch(/^[A-Z0-9]{6}$/);
      expect(data.room.hostId).toBe("rest_user_1");
      expect(data.room.media.title).toBe("Interstellar");
    });

    it("retrieves room state and participants (GET /api/rooms/:code)", async () => {
      const token = createToken("rest_user_2", "RestUser2");
      const media: MediaPayload = { title: "Dark Knight", kind: "movie" };
      const room = roomManager.createRoom("rest_user_2", "RestUser2", media);
      roomManager.addParticipant(room.code, "rest_user_2", "RestUser2");

      const res = await fetch(`${baseUrl}/api/rooms/${room.code}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.exists).toBe(true);
      expect(data.roomCode).toBe(room.code);
      expect(data.participantCount).toBe(1);
      expect(data.isFull).toBe(false);

      const resParts = await fetch(`${baseUrl}/api/rooms/${room.code}/participants`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(resParts.status).toBe(200);
      const partsData = await resParts.json();
      expect(partsData.participants).toHaveLength(1);
      expect(partsData.participants[0].userId).toBe("rest_user_2");
    });

    it("forbids non-host from closing room (DELETE /api/rooms/:code)", async () => {
      const hostToken = createToken("host_id", "HostUser");
      const nonHostToken = createToken("intruder_id", "IntruderUser");
      const media: MediaPayload = { title: "Protected", kind: "movie" };
      const room = roomManager.createRoom("host_id", "HostUser", media);

      // Non-host attempts delete
      const resForbidden = await fetch(`${baseUrl}/api/rooms/${room.code}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${nonHostToken}` },
      });
      expect(resForbidden.status).toBe(403);

      // Host deletes
      const resOk = await fetch(`${baseUrl}/api/rooms/${room.code}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${hostToken}` },
      });
      expect(resOk.status).toBe(200);

      // Room should be gone
      expect(roomManager.getRoom(room.code)).toBeNull();
    });
  });
});
