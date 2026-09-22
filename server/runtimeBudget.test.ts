import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeBudget } from "./runtimeBudget";

const MIB = 1024 * 1024;
const budgets: RuntimeBudget[] = [];

function budget(options: ConstructorParameters<typeof RuntimeBudget>[0] = {}) {
  const instance = new RuntimeBudget({
    autoStart: false,
    readMemory: () => ({ rssBytes: 100 * MIB, heapUsedBytes: 50 * MIB }),
    ...options,
  });
  budgets.push(instance);
  return instance;
}

afterEach(() => {
  budgets.splice(0).forEach((item) => item.dispose());
  vi.useRealTimers();
});

describe("RuntimeBudget", () => {
  it("classifies RSS and heap pressure using T100TA defaults", () => {
    const subject = budget();
    expect(subject.snapshot().mode).toBe("normal");
    expect(subject.sample({ rssBytes: 450 * MIB, heapUsedBytes: 50 * MIB }).mode).toBe("care");
    expect(subject.sample({ rssBytes: 600 * MIB, heapUsedBytes: 50 * MIB }).mode).toBe("saturated");
    expect(subject.sample({ rssBytes: 100 * MIB, heapUsedBytes: 384 * MIB }).mode).toBe("saturated");
  });

  it("requires sustained event-loop lag and recovers after a healthy sample", () => {
    const subject = budget({ sustainedLagSamples: 2 });
    expect(subject.recordEventLoopLag(100).mode).toBe("normal");
    expect(subject.recordEventLoopLag(100).mode).toBe("care");
    expect(subject.recordEventLoopLag(300).mode).toBe("care");
    expect(subject.recordEventLoopLag(300).mode).toBe("saturated");
    expect(subject.recordEventLoopLag(1).mode).toBe("normal");
  });

  it("uses relay leases, releases idempotently, and never terminates active work", () => {
    const subject = budget({ careRelays: 2, saturatedRelays: 3 });
    const first = subject.beginRelay();
    const second = subject.beginRelay();
    const third = subject.beginRelay();
    expect(subject.snapshot({ refreshMemory: false })).toMatchObject({
      mode: "saturated",
      activeRelays: 3,
      suggestedFallback: "embed",
    });

    // Existing leases remain valid; saturation only refuses new admissions.
    expect(subject.tryBeginRelay()).toBeNull();
    third.release();
    third.release();
    expect(subject.snapshot({ refreshMemory: false })).toMatchObject({ mode: "care", activeRelays: 2 });
    first.release();
    second.release();
    expect(subject.snapshot({ refreshMemory: false }).activeRelays).toBe(0);
  });

  it("tracks resolutions separately and guards against unmatched end calls", () => {
    const subject = budget({ careResolutions: 1, saturatedResolutions: 2 });
    const first = subject.beginResolution();
    expect(subject.snapshot({ refreshMemory: false }).mode).toBe("care");
    const second = subject.beginResolution();
    expect(subject.shouldFallback()).toBe(true);
    expect(subject.tryBeginResolution()).toBeNull();
    first.release();
    second.release();
    subject.endResolution();
    subject.endRelay();
    expect(subject.snapshot({ refreshMemory: false })).toMatchObject({
      activeRelays: 0,
      activeResolutions: 0,
      mode: "normal",
    });
  });

  it("reserva dos carriles como máximo para resoluciones interactivas bajo presión", () => {
    const subject = budget({ careResolutions: 1, saturatedResolutions: 2 });
    subject.sample({ rssBytes: 601 * MIB, heapUsedBytes: 50 * MIB });
    expect(subject.tryBeginResolution()).toBeNull();
    const firstInteractive = subject.tryBeginResolution({ interactive: true });
    const secondInteractive = subject.tryBeginResolution({ interactive: true });
    expect(firstInteractive).not.toBeNull();
    expect(secondInteractive).not.toBeNull();
    expect(subject.tryBeginResolution({ interactive: true })).toBeNull();
    firstInteractive?.release();
    secondInteractive?.release();
    expect(subject.snapshot({ refreshMemory: false }).activeResolutions).toBe(0);
  });

  it("deja margen interactivo cuando la presión proviene solo de resoluciones viejas", () => {
    const subject = budget({ careResolutions: 1, saturatedResolutions: 2 });
    subject.beginResolution();
    subject.beginResolution();
    const firstInteractive = subject.tryBeginResolution({ interactive: true });
    expect(firstInteractive).not.toBeNull();
    expect(subject.tryBeginResolution({ interactive: true })).toBeNull();
    firstInteractive?.release();
  });

  it("admite el cambio de fuente mientras termina una resolución anterior", () => {
    const subject = budget({ careResolutions: 1, saturatedResolutions: 4 });
    subject.sample({ rssBytes: 601 * MIB, heapUsedBytes: 50 * MIB });
    subject.beginResolution();
    const next = subject.tryBeginResolution({ interactive: true });
    expect(next).not.toBeNull();
    next?.release();
  });

  it("cierra el carril interactivo ante una presión de memoria realmente extrema", () => {
    const subject = budget();
    subject.sample({ rssBytes: 1_501 * MIB, heapUsedBytes: 50 * MIB });
    expect(subject.tryBeginResolution({ interactive: true })).toBeNull();
  });

  it("refreshes injected metrics on snapshot and exposes cheap policy flags", () => {
    let rssBytes = 100 * MIB;
    let now = 10;
    const subject = budget({
      now: () => now,
      readMemory: () => ({ rssBytes, heapUsedBytes: 50 * MIB }),
    });
    rssBytes = 601 * MIB;
    now = 20;
    expect(subject.snapshot()).toMatchObject({
      mode: "saturated",
      rssBytes,
      sampledAt: 20,
      allowSpeculativeWork: false,
      suggestedFallback: "embed",
    });
    expect(subject.suggestedFallback()).toBe("embed");
  });

  it("measures interval drift and dispose clears the sampler", () => {
    let now = 0;
    let callback: (() => void) | undefined;
    const clear = vi.fn();
    const fakeHandle = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const subject = budget({
      autoStart: true,
      sampleIntervalMs: 1_000,
      sustainedLagSamples: 1,
      now: () => now,
      setIntervalFn: ((fn: () => void) => {
        callback = fn;
        return fakeHandle;
      }) as typeof setInterval,
      clearIntervalFn: clear as unknown as typeof clearInterval,
    });
    expect(fakeHandle.unref).toHaveBeenCalledOnce();
    now = 1_300;
    callback?.();
    expect(subject.snapshot({ refreshMemory: false })).toMatchObject({
      eventLoopLagMs: 300,
      mode: "saturated",
    });
    subject.dispose();
    subject.dispose();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("normalizes invalid injected values instead of corrupting policy", () => {
    const subject = budget();
    subject.sample({ rssBytes: Number.NaN, heapUsedBytes: -1 });
    subject.recordEventLoopLag(Number.NaN);
    expect(subject.snapshot({ refreshMemory: false })).toMatchObject({
      rssBytes: 100 * MIB,
      heapUsedBytes: 50 * MIB,
      eventLoopLagMs: 0,
      mode: "normal",
    });
  });
});
