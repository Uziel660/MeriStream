export type RuntimeMode = "normal" | "care" | "saturated";

export interface RuntimeMemoryMetrics {
  rssBytes: number;
  heapUsedBytes: number;
}

export interface RuntimeBudgetSnapshot extends RuntimeMemoryMetrics {
  mode: RuntimeMode;
  eventLoopLagMs: number;
  activeRelays: number;
  activeResolutions: number;
  allowSpeculativeWork: boolean;
  suggestedFallback: "embed" | null;
  sampledAt: number;
}

export interface RuntimeLease {
  release(): void;
}

export interface ResolutionAdmissionOptions {
  /** Resolución iniciada por una acción explícita del usuario (play). */
  interactive?: boolean;
}

export interface RuntimeBudgetOptions {
  careRssBytes?: number;
  saturatedRssBytes?: number;
  careHeapBytes?: number;
  saturatedHeapBytes?: number;
  careEventLoopLagMs?: number;
  saturatedEventLoopLagMs?: number;
  sustainedLagSamples?: number;
  careRelays?: number;
  saturatedRelays?: number;
  careResolutions?: number;
  saturatedResolutions?: number;
  sampleIntervalMs?: number;
  autoStart?: boolean;
  now?: () => number;
  readMemory?: () => RuntimeMemoryMetrics;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const MIB = 1024 * 1024;

const asFiniteNonNegative = (value: number, fallback: number): number =>
  Number.isFinite(value) && value >= 0 ? value : fallback;

/**
 * A deliberately small, synchronous pressure gauge for low-memory hosts.
 * It never terminates existing work. Consumers decide whether to admit new
 * speculative work or relays by consulting `shouldFallback()`/`tryBeginRelay()`.
 */
export class RuntimeBudget {
  private readonly thresholds;
  private readonly now: () => number;
  private readonly readMemory: () => RuntimeMemoryMetrics;
  private readonly clearIntervalFn: typeof clearInterval;
  private timer: ReturnType<typeof setInterval> | undefined;
  private expectedTickAt = 0;
  private activeRelays = 0;
  private activeResolutions = 0;
  private eventLoopLagMs = 0;
  private careLagStreak = 0;
  private saturatedLagStreak = 0;
  private lastMemory: RuntimeMemoryMetrics = { rssBytes: 0, heapUsedBytes: 0 };
  private sampledAt = 0;

  constructor(options: RuntimeBudgetOptions = {}) {
    const careRssBytes = options.careRssBytes ?? 450 * MIB;
    const saturatedRssBytes = options.saturatedRssBytes ?? 600 * MIB;
    const careHeapBytes = options.careHeapBytes ?? 256 * MIB;
    const saturatedHeapBytes = options.saturatedHeapBytes ?? 384 * MIB;
    const careRelays = options.careRelays ?? 3;
    const saturatedRelays = options.saturatedRelays ?? 6;
    const careResolutions = options.careResolutions ?? 2;
    const saturatedResolutions = options.saturatedResolutions ?? 4;

    this.thresholds = {
      careRssBytes,
      saturatedRssBytes: Math.max(saturatedRssBytes, careRssBytes),
      careHeapBytes,
      saturatedHeapBytes: Math.max(saturatedHeapBytes, careHeapBytes),
      careEventLoopLagMs: options.careEventLoopLagMs ?? 75,
      saturatedEventLoopLagMs: Math.max(
        options.saturatedEventLoopLagMs ?? 250,
        options.careEventLoopLagMs ?? 75,
      ),
      sustainedLagSamples: Math.max(1, Math.floor(options.sustainedLagSamples ?? 2)),
      careRelays,
      saturatedRelays: Math.max(saturatedRelays, careRelays),
      careResolutions,
      saturatedResolutions: Math.max(saturatedResolutions, careResolutions),
      sampleIntervalMs: Math.max(100, options.sampleIntervalMs ?? 1_000),
    };
    this.now = options.now ?? Date.now;
    this.readMemory = options.readMemory ?? (() => {
      const usage = process.memoryUsage();
      return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
    });
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;

    this.sample();
    if (options.autoStart !== false) {
      const schedule = options.setIntervalFn ?? setInterval;
      this.expectedTickAt = this.now() + this.thresholds.sampleIntervalMs;
      this.timer = schedule(() => this.onTimer(), this.thresholds.sampleIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Refreshes memory data. Optional metrics make unit tests and diagnostics deterministic. */
  sample(metrics = this.readMemory()): RuntimeBudgetSnapshot {
    this.lastMemory = {
      rssBytes: asFiniteNonNegative(metrics.rssBytes, this.lastMemory.rssBytes),
      heapUsedBytes: asFiniteNonNegative(metrics.heapUsedBytes, this.lastMemory.heapUsedBytes),
    };
    this.sampledAt = this.now();
    return this.currentSnapshot();
  }

  /** Records observed timer drift. Pressure requires consecutive bad samples. */
  recordEventLoopLag(lagMs: number): RuntimeBudgetSnapshot {
    this.eventLoopLagMs = asFiniteNonNegative(lagMs, 0);
    this.careLagStreak = this.eventLoopLagMs >= this.thresholds.careEventLoopLagMs
      ? this.careLagStreak + 1
      : 0;
    this.saturatedLagStreak = this.eventLoopLagMs >= this.thresholds.saturatedEventLoopLagMs
      ? this.saturatedLagStreak + 1
      : 0;
    return this.currentSnapshot();
  }

  beginRelay(): RuntimeLease {
    this.activeRelays += 1;
    return this.lease(() => this.endRelay());
  }

  tryBeginRelay(): RuntimeLease | null {
    if (this.shouldFallback()) return null;
    return this.beginRelay();
  }

  endRelay(): void {
    this.activeRelays = Math.max(0, this.activeRelays - 1);
  }

  beginResolution(): RuntimeLease {
    this.activeResolutions += 1;
    return this.lease(() => this.endResolution());
  }

  tryBeginResolution(options: ResolutionAdmissionOptions = {}): RuntimeLease | null {
    // En saturación se conserva un único carril interactivo para que una
    // reproducción solicitada por el usuario no se convierta automáticamente
    // en un iframe. El resto de resoluciones sigue rechazándose para proteger
    // memoria/CPU del host pequeño.
    if (this.shouldFallback() && !(options.interactive && this.activeResolutions === 0)) return null;
    return this.beginResolution();
  }

  endResolution(): void {
    this.activeResolutions = Math.max(0, this.activeResolutions - 1);
  }

  snapshot(options: { refreshMemory?: boolean } = {}): RuntimeBudgetSnapshot {
    return options.refreshMemory === false ? this.currentSnapshot() : this.sample();
  }

  shouldFallback(): boolean {
    return this.mode() === "saturated";
  }

  suggestedFallback(): "embed" | null {
    return this.shouldFallback() ? "embed" : null;
  }

  dispose(): void {
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  private lease(onRelease: () => void): RuntimeLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        onRelease();
      },
    };
  }

  private onTimer(): void {
    const current = this.now();
    this.recordEventLoopLag(Math.max(0, current - this.expectedTickAt));
    this.expectedTickAt = current + this.thresholds.sampleIntervalMs;
    this.sample();
  }

  private mode(): RuntimeMode {
    const sustained = this.thresholds.sustainedLagSamples;
    if (
      this.lastMemory.rssBytes >= this.thresholds.saturatedRssBytes
      || this.lastMemory.heapUsedBytes >= this.thresholds.saturatedHeapBytes
      || this.saturatedLagStreak >= sustained
      || this.activeRelays >= this.thresholds.saturatedRelays
      || this.activeResolutions >= this.thresholds.saturatedResolutions
    ) return "saturated";

    if (
      this.lastMemory.rssBytes >= this.thresholds.careRssBytes
      || this.lastMemory.heapUsedBytes >= this.thresholds.careHeapBytes
      || this.careLagStreak >= sustained
      || this.activeRelays >= this.thresholds.careRelays
      || this.activeResolutions >= this.thresholds.careResolutions
    ) return "care";

    return "normal";
  }

  private currentSnapshot(): RuntimeBudgetSnapshot {
    const mode = this.mode();
    return {
      mode,
      ...this.lastMemory,
      eventLoopLagMs: this.eventLoopLagMs,
      activeRelays: this.activeRelays,
      activeResolutions: this.activeResolutions,
      allowSpeculativeWork: mode === "normal",
      suggestedFallback: mode === "saturated" ? "embed" : null,
      sampledAt: this.sampledAt,
    };
  }
}

export const runtimeBudget = new RuntimeBudget();
