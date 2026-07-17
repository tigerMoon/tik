/**
 * In-process request throttle for high-frequency multi-agent read routes.
 *
 * Protects `/next-action` and `GET /workflows/:id` from unbounded polling.
 * Per (route, client) bucket:
 *   1. `check(key)` returns a decision: pass, or throttled-with-cached-result.
 *   2. If pass, caller runs the real read and MUST call `record(key, result)`.
 *   3. If throttled, caller serves the cached result and sets `Retry-After`.
 *
 * The throttle is honest about the budget: once `maxRequests` real reads have
 * happened in `windowMs`, further requests are throttled regardless of cache
 * age. If the cache is stale AND the client is over-budget, the throttle
 * still returns `throttled: true` with the last cached body — the alternative
 * (waiving throttling on stale cache) makes the budget meaningless because a
 * client polling faster than the cache TTL never hits the ceiling.
 *
 * Mutation routes must call `invalidate(prefix)` after commit so the next read
 * in the burst window bypasses the cache once.
 */

export interface ThrottleBucketConfig {
  /** Max real reads allowed in `windowMs` per client key. */
  maxRequests: number;
  /** Rolling window over which `maxRequests` is enforced. */
  windowMs: number;
  /**
   * How long a cached response stays fresh. Only meaningful when the client is
   * under budget — a stale cache under budget triggers a real read; a stale
   * cache over budget is still served (throttled=true) because the alternative
   * defeats the budget.
   */
  cacheTtlMs: number;
}

// Budget tuned so healthy Codex polling (1-2 req/s during active work) is
// never throttled, but a runaway loop that ignores 202/Retry-After hits the
// ceiling within ~30 s. Tests that poll aggressively (e.g. waitForCondition
// at 100 req/s) can pass an `X-Tik-Client-Id: <unique-per-test>` header to
// stay in their own bucket, or send `X-Tik-Throttle-Bypass: 1` if they need
// to hammer the endpoint for cross-condition verification.
export const NEXT_ACTION_THROTTLE: ThrottleBucketConfig = {
  maxRequests: 120,
  windowMs: 60_000,
  cacheTtlMs: 500,
};

export const READ_WORKFLOW_THROTTLE: ThrottleBucketConfig = {
  maxRequests: 200,
  windowMs: 60_000,
  cacheTtlMs: 500,
};

interface BucketState {
  /**
   * Timestamps of REAL reads recorded via `record`. Throttled hits (which
   * serve cache) do NOT append here — that would let a chatty client double-
   * count and blow past `maxRequests`.
   */
  timestamps: number[];
  cachedAt: number | null;
  cachedResult: unknown;
  /**
   * Whether the last real read was a `202 awaiting_native_runtime`. Recorded
   * so throttled callers can re-emit the same HTTP status and Retry-After
   * signalling as the cached response, rather than serving the body with a
   * default 200 (which breaks CLI cooldown installers).
   */
  cachedAwaiting: boolean;
  cachedRetryAfterMs?: number;
}

export interface RecordOptions {
  /**
   * When true, mark the cached response as `awaiting_native_runtime` so
   * subsequent throttled hits re-emit the same 202 semantics. `retryAfterMs`
   * is the value the caller set on the original response.
   */
  awaitingNativeRuntime?: boolean;
  retryAfterMs?: number;
}

export interface CheckResult {
  throttled: boolean;
  cachedResult?: unknown;
  /** Suggested Retry-After (ms). Present on throttled results. */
  retryAfterMs?: number;
  /**
   * True when the throttled cached response was originally a 202
   * awaiting_native_runtime. Server should re-emit HTTP 202 + Retry-After to
   * preserve the CLI cooldown contract.
   */
  cachedAwaiting?: boolean;
}

export class RequestThrottle {
  private readonly buckets = new Map<string, BucketState>();
  private readonly nowFn: () => number;

  constructor(now: () => number = Date.now) {
    this.nowFn = now;
  }

  check(key: string, config: ThrottleBucketConfig): CheckResult {
    const now = this.nowFn();
    const bucket = this.buckets.get(key);
    if (!bucket) return { throttled: false };
    this.trimOldTimestamps(bucket, now, config.windowMs);
    if (bucket.timestamps.length < config.maxRequests) {
      // Under budget: allow a real read. If the cache is fresh the caller may
      // choose to skip the read and just serve the cached body, but that's a
      // separate policy decision; the throttle's job is only to enforce the
      // per-window budget.
      return { throttled: false };
    }
    // Over budget: refuse a real read. If we have a cached result, serve it;
    // if not, still refuse and let the caller decide (typically a real read
    // must run at least once before the throttle can be honored).
    if (bucket.cachedAt === null) {
      // No cache seed yet — allow a single real read even if timestamps say
      // we're over budget. This prevents a burst of parallel first-time
      // callers from all being blocked with no response to serve.
      return { throttled: false };
    }
    const oldest = bucket.timestamps[0];
    const retryAfterMs = Math.max(1_000, config.windowMs - (now - oldest));
    return {
      throttled: true,
      cachedResult: bucket.cachedResult,
      retryAfterMs: bucket.cachedRetryAfterMs ?? retryAfterMs,
      cachedAwaiting: bucket.cachedAwaiting,
    };
  }

  record(key: string, config: ThrottleBucketConfig, result: unknown, options: RecordOptions = {}): void {
    const now = this.nowFn();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [], cachedAt: null, cachedResult: undefined, cachedAwaiting: false };
      this.buckets.set(key, bucket);
    }
    this.trimOldTimestamps(bucket, now, config.windowMs);
    bucket.timestamps.push(now);
    bucket.cachedAt = now;
    bucket.cachedResult = result;
    bucket.cachedAwaiting = Boolean(options.awaitingNativeRuntime);
    bucket.cachedRetryAfterMs = options.retryAfterMs;
  }

  /**
   * Drop the cached response for keys with this prefix. Call from any handler
   * that mutates the workflow so the next read is guaranteed fresh even
   * inside a burst window. The rolling-window timestamps stay in place so
   * throttling still applies to the next real read.
   */
  invalidate(prefix: string): void {
    for (const [key, bucket] of this.buckets) {
      if (key.startsWith(prefix)) {
        bucket.cachedAt = null;
        bucket.cachedResult = undefined;
        bucket.cachedAwaiting = false;
        bucket.cachedRetryAfterMs = undefined;
      }
    }
  }

  private trimOldTimestamps(bucket: BucketState, now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    while (bucket.timestamps.length > 0 && bucket.timestamps[0] < cutoff) {
      bucket.timestamps.shift();
    }
  }

  /** For tests only. */
  clear(): void {
    this.buckets.clear();
  }
}

/**
 * Derive a stable per-client key for throttle bucketing. Prefers the explicit
 * `X-Tik-Client-Id` header (which CLI callers can set), falling back to
 * IP + user-agent when the client is anonymous.
 */
export function throttleClientKey(headers: Record<string, string | string[] | undefined>, remoteIp: string | undefined): string {
  const explicit = headerString(headers['x-tik-client-id']);
  if (explicit) return `id:${explicit}`;
  const ua = headerString(headers['user-agent']) || 'anon';
  const ip = remoteIp || 'unknown';
  return `net:${ip}:${ua.slice(0, 64)}`;
}

/**
 * True when the caller has explicitly requested a throttle bypass. Used by
 * tests, CI, and interactive debugging. NOT a security boundary — anyone
 * sending the header bypasses. Meant for correctness across trusted clients,
 * not abuse protection.
 */
export function throttleBypassed(headers: Record<string, string | string[] | undefined>): boolean {
  const value = headerString(headers['x-tik-throttle-bypass']);
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true';
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}
