type CacheEntry<T> = { expiresAt: number; value: T };

export class SubtitleCache<T> {
  private readonly values = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries = 512) {}

  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.values.size >= this.maxEntries && !this.values.has(key)) {
      const oldest = this.values.keys().next().value;
      if (oldest) this.values.delete(oldest);
    }
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.values.clear();
  }

  get size(): number {
    return this.values.size;
  }
}
