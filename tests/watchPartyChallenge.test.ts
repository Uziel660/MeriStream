import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { setupWatchPartyWebSocket, roomManager, roomsRouter } from "../server/watchParty";
import { JWT_SECRET, requireAuth } from "../server/auth";

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
      // ignore
    }
  });

  return ws;
}

function waitForWsMessage(
  ws: CustomWs,
  type: string,
  filter?: (msg: any) => boolean,
  timeoutMs = 3000
): Promise<any> {
  const matches = (msg: any) => msg.type === type && (!filter || filter(msg));

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
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for message type: ${type}`));
    }, timeoutMs);

    ws._waiters?.push({ type, filter, resolve, timer });
  });
}

describe("Milestone 2 Empirical Challenge Suite (Real server/watchParty.ts)", () => {
  let server: http.Server;
  let baseUrl: string;
  let wsBaseUrl: string;
  const activeSockets: CustomWs[] = [];

  const createToken = (userId: string, username: string) => {
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
    const app = express();
    app.use(express.json());
    app.use("/api/rooms", requireAuth, roomsRouter);

    server = http.createServer(app);
    setupWatchPartyWebSocket(server);

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
    for (const ws of activeSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    roomManager.clearAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    for (const ws of activeSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    activeSockets.length = 0;
    roomManager.clearAll();
  });

  // =========================================================================
  // CHALLENGE 1: 20-PARTICIPANT CAPACITY ENFORCEMENT & DYNAMIC FREED SLOTS
  // =========================================================================
  describe("Challenge 1: 20-Participant Capacity & Dynamic Reconnection", () => {
    it("connects 20 users -> rejects 21st with ROOM_FULL & 4003 -> disconnect 1 -> 21st user joins", async () => {
      const hostToken = createToken("host_capacity_user", "HostAlice");
      const createRes = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({ media: { title: "Capacity Movie", kind: "movie" } }),
      });
      expect(createRes.status).toBe(201);
      const { roomCode } = await createRes.json();

      // 1. Connect 20 participants (1 host + 19 viewers)
      const connectedSockets: CustomWs[] = [];
      const hostWs = await connectWs(hostToken, roomCode);
      connectedSockets.push(hostWs);
      const hostInitState = await waitForWsMessage(hostWs, "ROOM_STATE");
      expect(hostInitState.isHost).toBe(true);

      for (let i = 2; i <= 20; i++) {
        const token = createToken(`user_slot_${i}`, `Viewer_${i}`);
        const ws = await connectWs(token, roomCode);
        connectedSockets.push(ws);
        const state = await waitForWsMessage(ws, "ROOM_STATE");
        expect(state.type).toBe("ROOM_STATE");
      }

      // Verify room has exactly 20 participants
      const room = roomManager.getRoom(roomCode);
      expect(room).toBeDefined();
      expect(room!.participants.size).toBe(20);

      // Verify REST API confirms full capacity
      const restCheck = await fetch(`${baseUrl}/api/rooms/${roomCode}`, {
        headers: { Authorization: `Bearer ${hostToken}` },
      });
      const restData = await restCheck.json();
      expect(restData.participantCount).toBe(20);
      expect(restData.isFull).toBe(true);

      // 2. Connect 21st user -> MUST be rejected with ROOM_FULL and closed with code 4003
      const token21 = createToken("user_slot_21", "Viewer_21");
      const ws21 = await connectWs(token21, roomCode);

      const [errorMsg, closeEvent] = await Promise.all([
        waitForWsMessage(ws21, "ERROR"),
        new Promise<{ code: number; reason: string }>((resolve) => {
          ws21.on("close", (code, reason) => {
            resolve({ code, reason: reason.toString() });
          });
        }),
      ]);

      expect(errorMsg.code).toBe("ROOM_FULL");
      expect(errorMsg.message).toContain("20");
      expect(closeEvent.code).toBe(4003);
      expect(closeEvent.reason).toBe("ROOM_FULL");

      // Verify room is still capped at 20
      expect(roomManager.getRoom(roomCode)!.participants.size).toBe(20);

      // 3. Disconnect 1 participant (e.g. participant 20)
      const leavingWs = connectedSockets.pop()!;
      await new Promise<void>((resolve) => {
        leavingWs.on("close", () => resolve());
        leavingWs.close();
      });

      // Allow close handler to run on server
      await new Promise((r) => setTimeout(r, 60));
      expect(roomManager.getRoom(roomCode)!.participants.size).toBe(19);

      // 4. Now 21st user can join successfully!
      const ws21Retry = await connectWs(token21, roomCode);
      const state21 = await waitForWsMessage(ws21Retry, "ROOM_STATE");
      expect(state21.type).toBe("ROOM_STATE");
      expect(state21.room.participantCount).toBe(20);
      expect(roomManager.getRoom(roomCode)!.participants.size).toBe(20);

      // 5. Connect 22nd user -> should be rejected again
      const token22 = createToken("user_slot_22", "Viewer_22");
      const ws22 = await connectWs(token22, roomCode);
      const errorMsg22 = await waitForWsMessage(ws22, "ERROR");
      expect(errorMsg22.code).toBe("ROOM_FULL");
    });
  });

  // =========================================================================
  // CHALLENGE 2: 10 MSG/SEC RATE LIMITER
  // =========================================================================
  describe("Challenge 2: 10 msg/sec Rate Limiter", () => {
    it("sends 15 messages in <500ms -> receives RATE_LIMITED error code and unblocks after window reset", async () => {
      const hostToken = createToken("host_rate_limiter", "RateHost");
      const viewerToken = createToken("viewer_rate_limiter", "RateSpammer");

      const createRes = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({ media: { title: "Rate Movie", kind: "movie" } }),
      });
      const { roomCode } = await createRes.json();

      const hostWs = await connectWs(hostToken, roomCode);
      const spammerWs = await connectWs(viewerToken, roomCode);

      await waitForWsMessage(hostWs, "ROOM_STATE");
      await waitForWsMessage(spammerWs, "ROOM_STATE");

      // Send 15 messages in < 500ms
      const startTime = Date.now();
      for (let i = 1; i <= 15; i++) {
        spammerWs.send(JSON.stringify({ type: "CHAT", text: `Rapid message #${i}` }));
      }
      const sendDuration = Date.now() - startTime;
      expect(sendDuration).toBeLessThan(500);

      // Spammer should receive RATE_LIMITED error
      const rateError = await waitForWsMessage(spammerWs, "ERROR", (m) => m.code === "RATE_LIMITED");
      expect(rateError.code).toBe("RATE_LIMITED");
      expect(rateError.message).toContain("10");

      // Verify that innocent host connection is unaffected
      hostWs.send(JSON.stringify({ type: "CHAT", text: "Host is unaffected by spammer" }));
      const hostChatOnSpammer = await waitForWsMessage(
        spammerWs,
        "CHAT",
        (m) => m.message?.text === "Host is unaffected by spammer"
      );
      expect(hostChatOnSpammer.message.username).toBe("RateHost");

      // Wait > 1000ms for sliding window reset
      await new Promise((r) => setTimeout(r, 1100));

      // Spammer should now be unblocked and able to send a message successfully
      spammerWs.send(JSON.stringify({ type: "CHAT", text: "Unblocked after cooldown" }));
      const unblockedChat = await waitForWsMessage(
        hostWs,
        "CHAT",
        (m) => m.message?.text === "Unblocked after cooldown"
      );
      expect(unblockedChat.message.text).toBe("Unblocked after cooldown");
    });
  });

  // =========================================================================
  // CHALLENGE 3: HOST MIGRATION & PROMOTION HIERARCHY
  // =========================================================================
  describe("Challenge 3: Host Migration & Succession Hierarchy", () => {
    it("promotes oldest remaining participant on host disconnect and broadcasts HOST_CHANGED", async () => {
      const tokenHost = createToken("alice_host", "Alice");
      const tokenBob = createToken("bob_oldest", "Bob");
      const tokenCharlie = createToken("charlie_newest", "Charlie");

      const createRes = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenHost}` },
        body: JSON.stringify({ media: { title: "Succession", kind: "series" } }),
      });
      const { roomCode } = await createRes.json();

      // Alice joins first (host)
      const aliceWs = await connectWs(tokenHost, roomCode);
      await waitForWsMessage(aliceWs, "ROOM_STATE");

      // Bob joins at t1
      await new Promise((r) => setTimeout(r, 20));
      const bobWs = await connectWs(tokenBob, roomCode);
      await waitForWsMessage(bobWs, "ROOM_STATE");

      // Charlie joins at t2 (t2 > t1)
      await new Promise((r) => setTimeout(r, 20));
      const charlieWs = await connectWs(tokenCharlie, roomCode);
      await waitForWsMessage(charlieWs, "ROOM_STATE");

      // Alice (Host) disconnects
      aliceWs.close();

      // Bob and Charlie should both receive HOST_CHANGED with hostId = bob_oldest
      const [bobHostNotice, charlieHostNotice] = await Promise.all([
        waitForWsMessage(bobWs, "HOST_CHANGED"),
        waitForWsMessage(charlieWs, "HOST_CHANGED"),
      ]);

      expect(bobHostNotice.hostId).toBe("bob_oldest");
      expect(bobHostNotice.hostUsername).toBe("Bob");
      expect(charlieHostNotice.hostId).toBe("bob_oldest");
      expect(charlieHostNotice.hostUsername).toBe("Bob");

      // Verify room state now lists Bob as host
      const room = roomManager.getRoom(roomCode)!;
      expect(room.hostId).toBe("bob_oldest");
      expect(room.hostUsername).toBe("Bob");

      // Promoted Bob can now issue playback commands (PLAY & SEEK)
      bobWs.send(JSON.stringify({ type: "PLAY", currentTime: 45.0 }));
      const playNoticeOnCharlie = await waitForWsMessage(charlieWs, "PLAY");
      expect(playNoticeOnCharlie.currentTime).toBe(45.0);

      bobWs.send(JSON.stringify({ type: "SEEK", currentTime: 120.0 }));
      const seekNoticeOnCharlie = await waitForWsMessage(charlieWs, "SEEK");
      expect(seekNoticeOnCharlie.currentTime).toBe(120.0);

      // Multi-hop test: Bob disconnects -> Charlie should become host!
      bobWs.close();
      const charliePromotedNotice = await waitForWsMessage(charlieWs, "HOST_CHANGED");
      expect(charliePromotedNotice.hostId).toBe("charlie_newest");
      expect(roomManager.getRoom(roomCode)!.hostId).toBe("charlie_newest");

      // Charlie can now issue playback commands
      charlieWs.send(JSON.stringify({ type: "PAUSE", currentTime: 120.0 }));
      const pauseNotice = await waitForWsMessage(charlieWs, "PAUSE");
      expect(pauseNotice.currentTime).toBe(120.0);
      expect(roomManager.getRoom(roomCode)!.timeline.isPlaying).toBe(false);
    });


    it("former host rejoining does not usurp host role from newly promoted host", async () => {
      const tokenAlice = createToken("alice_former", "Alice");
      const tokenBob = createToken("bob_current", "Bob");

      const createRes = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAlice}` },
        body: JSON.stringify({ media: { title: "The Crown", kind: "series" } }),
      });
      const { roomCode } = await createRes.json();

      const aliceWs = await connectWs(tokenAlice, roomCode);
      await waitForWsMessage(aliceWs, "ROOM_STATE");

      const bobWs = await connectWs(tokenBob, roomCode);
      await waitForWsMessage(bobWs, "ROOM_STATE");

      // Alice disconnects -> Bob promoted
      aliceWs.close();
      await waitForWsMessage(bobWs, "HOST_CHANGED");
      expect(roomManager.getRoom(roomCode)!.hostId).toBe("bob_current");

      // Alice rejoins
      const aliceRejoinedWs = await connectWs(tokenAlice, roomCode);
      const aliceRejoinedState = await waitForWsMessage(aliceRejoinedWs, "ROOM_STATE");

      // Alice MUST be a viewer (isHost = false)
      expect(aliceRejoinedState.isHost).toBe(false);
      expect(roomManager.getRoom(roomCode)!.hostId).toBe("bob_current");

      // If Alice attempts PLAY, she is rejected
      aliceRejoinedWs.send(JSON.stringify({ type: "PLAY", currentTime: 10.0 }));
      const unauthError = await waitForWsMessage(aliceRejoinedWs, "ERROR");
      expect(unauthError.code).toBe("UNAUTHORIZED_HOST_ONLY");
    });
  });

  // =========================================================================
  // CHALLENGE 4: HOST-ONLY CONTROLS RESTRICTIONS
  // =========================================================================
  describe("Challenge 4: Host-Only Playback Controls Restrictions", () => {
    it("rejects non-host attempts for PLAY, SEEK, PAUSE, SPEED, CHANGE_MEDIA with UNAUTHORIZED_HOST_ONLY", async () => {
      const hostToken = createToken("host_controls", "HostDave");
      const viewerToken = createToken("viewer_controls", "ViewerEve");

      const createRes = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({ media: { title: "Matrix", kind: "movie" } }),
      });
      const { roomCode } = await createRes.json();

      const hostWs = await connectWs(hostToken, roomCode);
      const viewerWs = await connectWs(viewerToken, roomCode);

      await waitForWsMessage(hostWs, "ROOM_STATE");
      await waitForWsMessage(viewerWs, "ROOM_STATE");

      // 1. Viewer attempts PLAY
      viewerWs.send(JSON.stringify({ type: "PLAY", currentTime: 10.0 }));
      const playErr = await waitForWsMessage(viewerWs, "ERROR");
      expect(playErr.code).toBe("UNAUTHORIZED_HOST_ONLY");
      expect(playErr.message).toContain("anfitrión");

      // 2. Viewer attempts SEEK
      viewerWs.send(JSON.stringify({ type: "SEEK", currentTime: 99.0 }));
      const seekErr = await waitForWsMessage(viewerWs, "ERROR");
      expect(seekErr.code).toBe("UNAUTHORIZED_HOST_ONLY");

      // 3. Viewer attempts PAUSE
      viewerWs.send(JSON.stringify({ type: "PAUSE", currentTime: 10.0 }));
      const pauseErr = await waitForWsMessage(viewerWs, "ERROR");
      expect(pauseErr.code).toBe("UNAUTHORIZED_HOST_ONLY");

      // 4. Viewer attempts SPEED
      viewerWs.send(JSON.stringify({ type: "SPEED", playbackRate: 2.0 }));
      const speedErr = await waitForWsMessage(viewerWs, "ERROR");
      expect(speedErr.code).toBe("UNAUTHORIZED_HOST_ONLY");

      // 5. Viewer attempts CHANGE_MEDIA
      viewerWs.send(JSON.stringify({ type: "CHANGE_MEDIA", media: { title: "Hacked", kind: "movie" } }));
      const mediaErr = await waitForWsMessage(viewerWs, "ERROR");
      expect(mediaErr.code).toBe("UNAUTHORIZED_HOST_ONLY");

      // 6. Viewer sends permitted CHAT -> should succeed and broadcast to host
      viewerWs.send(JSON.stringify({ type: "CHAT", text: "Hello room!" }));
      const chatOnHost = await waitForWsMessage(hostWs, "CHAT");
      expect(chatOnHost.message.text).toBe("Hello room!");
      expect(chatOnHost.message.username).toBe("ViewerEve");

      // 7. Viewer sends permitted SYNC_CHECK -> should succeed and return timeline state
      viewerWs.send(JSON.stringify({ type: "SYNC_CHECK", currentTime: 0 }));
      const syncResp = await waitForWsMessage(viewerWs, "SYNC_CHECK");
      expect(syncResp.type).toBe("SYNC_CHECK");
      expect(typeof syncResp.drift).toBe("number");

      // Verify that unauthorized attempts caused NO mutations to the room timeline
      const room = roomManager.getRoom(roomCode)!;
      expect(room.timeline.isPlaying).toBe(false);
      expect(room.timeline.currentTime).toBe(0);
      expect(room.timeline.playbackRate).toBe(1.0);
      expect(room.media.title).toBe("Matrix");
    });
  });

  // =========================================================================
  // CHALLENGE 5: ADVERSARIAL STRESS & RACE CONDITIONS
  // =========================================================================
  describe("Challenge 5: Adversarial Boundary & Stress Testing", () => {
    it("boundary test for rate limiter: exactly 10 messages pass, 11th is rejected; two concurrent connections have isolated limits", async () => {
      const hostToken = createToken("host_adv_rate", "AdvHost");
      const client1Token = createToken("client1_adv_rate", "Client1");
      const client2Token = createToken("client2_adv_rate", "Client2");

      const createRes = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({ media: { title: "Boundary Movie", kind: "movie" } }),
      });
      const { roomCode } = await createRes.json();

      const hostWs = await connectWs(hostToken, roomCode);
      const c1Ws = await connectWs(client1Token, roomCode);
      const c2Ws = await connectWs(client2Token, roomCode);

      await waitForWsMessage(hostWs, "ROOM_STATE");
      await waitForWsMessage(c1Ws, "ROOM_STATE");
      await waitForWsMessage(c2Ws, "ROOM_STATE");

      // Send exactly 10 messages from client 1
      for (let i = 1; i <= 10; i++) {
        c1Ws.send(JSON.stringify({ type: "CHAT", text: `Boundary #${i}` }));
      }

      // Collect all 10 on host
      for (let i = 1; i <= 10; i++) {
        await waitForWsMessage(hostWs, "CHAT", (m) => m.message?.text === `Boundary #${i}`);
      }

      // 11th message from client 1 MUST trigger RATE_LIMITED
      c1Ws.send(JSON.stringify({ type: "CHAT", text: "Boundary #11" }));
      const rateLimitErr = await waitForWsMessage(c1Ws, "ERROR");
      expect(rateLimitErr.code).toBe("RATE_LIMITED");

      // Client 2 sends 8 messages simultaneously -> ALL MUST pass because limit is per connection
      for (let i = 1; i <= 8; i++) {
        c2Ws.send(JSON.stringify({ type: "CHAT", text: `Client2 Msg #${i}` }));
      }
      for (let i = 1; i <= 8; i++) {
        await waitForWsMessage(hostWs, "CHAT", (m) => m.message?.text === `Client2 Msg #${i}`);
      }
    });

    it("cascade 4-tier host migration: Alice -> Bob -> Charlie -> Dave -> Room Empty GC", async () => {
      const u1 = createToken("u1_alice", "Alice");
      const u2 = createToken("u2_bob", "Bob");
      const u3 = createToken("u3_charlie", "Charlie");
      const u4 = createToken("u4_dave", "Dave");

      const createRes = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${u1}` },
        body: JSON.stringify({ media: { title: "Cascade Test", kind: "series" } }),
      });
      const { roomCode } = await createRes.json();

      const ws1 = await connectWs(u1, roomCode);
      await waitForWsMessage(ws1, "ROOM_STATE");

      await new Promise((r) => setTimeout(r, 15));
      const ws2 = await connectWs(u2, roomCode);
      await waitForWsMessage(ws2, "ROOM_STATE");

      await new Promise((r) => setTimeout(r, 15));
      const ws3 = await connectWs(u3, roomCode);
      await waitForWsMessage(ws3, "ROOM_STATE");

      await new Promise((r) => setTimeout(r, 15));
      const ws4 = await connectWs(u4, roomCode);
      await waitForWsMessage(ws4, "ROOM_STATE");

      // Step 1: Alice disconnects -> Bob promoted
      ws1.close();
      const [b1, bNoticeOnCharlie, bNoticeOnDave] = await Promise.all([
        waitForWsMessage(ws2, "HOST_CHANGED"),
        waitForWsMessage(ws3, "HOST_CHANGED"),
        waitForWsMessage(ws4, "HOST_CHANGED"),
      ]);
      expect(b1.hostId).toBe("u2_bob");
      expect(bNoticeOnCharlie.hostId).toBe("u2_bob");
      expect(bNoticeOnDave.hostId).toBe("u2_bob");
      expect(roomManager.getRoom(roomCode)!.hostId).toBe("u2_bob");

      // Step 2: Bob disconnects -> Charlie promoted
      ws2.close();
      const [c1, cNoticeOnDave] = await Promise.all([
        waitForWsMessage(ws3, "HOST_CHANGED"),
        waitForWsMessage(ws4, "HOST_CHANGED"),
      ]);
      expect(c1.hostId).toBe("u3_charlie");
      expect(cNoticeOnDave.hostId).toBe("u3_charlie");
      expect(roomManager.getRoom(roomCode)!.hostId).toBe("u3_charlie");

      // Step 3: Charlie disconnects -> Dave promoted
      ws3.close();
      const d1 = await waitForWsMessage(ws4, "HOST_CHANGED");
      expect(d1.hostId).toBe("u4_dave");
      expect(roomManager.getRoom(roomCode)!.hostId).toBe("u4_dave");

      // Step 4: Dave (sole remaining) disconnects -> room empty, GC active
      ws4.close();
      await new Promise((r) => setTimeout(r, 60));
      const emptyRoom = roomManager.getRoom(roomCode);
      expect(emptyRoom).toBeDefined();
      expect(emptyRoom!.participants.size).toBe(0);
      expect(emptyRoom!.emptyTimer).toBeDefined();
    });


    it("burst connection race for last available slot enforces max 20 capacity strictly", async () => {
      const hostToken = createToken("burst_host", "BurstHost");
      const createRes = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({ media: { title: "Burst Race", kind: "movie" } }),
      });
      const { roomCode } = await createRes.json();

      // Connect 19 participants (1 host + 18 viewers)
      const existing: CustomWs[] = [];
      const hWs = await connectWs(hostToken, roomCode);
      existing.push(hWs);
      await waitForWsMessage(hWs, "ROOM_STATE");

      for (let i = 2; i <= 19; i++) {
        const ws = await connectWs(createToken(`burst_u_${i}`, `BViewer_${i}`), roomCode);
        existing.push(ws);
        await waitForWsMessage(ws, "ROOM_STATE");
      }

      expect(roomManager.getRoom(roomCode)!.participants.size).toBe(19);

      // Now 4 candidates simultaneously attempt to connect to take the 20th slot
      const candidateTokens = [
        createToken("candidate_1", "Cand1"),
        createToken("candidate_2", "Cand2"),
        createToken("candidate_3", "Cand3"),
        createToken("candidate_4", "Cand4"),
      ];

      const candidateSockets = await Promise.all(
        candidateTokens.map((t) => connectWs(t, roomCode))
      );

      // Wait for all candidates to receive either ROOM_STATE or ERROR
      let acceptedCount = 0;
      let rejectedCount = 0;

      for (const cWs of candidateSockets) {
        const msg = await Promise.race([
          waitForWsMessage(cWs, "ROOM_STATE", undefined, 1000).then((m) => ({ type: "ROOM_STATE", m })),
          waitForWsMessage(cWs, "ERROR", undefined, 1000).then((m) => ({ type: "ERROR", m })),
        ]);

        if (msg.type === "ROOM_STATE") {
          acceptedCount++;
        } else if (msg.type === "ERROR" && (msg.m as any).code === "ROOM_FULL") {
          rejectedCount++;
        }
      }

      // Exactly 1 must be accepted and 3 must be rejected
      expect(acceptedCount).toBe(1);
      expect(rejectedCount).toBe(3);
      expect(roomManager.getRoom(roomCode)!.participants.size).toBe(20);

      // Cleanup
      existing.forEach((w) => w.close());
      candidateSockets.forEach((w) => w.close());
    });
  });
});

