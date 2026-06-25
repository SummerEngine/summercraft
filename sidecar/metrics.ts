/**
 * AgentCraft — in-process metrics (Track A / Brain, plan §4.1 seam 1, lane L4).
 *
 * SEAM (stable signature — every lane imports `metrics`; L4 owns the real impl):
 *   metrics.inc(name, by?) / metrics.observe(name, ms) / metrics.setGauge(name, value) / metrics.snapshot().
 *
 * PHASE-1 SKELETON: real-enough in-memory counters/gauges/histograms that no-op safely, so the lanes can
 * start instrumenting now. snapshot() is what the future additive GET /metrics route (added in L4, NOT in
 * this Phase-1 refactor) will serialize. No route is wired here — behavior is unchanged.
 *
 * Names other lanes reference (so they agree on spelling): live_sessions (gauge), turn_latency_ms
 * (observe), error_rate, lock_contention, token_usage.
 */

/** A histogram's summary view in a snapshot. */
export interface HistSnapshot {
  count: number;
  p50: number;
  p95: number;
}

export interface Metrics {
  /** Add `by` (default 1) to a monotonic counter. */
  inc(name: string, by?: number): void;
  /** Record a duration/sample (ms) into a histogram (count/p50/p95). */
  observe(name: string, ms: number): void;
  /** Set an instantaneous gauge value (e.g. live_sessions). */
  setGauge(name: string, value: number): void;
  /** A point-in-time view: counters/gauges as numbers, histograms as {count,p50,p95}. */
  snapshot(): Record<string, number | HistSnapshot>;
  /**
   * Start a duration timer. Call the returned `done()` to `observe(name, elapsedMs)`. Convenience over
   * a manual `Date.now()` pair so call sites can `const end = metrics.timer("turn_latency_ms"); … end();`.
   */
  timer(name: string): () => void;
  /** Render the current snapshot as Prometheus/OpenMetrics text (what GET /metrics serves). */
  prometheus(): string;
}

/**
 * The standard metric names every lane agrees to spell the same way (so /metrics is consistent). Lanes
 * import these constants rather than re-typing the strings, and the charter §0 observability list maps
 * 1:1 onto them. Adding a name here is additive; renaming one is a breaking change to /metrics.
 */
export const METRIC = {
  /** gauge: number of currently live AgentSessions. */
  LIVE_SESSIONS: "live_sessions",
  /** observe(ms): wall-clock latency of one agent turn. */
  TURN_LATENCY_MS: "turn_latency_ms",
  /** counter: turns that completed successfully. */
  TURNS_OK: "turns_ok",
  /** counter: turns that ended in an error (the numerator of the error rate). */
  TURNS_ERROR: "turns_error",
  /** counter: lock-claim denials (the D6 Aiven contention beat). */
  LOCK_CONTENTION: "lock_contention",
  /** counter: total input+output tokens, where the SDK surfaces usage. */
  TOKEN_USAGE: "token_usage",
  /** counter: HTTP requests rejected by validation / rate limit / origin check. */
  REQUESTS_REJECTED: "requests_rejected",
} as const;

/** Compute a percentile from an unsorted sample array (nearest-rank). 0 samples -> 0. */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Phase-1 in-memory metrics. Histograms keep a bounded ring of recent samples so a long-running process
 * never grows unbounded; p50/p95 are computed over that window. Everything is best-effort and never throws.
 */
class InMemoryMetrics implements Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private hist = new Map<string, number[]>();
  /** Cap per-histogram retained samples so memory stays bounded under sustained load. */
  private static readonly HIST_WINDOW = 1024;

  inc(name: string, by = 1): void {
    if (!Number.isFinite(by)) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, ms: number): void {
    if (!Number.isFinite(ms)) return;
    let arr = this.hist.get(name);
    if (!arr) {
      arr = [];
      this.hist.set(name, arr);
    }
    arr.push(ms);
    if (arr.length > InMemoryMetrics.HIST_WINDOW) {
      arr.splice(0, arr.length - InMemoryMetrics.HIST_WINDOW);
    }
  }

  setGauge(name: string, value: number): void {
    if (!Number.isFinite(value)) return;
    this.gauges.set(name, value);
  }

  snapshot(): Record<string, number | HistSnapshot> {
    const out: Record<string, number | HistSnapshot> = {};
    for (const [k, v] of this.counters) out[k] = v;
    for (const [k, v] of this.gauges) out[k] = v;
    for (const [k, samples] of this.hist) {
      out[k] = {
        count: samples.length,
        p50: percentile(samples, 50),
        p95: percentile(samples, 95),
      };
    }
    return out;
  }

  timer(name: string): () => void {
    const start = Date.now();
    let fired = false; // idempotent: a double-call must not double-count
    return () => {
      if (fired) return;
      fired = true;
      this.observe(name, Date.now() - start);
    };
  }

  /**
   * Prometheus/OpenMetrics text exposition. Counters/gauges become `name value`; histograms expand to
   * `name_count` plus `name{quantile="0.5|0.95"}` lines. Metric names are sanitized to the Prometheus
   * charset so an arbitrary name can never produce a malformed line. Best-effort; never throws.
   */
  prometheus(): string {
    const safe = (n: string) => n.replace(/[^a-zA-Z0-9_]/g, "_");
    const lines: string[] = [];
    try {
      for (const [k, v] of this.counters) lines.push(`${safe(k)} ${v}`);
      for (const [k, v] of this.gauges) lines.push(`${safe(k)} ${v}`);
      for (const [k, samples] of this.hist) {
        const n = safe(k);
        lines.push(`${n}_count ${samples.length}`);
        lines.push(`${n}{quantile="0.5"} ${percentile(samples, 50)}`);
        lines.push(`${n}{quantile="0.95"} ${percentile(samples, 95)}`);
      }
    } catch {
      /* never let metric rendering crash the /metrics route */
    }
    return lines.join("\n") + "\n";
  }
}

/** The single process-wide metrics registry. */
export const metrics: Metrics = new InMemoryMetrics();
