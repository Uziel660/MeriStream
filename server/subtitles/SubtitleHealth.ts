export interface SubtitleHealthSnapshot {
  successes: number;
  failures: number;
  consecutiveFailures: number;
  averageLatency: number;
  lastSuccess?: string;
  lastFailure?: string;
  cooldownUntil?: string;
}

type InternalHealth = SubtitleHealthSnapshot & { latencyTotal: number; cooldownUntilMs: number };

export class SubtitleHealth {
  private readonly states = new Map<string, InternalHealth>();

  constructor(
    private readonly failureThreshold = 2,
    private readonly cooldownMs = 5 * 60_000,
  ) {}

  isAvailable(provider: string): boolean {
    const state = this.states.get(provider);
    return !state || state.cooldownUntilMs <= Date.now();
  }

  success(provider: string, latencyMs: number): void {
    const state = this.state(provider);
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.latencyTotal += Math.max(0, latencyMs);
    state.averageLatency = Math.round(state.latencyTotal / state.successes);
    state.lastSuccess = new Date().toISOString();
    state.cooldownUntilMs = 0;
    delete state.cooldownUntil;
  }

  failure(provider: string): void {
    const state = this.state(provider);
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastFailure = new Date().toISOString();
    if (state.consecutiveFailures >= this.failureThreshold) {
      state.cooldownUntilMs = Date.now() + this.cooldownMs;
      state.cooldownUntil = new Date(state.cooldownUntilMs).toISOString();
    }
  }

  snapshot(): Record<string, SubtitleHealthSnapshot> {
    return Object.fromEntries([...this.states.entries()].map(([id, state]) => [id, {
      successes: state.successes,
      failures: state.failures,
      consecutiveFailures: state.consecutiveFailures,
      averageLatency: state.averageLatency,
      ...(state.lastSuccess ? { lastSuccess: state.lastSuccess } : {}),
      ...(state.lastFailure ? { lastFailure: state.lastFailure } : {}),
      ...(state.cooldownUntilMs > Date.now() ? { cooldownUntil: state.cooldownUntil } : {}),
    }]));
  }

  private state(provider: string): InternalHealth {
    const existing = this.states.get(provider);
    if (existing) return existing;
    const created: InternalHealth = {
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      averageLatency: 0,
      latencyTotal: 0,
      cooldownUntilMs: 0,
    };
    this.states.set(provider, created);
    return created;
  }
}
