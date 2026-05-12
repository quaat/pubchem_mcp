export interface CacheOptions {
  ttlMs: number;
  maxEntries: number;
  disabled?: boolean;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
  disabled: boolean;
  ttlMs: number;
  maxEntries: number;
}

export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly disabled: boolean;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(opts: CacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries;
    this.disabled = opts.disabled === true || opts.maxEntries <= 0 || opts.ttlMs <= 0;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): V | undefined {
    if (this.disabled) {
      this.misses += 1;
      return undefined;
    }
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Refresh recency for LRU eviction.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /**
   * Store a value. An optional `ttlMs` overrides the cache-wide default for
   * this entry only — useful when a particular endpoint should be cached
   * shorter (e.g. an error-prone path) or longer than the global TTL.
   */
  set(key: string, value: V, ttlMs?: number): void {
    if (this.disabled) return;
    const ttl = ttlMs !== undefined ? ttlMs : this.ttlMs;
    if (ttl <= 0) return; // a per-request ttl of 0 means "don't cache this one"
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      // Evict oldest (Map preserves insertion order).
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
        this.evictions += 1;
      }
    }
    this.store.set(key, { value, expiresAt: this.now() + ttl });
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  stats(): CacheStats {
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      disabled: this.disabled,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
    };
  }
}
