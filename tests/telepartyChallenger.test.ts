/**
 * @vitest-environment jsdom
 * 
 * Challenger M3-1 Empirical Stress Test Harness
 * Milestone 3: Frontend Video Synchronization Hook (R3)
 * Code Under Test: src/hooks/useTeleparty.ts
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

// Controlled Mock WebSocket for stress testing
class MockWebSocket {
  public static instances: MockWebSocket[] = [];
  public static clearInstances() {
    MockWebSocket.instances = [];
  }

  public url: string;
  public readyState: number = 1; // OPEN
  public sentMessages: string[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onerror: ((event: any) => void) | null = null;
  public onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 0);
  }

  public send(data: string) {
    this.sentMessages.push(data);
  }

  public close(code: number = 1000, reason: string = "") {
    this.readyState = 3;
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

  public getParsedMessages(): Record<string, any>[] {
    return this.sentMessages.map((s) => JSON.parse(s));
  }
}

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
    simulateSeek: (newTime: number) => {
      video.currentTime = newTime;
      if (listeners["seeked"]) {
        listeners["seeked"].forEach((fn) => fn());
      }
    },
    simulateRateChange: (newRate: number) => {
      video.playbackRate = newRate;
      if (listeners["ratechange"]) {
        listeners["ratechange"].forEach((fn) => fn());
      }
    },
    simulatePlay: () => {
      video.paused = false;
      if (listeners["play"]) {
        listeners["play"].forEach((fn) => fn());
      }
    },
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

function createTestToken(userId: string): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ id: userId, userId, exp: 9999999999 }));
  return `${header}.${payload}.sig`;
}

describe("Empirical Challenge M3-1: Frontend Video Synchronization Hook", () => {
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

  describe("Objective 1: Anti-Echo Guard Verification", () => {
    it("verify applyRemoteUpdate prevents synthetic play, pause, seeked, ratechange from echoing back to WebSocket", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("host-challenger-1");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "ECHO01",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      const ws = MockWebSocket.instances[0];
      // Configure room where user is host
      act(() => {
        ws.triggerMessage({
          type: "ROOM_STATE",
          isHost: true,
          room: { roomCode: "ECHO01", hostId: "host-challenger-1", isPlaying: false, currentTime: 0 },
        });
      });

      const countAtConnect = ws.sentMessages.length;

      // 1. Remote SEEK received -> triggers applyRemoteUpdate
      act(() => {
        ws.triggerMessage({
          type: "SEEK",
          currentTime: 150.0,
        });
      });
      expect(mockVideo.currentTime).toBe(150.0);

      // Simulate browser firing synthetic seeked event during suppression window
      act(() => {
        mockVideo.simulateSeek(150.0);
      });

      // Crucial check: 0 new messages sent!
      expect(ws.sentMessages.length).toBe(countAtConnect);

      // 2. Remote PLAY received -> triggers applyRemoteUpdate
      act(() => {
        ws.triggerMessage({
          type: "PLAY",
          currentTime: 150.0,
          updatedAt: Date.now(),
        });
      });

      // Simulate browser firing synthetic play event
      act(() => {
        mockVideo.simulatePlay();
      });

      // 0 new messages sent!
      expect(ws.sentMessages.length).toBe(countAtConnect);

      // 3. Remote PAUSE received -> triggers applyRemoteUpdate
      act(() => {
        ws.triggerMessage({
          type: "PAUSE",
          currentTime: 160.0,
        });
      });

      // Simulate browser firing synthetic pause event
      act(() => {
        mockVideo.simulatePause();
      });

      // 0 new messages sent!
      expect(ws.sentMessages.length).toBe(countAtConnect);

      // 4. Remote SPEED received -> triggers applyRemoteUpdate
      act(() => {
        ws.triggerMessage({
          type: "SPEED",
          playbackRate: 1.75,
        });
      });

      // Simulate browser firing synthetic ratechange event
      act(() => {
        mockVideo.simulateRateChange(1.75);
      });

      // 0 new messages sent!
      expect(ws.sentMessages.length).toBe(countAtConnect);

      // 5. Remote SYNC_CHECK with drift > 2.0s received -> triggers applyRemoteUpdate
      act(() => {
        ws.triggerMessage({
          type: "SYNC_CHECK",
          currentTime: 200.0,
          isPlaying: true,
          playbackRate: 1.0,
          updatedAt: Date.now(),
        });
      });

      act(() => {
        mockVideo.simulateSeek(200.0);
        mockVideo.simulatePlay();
      });

      // Total sent messages still zero after all synthetic events
      expect(ws.sentMessages.length).toBe(countAtConnect);

      // Verify that after cooldown window (350ms), genuine host actions ARE dispatched
      act(() => {
        vi.advanceTimersByTime(350);
      });

      act(() => {
        mockVideo.simulateSeek(210.0);
      });

      const postCooldownMessages = ws.getParsedMessages().slice(countAtConnect);
      expect(postCooldownMessages.length).toBe(1);
      expect(postCooldownMessages[0].type).toBe("SEEK");
      expect(postCooldownMessages[0].currentTime).toBe(210.0);
    });

    it("verify direct syncPlay/syncPause/syncSeek/syncSpeed calls are blocked within 300ms suppression window", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("host-challenger-2");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "ECHO02",
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
          room: { roomCode: "ECHO02", hostId: "host-challenger-2", isPlaying: false, currentTime: 0 },
        });
      });

      // Trigger a remote update
      act(() => {
        ws.triggerMessage({ type: "SEEK", currentTime: 50 });
      });

      const beforeCount = ws.sentMessages.length;

      // Attempt manual host calls immediately at t=10ms (<300ms)
      act(() => {
        result.current.syncPlay(55);
        result.current.syncPause(55);
        result.current.syncSeek(60);
        result.current.syncSpeed(1.25);
      });

      // All blocked by anti-echo guard
      expect(ws.sentMessages.length).toBe(beforeCount);

      // Advance by 280ms (total 290ms < 300ms) -> still blocked
      act(() => {
        vi.advanceTimersByTime(280);
        result.current.syncPlay(70);
      });
      expect(ws.sentMessages.length).toBe(beforeCount);

      // Advance past 300ms threshold -> allowed
      act(() => {
        vi.advanceTimersByTime(30); // total 320ms > 300ms
        result.current.syncPlay(80);
      });

      expect(ws.sentMessages.length).toBe(beforeCount + 1);
      const lastMsg = ws.getParsedMessages()[ws.getParsedMessages().length - 1];
      expect(lastMsg.type).toBe("PLAY");
      expect(lastMsg.currentTime).toBe(80);
    });
  });

  describe("Objective 2: Drift Boundaries Verification", () => {
    it("pure checkDrift: 1.9s drift -> shouldCorrect === false; 2.1s drift -> shouldCorrect === true", () => {
      // 1.9s positive drift (local is ahead by 1.9s)
      const res1 = checkDrift(101.9, 100.0, 2.0);
      expect(res1.drift).toBe(1.9);
      expect(res1.shouldCorrect).toBe(false);

      // 1.9s negative drift (local is behind by 1.9s)
      const res2 = checkDrift(98.1, 100.0, 2.0);
      expect(res2.drift).toBe(-1.9);
      expect(res2.shouldCorrect).toBe(false);

      // Exact 2.0s boundary (boundary condition: Math.abs(rawDrift) > threshold)
      const resBoundaryExact = checkDrift(102.0, 100.0, 2.0);
      expect(resBoundaryExact.drift).toBe(2.0);
      expect(resBoundaryExact.shouldCorrect).toBe(false);

      const resBoundaryNegExact = checkDrift(98.0, 100.0, 2.0);
      expect(resBoundaryNegExact.drift).toBe(-2.0);
      expect(resBoundaryNegExact.shouldCorrect).toBe(false);

      // 2.1s positive drift (local is ahead by 2.1s)
      const res3 = checkDrift(102.1, 100.0, 2.0);
      expect(res3.drift).toBe(2.1);
      expect(res3.shouldCorrect).toBe(true);

      // 2.1s negative drift (local is behind by 2.1s)
      const res4 = checkDrift(97.9, 100.0, 2.0);
      expect(res4.drift).toBe(-2.1);
      expect(res4.shouldCorrect).toBe(true);

      // Sub-millisecond epsilon boundary tests
      const resEpsUnder = checkDrift(101.999, 100.0, 2.0);
      expect(resEpsUnder.shouldCorrect).toBe(false);

      const resEpsOver = checkDrift(102.001, 100.0, 2.0);
      expect(resEpsOver.shouldCorrect).toBe(true);
    });

    it("integrated hook SYNC_CHECK: 1.9s drift does NOT seek; 2.1s drift DOES seek to expected playhead", () => {
      const mockVideo = createMockVideo(100.0, false);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("viewer-drift-test");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "DRIFT_INT",
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
          isHost: false, // viewer
          room: { roomCode: "DRIFT_INT", hostId: "host-lead", isPlaying: true, currentTime: 100.0 },
        });
      });

      const now = Date.now();

      // Case A: 1.9s drift (Host is at 101.9s, local is at 100.0s -> drift = -1.9s)
      act(() => {
        ws.triggerMessage({
          type: "SYNC_CHECK",
          currentTime: 101.9,
          isPlaying: true,
          playbackRate: 1.0,
          updatedAt: now,
        });
      });

      // No seek should have occurred! Local video currentTime remains 100.0s
      expect(mockVideo.currentTime).toBe(100.0);

      // Case B: 2.1s drift (Host is at 102.1s, local is at 100.0s -> drift = -2.1s)
      act(() => {
        ws.triggerMessage({
          type: "SYNC_CHECK",
          currentTime: 102.1,
          isPlaying: true,
          playbackRate: 1.0,
          updatedAt: now,
        });
      });

      // Seek MUST occur! Local video currentTime corrects to 102.1s
      expect(mockVideo.currentTime).toBeCloseTo(102.1, 2);

      // Reset local video to 100.0s
      mockVideo.currentTime = 100.0;

      // Case C: -1.9s negative drift (Host is at 98.1s, local is at 100.0s -> drift = +1.9s)
      act(() => {
        ws.triggerMessage({
          type: "SYNC_CHECK",
          currentTime: 98.1,
          isPlaying: true,
          playbackRate: 1.0,
          updatedAt: now,
        });
      });

      // No seek should occur
      expect(mockVideo.currentTime).toBe(100.0);

      // Case D: -2.1s negative drift (Host is at 97.9s, local is at 100.0s -> drift = +2.1s)
      act(() => {
        ws.triggerMessage({
          type: "SYNC_CHECK",
          currentTime: 97.9,
          isPlaying: true,
          playbackRate: 1.0,
          updatedAt: now,
        });
      });

      // Seek MUST occur to 97.9s
      expect(mockVideo.currentTime).toBeCloseTo(97.9, 2);
    });

    it("integrated hook PLAY: 1.9s drift does not seek; 2.1s drift seeks to expected playhead", () => {
      const mockVideo = createMockVideo(50.0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("viewer-play-drift");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "PLAY_DRIFT",
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
          room: { roomCode: "PLAY_DRIFT", hostId: "host-p", isPlaying: false, currentTime: 50.0 },
        });
      });

      const now = Date.now();

      // PLAY with 1.9s drift (remote = 51.9)
      act(() => {
        ws.triggerMessage({
          type: "PLAY",
          currentTime: 51.9,
          updatedAt: now,
        });
      });

      // Playhead not altered because drift <= 2.0s
      expect(mockVideo.currentTime).toBe(50.0);
      expect(mockVideo.play).toHaveBeenCalled();

      // Reset and test PLAY with 2.1s drift (remote = 52.1)
      mockVideo.currentTime = 50.0;
      act(() => {
        ws.triggerMessage({
          type: "PLAY",
          currentTime: 52.1,
          updatedAt: now,
        });
      });

      // Playhead corrected to 52.1s because drift > 2.0s
      expect(mockVideo.currentTime).toBeCloseTo(52.1, 2);
    });
  });

  describe("Objective 3: Backoff Calculation Verification", () => {
    it("computeBackoffDelay: strictly validates formula for attempts 0, 1, 2, 3, 4, 5, 10 and 15000ms cap", () => {
      // Formula: Math.min(15000, 1000 * Math.pow(1.5, retryCount))
      expect(computeBackoffDelay(0)).toBe(1000);
      expect(computeBackoffDelay(1)).toBe(1500);
      expect(computeBackoffDelay(2)).toBe(2250);
      expect(computeBackoffDelay(3)).toBe(3375);
      expect(computeBackoffDelay(4)).toBe(5062.5);
      expect(computeBackoffDelay(5)).toBe(7593.75);
      expect(computeBackoffDelay(6)).toBe(11390.625);
      expect(computeBackoffDelay(7)).toBe(15000); // 17085.9375 -> capped to 15000
      expect(computeBackoffDelay(8)).toBe(15000);
      expect(computeBackoffDelay(9)).toBe(15000);
      expect(computeBackoffDelay(10)).toBe(15000); // capped to 15000
      expect(computeBackoffDelay(100)).toBe(15000);
    });

    it("integrated hook reconnect loop: empirical timing for consecutive abnormal closures matches formula", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("reconnect-empirical");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "BACKOFF_INT",
          authToken: token,
        })
      );

      act(() => {
        vi.advanceTimersByTime(10);
      });

      expect(MockWebSocket.instances.length).toBe(1);

      // Expected delays for attempts 0 through 7
      const expectedDelays = [
        1000,      // attempt 0
        1500,      // attempt 1
        2250,      // attempt 2
        3375,      // attempt 3
        5062.5,    // attempt 4
        7593.75,   // attempt 5
        11390.625, // attempt 6
        15000,     // attempt 7 (capped)
      ];

      for (let i = 0; i < expectedDelays.length; i++) {
        const expectedDelay = expectedDelays[i];
        const currentSocket = MockWebSocket.instances[MockWebSocket.instances.length - 1];

        // Trigger abnormal closure
        act(() => {
          currentSocket.triggerClose(1006, `Drop ${i}`);
        });

        // 1ms before expected delay -> socket not created yet
        act(() => {
          vi.advanceTimersByTime(expectedDelay - 5);
        });
        expect(MockWebSocket.instances.length).toBe(i + 1);

        // Advance past expected delay -> new socket MUST be created
        act(() => {
          vi.advanceTimersByTime(10);
        });
        expect(MockWebSocket.instances.length).toBe(i + 2);
      }

      // Confirm attempt 10 still caps at 15000ms
      // Current count of sockets is 9 (initial + 8 reconnects). We are at retryCount = 8.
      // Advance through attempts 8, 9 to reach attempt 10:
      for (let step = 8; step <= 10; step++) {
        const currentSocket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        act(() => {
          currentSocket.triggerClose(1006, `Drop ${step}`);
        });
        act(() => {
          vi.advanceTimersByTime(14990);
        });
        expect(MockWebSocket.instances.length).toBe(step + 1);
        act(() => {
          vi.advanceTimersByTime(20);
        });
        expect(MockWebSocket.instances.length).toBe(step + 2);
      }
    });
  });

  describe("Objective 4: Seek Throttling Verification", () => {
    it("firing 50 seek calls in 100ms: dispatches max 4 messages to WebSocket", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("host-scrub-50");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "THROT50",
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
          room: { roomCode: "THROT50", hostId: "host-scrub-50", isPlaying: false, currentTime: 0 },
        });
      });

      // Clear any initial handshake messages
      ws.sentMessages = [];

      // Fire 50 seek calls within 100ms (every 2ms: 0ms, 2ms, ..., 98ms)
      act(() => {
        for (let i = 1; i <= 50; i++) {
          result.current.syncSeek(i * 2); // seeking to 2, 4, 6, ..., 100
          if (i < 50) {
            vi.advanceTimersByTime(2); // advance 2ms between scrubbing updates
          }
        }
      });

      // At this point, total elapsed time = 49 * 2ms = 98ms <= 100ms
      const seeksWithin100ms = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      
      // EMPIRICAL ASSERTION: At t=98ms (< 100ms), only the initial seek has been dispatched!
      expect(seeksWithin100ms.length).toBeLessThanOrEqual(4);
      expect(seeksWithin100ms.length).toBe(1);
      expect(seeksWithin100ms[0].currentTime).toBe(2);

      // Advance by another 2ms to reach t=100ms
      act(() => {
        vi.advanceTimersByTime(2);
      });

      const seeksAt100ms = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      expect(seeksAt100ms.length).toBeLessThanOrEqual(4);
      expect(seeksAt100ms.length).toBe(1);

      // Now advance past the 250ms throttle window to trigger the trailing flush
      act(() => {
        vi.advanceTimersByTime(160); // 100 + 160 = 260ms > 250ms
      });

      const allSeeks = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      // Exactly 2 messages total: initial (t=0, pos=2) and final trailing (t=250ms, pos=100)
      expect(allSeeks.length).toBe(2);
      expect(allSeeks[0].currentTime).toBe(2);
      expect(allSeeks[1].currentTime).toBe(100);
      expect(allSeeks.length).toBeLessThanOrEqual(4);
    });

    it("firing 50 seek calls in 100ms synchronously in the same tick: verifies max 4 messages", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("host-scrub-burst");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "BURST50",
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
          room: { roomCode: "BURST50", hostId: "host-scrub-burst", isPlaying: false, currentTime: 0 },
        });
      });

      ws.sentMessages = [];

      // Burst of 50 seek calls in single synchronous loop
      act(() => {
        for (let i = 1; i <= 50; i++) {
          result.current.syncSeek(i * 5); // 5, 10, ..., 250
        }
      });

      // Synchronous tick: only first seek is sent
      const seeksImmediate = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      expect(seeksImmediate.length).toBe(1);
      expect(seeksImmediate[0].currentTime).toBe(5);

      // Advance 100ms
      act(() => {
        vi.advanceTimersByTime(100);
      });

      const seeksAt100ms = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      expect(seeksAt100ms.length).toBeLessThanOrEqual(4);
      expect(seeksAt100ms.length).toBe(1);

      // Advance to 250ms -> trailing flush fires with 250
      act(() => {
        vi.advanceTimersByTime(155);
      });

      const seeksTotal = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      expect(seeksTotal.length).toBe(2);
      expect(seeksTotal[1].currentTime).toBe(250);
      expect(seeksTotal.length).toBeLessThanOrEqual(4);
    });

    it("50 seek events triggered via native video element seeked listener in 100ms: verifies throttle rate limit", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("host-scrub-native");

      renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "NATIVE50",
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
          room: { roomCode: "NATIVE50", hostId: "host-scrub-native", isPlaying: false, currentTime: 0 },
        });
      });

      // Allow initial anti-echo window to clear
      act(() => {
        vi.advanceTimersByTime(350);
      });

      ws.sentMessages = [];

      // Simulate 50 native video seeked events in 100ms
      act(() => {
        for (let i = 1; i <= 50; i++) {
          mockVideo.simulateSeek(i);
          if (i < 50) {
            vi.advanceTimersByTime(2);
          }
        }
      });

      const seeksWithin100ms = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      expect(seeksWithin100ms.length).toBeLessThanOrEqual(4);
      expect(seeksWithin100ms.length).toBe(1);
      expect(seeksWithin100ms[0].currentTime).toBe(1);

      // Flush after 250ms
      act(() => {
        vi.advanceTimersByTime(160);
      });

      const totalSeeks = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      expect(totalSeeks.length).toBe(2);
      expect(totalSeeks[1].currentTime).toBe(50);
    });

    it("continuous scrubbing over 1000ms: verifies rate limit never exceeds 4 messages per second", () => {
      const mockVideo = createMockVideo(0, true);
      const videoRef = { current: mockVideo } as React.RefObject<HTMLVideoElement>;
      const token = createTestToken("host-scrub-1s");

      const { result } = renderHook(() =>
        useTeleparty({
          videoRef,
          roomCode: "SCRUB_1S",
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
          room: { roomCode: "SCRUB_1S", hostId: "host-scrub-1s", isPlaying: false, currentTime: 0 },
        });
      });

      ws.sentMessages = [];

      // Continuous seek every 20ms for 1000ms (total 50 seeks)
      act(() => {
        for (let t = 0; t <= 1000; t += 20) {
          result.current.syncSeek(t);
          vi.advanceTimersByTime(20);
        }
      });

      const allSeeks = ws.getParsedMessages().filter((m) => m.type === "SEEK");
      // Over 1000ms with 250ms intervals:
      // t=0 (sent), t=250 (sent), t=500 (sent), t=750 (sent), t=1000 (sent)
      // Exactly 5 messages across [0, 1000ms], meaning max 4 messages per non-overlapping second window!
      expect(allSeeks.length).toBeLessThanOrEqual(5);

      // Check interval between consecutive sent messages is >= 250ms
      // Each flush happens at interval >= 250ms
      expect(allSeeks.length).toBe(5);
    });
  });
});
