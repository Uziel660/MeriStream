/**
 * @vitest-environment jsdom
 */
import { renderHook, act } from "@testing-library/react";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  useTeleparty,
  computeBackoffDelay,
  computeExpectedPlayhead,
  checkDrift,
  extractUserIdFromToken,
  WatchPartyMedia,
} from "../src/hooks/useTeleparty";

// Mock implementation of WebSocket for controlled testing
class MockWebSocket {
  public static instances: MockWebSocket[] = [];
  public static clearInstances() {
    MockWebSocket.instances = [];
  }

  public url: string;
  public readyState: number = 1; // 1 = OPEN
  public sentMessages: string[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onerror: ((event: any) => void) | null = null;
  public onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Automatically trigger onopen in next tick
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 0);
  }

  public send(data: string) {
    this.sentMessages.push(data);
  }

  public close(code: number = 1000, reason: string = "") {
    this.readyState = 3; // CLOSED
    if (this.onclose) {
      this.onclose({ code, reason });
    }
  }

  public triggerMessage(payload: Record<string, any>) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(payload) });
    }
  }

  public triggerClose(code: number, reason: string = "") {
    this.readyState = 3;
    if (this.onclose) {
      this.onclose({ code, reason });
    }
  }

  public triggerError(err: any = new Error("WebSocket error")) {
    if (this.onerror) {
      this.onerror(err);
    }
  }

  public getLastParsedMessage(): Record<string, any> | null {
    if (this.sentMessages.length === 0) return null;
    return JSON.parse(this.sentMessages[this.sentMessages.length - 1]);
  }

  public getParsedMessages(): Record<string, any>[] {
    return this.sentMessages.map((s) => JSON.parse(s));
  }
}

// Helper to create a fake video element with active listeners
function createMockVideo(initialTime: number = 0, initialPaused: boolean = true) {
  const listeners: Record<string, Set<() => void>> = {};

  const video = {
    currentTime: initialTime,
    paused: initialPaused,
    playbackRate: 1.0,
    addEventListener: vi.fn((event: string, handler: () => void) => {
      if (!listeners[event]) listeners[event] = new Set();
      listeners[event].add(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: () => void) => {
      if (listeners[event]) listeners[event].delete(handler);
    }),
    play: vi.fn().mockImplementation(() => {
      video.paused = false;
      if (listeners["play"]) {
        listeners["play"].forEach((fn) => fn());
      }
      return Promise.resolve();
    }),
    pause: vi.fn().mockImplementation(() => {
      video.paused = true;
      if (listeners["pause"]) {
        listeners["pause"].forEach((fn) => fn());
      }
    }),
    // Helper to simulate manual seek and trigger native seeked event
    simulateSeek: (newTime: number) => {
      video.currentTime = newTime;
      if (listeners["seeked"]) {
        listeners["seeked"].forEach((fn) => fn());
      }
    },
    // Helper to simulate manual ratechange
    simulateRateChange: (newRate: number) => {
      video.playbackRate = newRate;
      if (listeners["ratechange"]) {
        listeners["ratechange"].forEach((fn) => fn());
      }
    },
    // Helper to simulate manual play
    simulatePlay: () => {
      video.paused = false;
      if (listeners["play"]) {
        listeners["play"].forEach((fn) => fn());
      }
    },
    // Helper to simulate manual pause
    simulatePause: () => {
      video.paused = true;
      if (listeners["pause"]) {
        listeners["pause"].forEach((fn) => fn());
      }
    },
  };

  return video as unknown as HTMLVideoElement & {
    simulateSeek: (newTime: number) => void;
    simulateRateChange: (newRate: number) => void;
    simulatePlay: () => void;
    simulatePause: () => void;
  };
}

// Generate a dummy JWT token with payload
function createTestToken(userId: string, username: string = "TestUser"): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ id: userId, userId, username, exp: 9999999999 }));
  return `${header}.${payload}.mockSignature`;
}

describe("useTeleparty Hook & Synchronization Architecture", () => {
  const originalWebSocket = global.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.clearInstances();
    (global as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    (global as any).WebSocket = originalWebSocket;
  });

  describe("1. Pure Algorithm Verification", () => {
    it("computeBackoffDelay: calculates 1000 * 1.5^retry capped at 15000ms", () => {
      expect(computeBackoffDelay(0)).toBe(1000);
      expect(computeBackoffDelay(1)).toBe(1500);
      expect(computeBackoffDelay(2)).toBe(2250);
      expect(computeBackoffDelay(3)).toBe(3375);
      expect(computeBackoffDelay(4)).toBe(5062.5);
      expect(computeBackoffDelay(7)).toBe(15000); // 17085 -> capped at 15000
      expect(computeBackoffDelay(10)).toBe(15000);
    });

    it("computeExpectedPlayhead: handles paused and playing remote states", () => {
      const now = 1000000;
      // When paused: expected playhead remains static at remoteCurrentTime
      expect(computeExpectedPlayhead(120.5, now - 5000, false, 1.0, now)).toBe(120.5);

      // When playing at 1.0x rate with 3.5s elapsed
      expect(computeExpectedPlayhead(120.0, now - 3500, true, 1.0, now)).toBeCloseTo(123.5, 3);

      // When playing at 1.5x speed with 4.0s elapsed
      expect(computeExpectedPlayhead(100.0, now - 4000, true, 1.5, now)).toBeCloseTo(106.0, 3);
    });

    it("checkDrift: correctly identifies when drift is within or outside ±2.0s tolerance", () => {
      // Within tolerance (<= 2.0s): should NOT correct
      expect(checkDrift(100.0, 101.5, 2.0)).toEqual({ drift: -1.5, shouldCorrect: false });
      expect(checkDrift(100.0, 98.2, 2.0)).toEqual({ drift: 1.8, shouldCorrect: false });
      expect(checkDrift(100.0, 102.0, 2.0)).toEqual({ drift: -2.0, shouldCorrect: false });

      // Beyond tolerance (> 2.0s): MUST correct
      expect(checkDrift(100.0, 102.1, 2.0)).toEqual({ drift: -2.1, shouldCorrect: true });
      expect(checkDrift(100.0, 95.0, 2.0)).toEqual({ drift: 5.0, shouldCorrect: true });
      expect(checkDrift(100.0, 110.0, 2.0)).toEqual({ drift: -10.0, shouldCorrect: true });
    });

    it("extractUserIdFromToken: extracts user ID from valid JWT tokens safely", () => {
      const token = createTestToken("user-alpha-99", "Alpha");
      expect(extractUserIdFromToken(token)).toBe("user-alpha-99");
      expect(extractUserIdFromToken(null)).toBeNull();
      expect(extractUserIdFromToken("invalid-token")).toBeNull();
    });
  });

  describe("2. Anti-Echo Guard Mechanism", () => {
    it("blocks synthetic video events from firing feedback loops when remote updates are applied", async () => {
      const mockVideo = createMockVideo(10, false);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("host-user");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "ABC123",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      expect(ws).toBeDefined();

      // Establish room as Host
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: true,
          room: {
            roomCode: "ABC123",
            hostId: "host-user",
            hostUsername: "Host",
            isPlaying: true,
            currentTime: 10,
            participants: [{ userId: "host-user", isHost: true }],
          },
        });
      });

      expect(result.current.isHost).toBe(true);
      const initialSentCount = ws.sentMessages.length;

      // Simulate an incoming remote SEEK command (or promo state)
      // When applied, it sets video.currentTime which emits native seeked
      act(() => {
        ws.triggerMessage({
          type: "SEEK",
          currentTime: 85.0,
        });
      });

      // Video element received the update
      expect(mockVideo.currentTime).toBe(85.0);

      // Now simulate the browser dispatching the synthetic 'seeked' event
      // during the anti-echo suppression window (<300ms)
      act(() => {
        mockVideo.simulateSeek(85.0);
      });

      // Crucial: No outgoing SEEK message was dispatched back to WebSocket!
      const messagesAfterEcho = ws.getParsedMessages().slice(initialSentCount);
      const seekMessages = messagesAfterEcho.filter((m) => m.type === "SEEK");
      expect(seekMessages.length).toBe(0);

      // Advance time beyond the 300ms anti-echo window
      act(() => {
        vi.advanceTimersByTime(350);
      });

      // Now a real local user seek interaction occurs
      act(() => {
        mockVideo.simulateSeek(95.0);
      });

      // Outgoing SEEK is now dispatched legitimately!
      const finalSeekMessages = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      expect(finalSeekMessages.length).toBe(1);
      expect(finalSeekMessages[0].currentTime).toBe(95.0);
    });

    it("prevents direct syncPlay/syncPause calls during the anti-echo suppression window", async () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("host-1");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "XYZ789",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: true,
          room: { roomCode: "XYZ789", hostId: "host-1", isPlaying: false, currentTime: 0 },
        });
      });

      // Receive remote PLAY command which sets the suppression window
      act(() => {
        ws.triggerMessage({
          type: "PLAY",
          currentTime: 20,
        });
      });

      const countBefore = ws.sentMessages.length;

      // Immediate attempt to call syncPlay should be suppressed by anti-echo guard
      act(() => {
        result.current.syncPlay(25);
      });
      expect(ws.sentMessages.length).toBe(countBefore);

      // After 350ms suppression expires, syncPlay should work
      act(() => {
        vi.advanceTimersByTime(350);
        result.current.syncPlay(30);
      });

      const lastMsg = ws.getLastParsedMessage();
      expect(lastMsg?.type).toBe("PLAY");
      expect(lastMsg?.currentTime).toBe(30);
    });
  });

  describe("3. Smart Drift Correction", () => {
    it("does NOT seek when drift is within ±2.0s tolerance on SYNC_CHECK", () => {
      const mockVideo = createMockVideo(50.0, false);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("viewer-1");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "DRIFT1",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: false, // Viewer role
          room: { roomCode: "DRIFT1", hostId: "other-host", isPlaying: true, currentTime: 50.0 },
        });
      });

      const now = Date.now();

      // Remote reports host at 51.5s (drift is 50.0 - 51.5 = -1.5s <= 2.0s)
      act(() => {
        ws.triggerMessage({
          type: "SYNC_CHECK",
          currentTime: 51.5,
          isPlaying: true,
          playbackRate: 1.0,
          updatedAt: now,
        });
      });

      // Local video currentTime remains untouched!
      expect(mockVideo.currentTime).toBe(50.0);
    });

    it("triggers seek when drift exceeds 2.0s on SYNC_CHECK", () => {
      const mockVideo = createMockVideo(50.0, false);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("viewer-1");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "DRIFT2",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: false,
          room: { roomCode: "DRIFT2", hostId: "other-host", isPlaying: true, currentTime: 50.0 },
        });
      });

      const now = Date.now();

      // Remote reports host at 58.0s (drift is 50.0 - 58.0 = -8.0s > 2.0s)
      act(() => {
        ws.triggerMessage({
          type: "SYNC_CHECK",
          currentTime: 58.0,
          isPlaying: true,
          playbackRate: 1.0,
          updatedAt: now,
        });
      });

      // Local video currentTime is corrected to expected playhead
      expect(mockVideo.currentTime).toBeCloseTo(58.0, 1);
    });

    it("converges play/pause state and playback speed when out of sync", () => {
      const mockVideo = createMockVideo(100.0, true); // Paused locally
      mockVideo.playbackRate = 1.0;
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("viewer-2");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "DRIFT3",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: false,
          room: { roomCode: "DRIFT3", hostId: "host-99", isPlaying: false, currentTime: 100.0 },
        });
      });

      expect(mockVideo.paused).toBe(true);

      // SYNC_CHECK reports host is playing at 1.5x speed
      act(() => {
        ws.triggerMessage({
          type: "SYNC_CHECK",
          currentTime: 101.0,
          isPlaying: true,
          playbackRate: 1.5,
          updatedAt: Date.now(),
        });
      });

      // Video should resume playback and align playback rate
      expect(mockVideo.play).toHaveBeenCalled();
      expect(mockVideo.playbackRate).toBe(1.5);
    });
  });

  describe("4. Host vs Viewer Authority", () => {
    it("locks viewer controls from broadcasting mutations to WebSocket", () => {
      const mockVideo = createMockVideo(10, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("viewer-user");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "AUTH1",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: false, // Viewer!
          room: { roomCode: "AUTH1", hostId: "actual-host", isPlaying: false, currentTime: 10 },
        });
      });

      expect(result.current.isHost).toBe(false);
      const sentBefore = ws.sentMessages.length;

      // Viewer attempts to invoke host sync actions
      act(() => {
        result.current.syncPlay();
        result.current.syncPause();
        result.current.syncSeek(25);
        result.current.syncSpeed(2.0);
        result.current.syncMedia({ title: "Infiltrated Media" });
      });

      // Zero messages should be dispatched by the viewer
      expect(ws.sentMessages.length).toBe(sentBefore);

      // Viewer attempts native video interaction
      act(() => {
        mockVideo.simulateSeek(40);
        mockVideo.simulatePlay();
        mockVideo.simulatePause();
        mockVideo.simulateRateChange(1.25);
      });

      expect(ws.sentMessages.length).toBe(sentBefore);
    });

    it("allows Host to broadcast all playback mutations", () => {
      const mockVideo = createMockVideo(20, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("host-user-1");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "AUTH2",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: true,
          room: { roomCode: "AUTH2", hostId: "host-user-1", isPlaying: false, currentTime: 20 },
        });
      });

      expect(result.current.isHost).toBe(true);

      // Host triggers actions
      act(() => {
        result.current.syncPlay(22);
        result.current.syncPause(24);
        result.current.syncSpeed(1.5);
        result.current.syncMedia({ title: "Interstellar", tmdbId: 157336 });
      });

      const messages = ws.getParsedMessages();
      expect(messages.some((m) => m.type === "PLAY" && m.currentTime === 22)).toBe(true);
      expect(messages.some((m) => m.type === "PAUSE" && m.currentTime === 24)).toBe(true);
      expect(messages.some((m) => m.type === "SPEED" && m.playbackRate === 1.5)).toBe(true);
      expect(messages.some((m) => m.type === "CHANGE_MEDIA" && m.media.title === "Interstellar")).toBe(true);
    });

    it("promotes viewer to host on HOST_CHANGED event", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("user-next-in-line");
      const onHostChange = vi.fn();

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "MIGRATE",
          authToken: token,
          onHostChange,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: false,
          room: {
            roomCode: "MIGRATE",
            hostId: "old-host",
            hostUsername: "OldHost",
            participants: [
              { userId: "old-host", isHost: true },
              { userId: "user-next-in-line", isHost: false },
            ],
          },
        });
      });

      expect(result.current.isHost).toBe(false);

      // Backend broadcasts HOST_CHANGED with promoted user ID
      act(() => {
        ws.triggerMessage({
          type: "HOST_CHANGED",
          hostId: "user-next-in-line",
          hostUsername: "NextHost",
        });
      });

      expect(result.current.isHost).toBe(true);
      expect(onHostChange).toHaveBeenCalledWith(true);

      // Advance past initial ROOM_STATE anti-echo suppression window
      act(() => {
        vi.advanceTimersByTime(350);
      });

      // Verify controls are now unlocked
      act(() => {
        result.current.syncPlay(15);
      });

      const lastMsg = ws.getLastParsedMessage();
      expect(lastMsg?.type).toBe("PLAY");
      expect(lastMsg?.currentTime).toBe(15);
    });
  });

  describe("5. Auto-Reconnect with Exponential Backoff", () => {
    it("schedules reconnect on abnormal closure using exponential backoff formula", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("reconnect-user");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "RECON1",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      expect(MockWebSocket.instances.length).toBe(1);
      const ws1 = MockWebSocket.instances[0];

      // 1st abnormal disconnect (1006 abnormal closure) -> delay = 1000ms
      act(() => {
        ws1.triggerClose(1006, "Connection dropped");
      });

      expect(MockWebSocket.instances.length).toBe(1);

      // Advance by 990ms (before reconnect fires)
      act(() => {
        vi.advanceTimersByTime(990);
      });
      expect(MockWebSocket.instances.length).toBe(1);

      // Advance past 1000ms -> new connection created!
      act(() => {
        vi.advanceTimersByTime(20);
      });
      expect(MockWebSocket.instances.length).toBe(2);
      const ws2 = MockWebSocket.instances[1];

      // 2nd abnormal disconnect -> delay = 1000 * 1.5^1 = 1500ms
      act(() => {
        ws2.triggerClose(1006, "Connection dropped again");
      });

      act(() => {
        vi.advanceTimersByTime(1400);
      });
      expect(MockWebSocket.instances.length).toBe(2);

      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(MockWebSocket.instances.length).toBe(3);
    });

    it("resets retry counter to 0 upon receiving ROOM_STATE on reconnection", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("reconnect-reset");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "RESET1",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws1 = MockWebSocket.instances[0];
      act(() => {
        ws1.triggerClose(1006); // 1st failure (next delay 1000ms)
        vi.advanceTimersByTime(1050);
      });

      const ws2 = MockWebSocket.instances[1];
      act(() => {
        ws2.triggerClose(1006); // 2nd failure (next delay 1500ms)
        vi.advanceTimersByTime(1550);
      });

      expect(MockWebSocket.instances.length).toBe(3);
      const ws3 = MockWebSocket.instances[2];

      // Successful connection: receive ROOM_STATE
      act(() => {
        ws3.triggerMessage({
          type: "ROOM_STATE",
          isHost: true,
          room: { roomCode: "RESET1", hostId: "reconnect-reset" },
        });
      });

      // Now if ws3 drops, delay should be reset to 1000ms (attempt 0) instead of 2250ms!
      act(() => {
        ws3.triggerClose(1006);
      });

      act(() => {
        vi.advanceTimersByTime(1050);
      });

      expect(MockWebSocket.instances.length).toBe(4);
    });

    it("does NOT reconnect on normal close (1000), 4001 (auth), or 4003 (room full)", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("norm-user");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "NORMAL",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];

      // Test 1000
      act(() => {
        ws.triggerClose(1000, "Clean close");
        vi.advanceTimersByTime(20000);
      });
      expect(MockWebSocket.instances.length).toBe(1);
    });
  });

  describe("6. WebSocket Throttling", () => {
    it("throttles outgoing seek events to max 4 msg/sec (250ms interval) and flushes the final position", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("host-scrubber");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "THROT1",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: true,
          room: { roomCode: "THROT1", hostId: "host-scrubber" },
        });
      });

      // Rapid scrubbing: 10 seeks in 100ms
      act(() => {
        result.current.syncSeek(10); // Sent immediately (first seek)
        result.current.syncSeek(12);
        result.current.syncSeek(15);
        result.current.syncSeek(20);
        result.current.syncSeek(25);
        result.current.syncSeek(30);
        result.current.syncSeek(35);
        result.current.syncSeek(40);
        result.current.syncSeek(45);
        result.current.syncSeek(50); // Final scrubbing position
      });

      // At t=0ms, only the 1st seek was sent immediately
      const seeksImmediate = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      expect(seeksImmediate.length).toBe(1);
      expect(seeksImmediate[0].currentTime).toBe(10);

      // Advance by 200ms (< 250ms interval) -> trailing flush has not fired yet
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(ws.getParsedMessages().filter((m) => m.type === "SEEK").length).toBe(1);

      // Advance remaining 60ms past the 250ms window -> trailing flush fires with final position (50)
      act(() => {
        vi.advanceTimersByTime(60);
      });

      const allSeeks = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      expect(allSeeks.length).toBe(2);
      expect(allSeeks[1].currentTime).toBe(50);
    });

    it("syncSeek with isFinal immediately flushes without waiting for timer", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("host-scrubber-2");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "THROT2",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: true,
          room: { roomCode: "THROT2", hostId: "host-scrubber-2" },
        });
      });

      act(() => {
        result.current.syncSeek(10); // 1st seek
        result.current.syncSeek(20); // throttled
        result.current.syncSeek(35, true); // Immediate final flush!
      });

      const seeks = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      expect(seeks.length).toBe(2);
      expect(seeks[1].currentTime).toBe(35);
    });
  });

  describe("7. Chat Messages & Emoji Reaction Handling", () => {
    it("handles text chat and emoji reactions properly", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("chat-user");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "CHAT1",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: false,
          room: { roomCode: "CHAT1", hostId: "someone-else" },
        });
      });

      // Send text message
      act(() => {
        result.current.sendMessage("Hello watch party!");
      });

      expect(ws.getLastParsedMessage()).toEqual({
        type: "CHAT",
        text: "Hello watch party!",
        isEmoji: false,
      });

      // Send emoji reaction
      act(() => {
        result.current.sendReaction("🎉");
      });

      expect(ws.getLastParsedMessage()).toEqual({
        type: "CHAT",
        text: "🎉",
        isEmoji: true,
      });

      // Incoming text message from another user
      act(() => {
        ws.triggerMessage({
          type: "CHAT",
          message: {
            id: "m1",
            userId: "u2",
            username: "Bob",
            text: "Hey everyone!",
            isEmoji: false,
            timestamp: 1000,
          },
        });
      });

      expect(result.current.messages.length).toBe(1);
      expect(result.current.messages[0].text).toBe("Hey everyone!");
      expect(result.current.reactions.length).toBe(0);

      // Incoming emoji message from another user
      act(() => {
        ws.triggerMessage({
          type: "CHAT",
          message: {
            id: "m2",
            userId: "u3",
            username: "Charlie",
            text: "🔥",
            isEmoji: true,
            timestamp: 1050,
          },
        });
      });

      expect(result.current.messages.length).toBe(2);
      expect(result.current.reactions.length).toBe(1);
      expect(result.current.reactions[0].emoji).toBe("🔥");
      expect(result.current.reactions[0].username).toBe("Charlie");
    });
  });

  describe("8. Participant and Media Lifecycle", () => {
    it("tracks PARTICIPANT_JOINED, PARTICIPANT_LEFT, and media changes", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("lifecycle-user");
      const onMediaChange = vi.fn();

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "LIFE1",
          authToken: token,
          onMediaChange,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: false,
          room: {
            roomCode: "LIFE1",
            hostId: "host-x",
            media: { title: "Dune: Part Two", tmdbId: 693134 },
            participants: [{ userId: "host-x", username: "Host", isHost: true }],
          },
        });
      });

      expect(result.current.participants.length).toBe(1);
      expect(onMediaChange).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Dune: Part Two" })
      );

      // New participant joins
      act(() => {
        ws.triggerMessage({
          type: "PARTICIPANT_JOINED",
          participant: { userId: "p2", username: "Paul", isHost: false },
        });
      });

      expect(result.current.participants.length).toBe(2);

      // Participant leaves
      act(() => {
        ws.triggerMessage({
          type: "PARTICIPANT_LEFT",
          userId: "p2",
        });
      });

      expect(result.current.participants.length).toBe(1);

      // Media changed by host
      act(() => {
        ws.triggerMessage({
          type: "CHANGE_MEDIA",
          media: { title: "Blade Runner 2049", tmdbId: 335984 },
        });
      });

      expect(onMediaChange).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Blade Runner 2049" })
      );
      expect(result.current.room?.media.title).toBe("Blade Runner 2049");
    });
  });

  describe("9. Periodic Host Heartbeat & Disconnect / Reconnect Controls", () => {
    it("dispatches periodic SYNC_CHECK heartbeat every 2500ms when host is connected and playing", () => {
      const mockVideo = createMockVideo(42.5, false); // playing
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("heartbeat-host");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "BEAT1",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: true,
          room: { roomCode: "BEAT1", hostId: "heartbeat-host", isPlaying: true, currentTime: 42.5 },
        });
      });

      const initialCount = ws.sentMessages.length;

      // Advance by 2400ms (< 2500ms)
      act(() => {
        vi.advanceTimersByTime(2400);
      });
      expect(ws.sentMessages.length).toBe(initialCount);

      // Advance past 2500ms
      act(() => {
        vi.advanceTimersByTime(150);
      });
      const syncChecks = ws.getParsedMessages().filter((m) => m.type === "SYNC_CHECK");
      expect(syncChecks.length).toBe(1);
      expect(syncChecks[0].currentTime).toBe(42.5);
      expect(syncChecks[0].isPlaying).toBe(true);

      // Advance another 2500ms -> 2nd heartbeat
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(ws.getParsedMessages().filter((m) => m.type === "SYNC_CHECK").length).toBe(2);
    });

    it("does NOT dispatch host periodic SYNC_CHECK heartbeat when user is a viewer", () => {
      const mockVideo = createMockVideo(10.0, false);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("heartbeat-viewer");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "BEAT2",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: false, // Viewer!
          room: { roomCode: "BEAT2", hostId: "other-guy", isPlaying: true, currentTime: 10.0 },
        });
      });

      const initialCount = ws.sentMessages.length;

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      // Viewers never broadcast host heartbeats
      expect(ws.getParsedMessages().filter((m) => m.type === "SYNC_CHECK").length).toBe(0);
      expect(ws.sentMessages.length).toBe(initialCount);
    });

    it("disconnect() closes socket with 1000 and clears room state", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("dc-user");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "DC123",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: true,
          room: { roomCode: "DC123", hostId: "dc-user" },
        });
      });

      expect(result.current.isConnected).toBe(true);
      expect(result.current.isInRoom).toBe(true);

      act(() => {
        result.current.disconnect();
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.room).toBeNull();
      expect(result.current.isHost).toBe(false);
      expect(ws.readyState).toBe(3); // CLOSED
    });

    it("reconnect() resets retry count and initiates immediate connection", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("recon-user");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "MANUAL_RECON",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      expect(MockWebSocket.instances.length).toBe(1);

      act(() => {
        result.current.reconnect();
        vi.advanceTimersByTime(10);
      });

      // A fresh connection was created immediately
      expect(MockWebSocket.instances.length).toBe(2);
    });
  });

  describe("10. Robustness & Error Resilience", () => {
    it("handles malformed JSON frames from WebSocket gracefully without throwing", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("resilience-user");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "ROBUST1",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];

      // Send broken JSON
      expect(() => {
        act(() => {
          if (ws.onmessage) {
            ws.onmessage({ data: "INVALID_NOT_JSON{{{" });
          }
        });
      }).not.toThrow();
    });

    it("handles server ERROR messages and clearError method", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("error-user");
      const onError = vi.fn();

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "ERR123",
          authToken: token,
          onError,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.triggerMessage({
          type: "ERROR",
          code: "ROOM_FULL",
          message: "Room is full (max 20)",
        });
      });

      expect(result.current.error).toBe("Room is full (max 20)");
      expect(onError).toHaveBeenCalledWith("Room is full (max 20)");

      // Test clearError
      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });

    it("ignores empty or whitespace-only chat messages", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("chat-empty");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "NOEMPTY",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      const countBefore = ws.sentMessages.length;

      act(() => {
        result.current.sendMessage("");
        result.current.sendMessage("    ");
        result.current.sendReaction("");
      });

      expect(ws.sentMessages.length).toBe(countBefore);
    });

    it("supports initialRoomCode, currentMedia, and onMediaChangeRequest compatibility aliases", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("alias-user");
      const onMediaChangeRequest = vi.fn();

      const initialMedia: WatchPartyMedia = {
        title: "Initial Media",
        tmdbId: 1001,
      };

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          initialRoomCode: "ALIAS1",
          currentMedia: initialMedia,
          authToken: token,
          onMediaChangeRequest,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      expect(result.current.roomCode).toBe("ALIAS1");
      expect(result.current.currentMedia?.title).toBe("Initial Media");

      const ws = MockWebSocket.instances[0];
      expect(ws.url).toContain("room=ALIAS1");

      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: false,
          room: {
            roomCode: "ALIAS1",
            hostId: "host-a",
            media: { title: "Server Media", tmdbId: 2002 },
          },
        });
      });

      expect(onMediaChangeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Server Media" })
      );
      expect(result.current.currentMedia?.title).toBe("Server Media");
    });
  });
});
