/** Tiny metrics collector: counters, gauges and latency samples. */

export type MetricLabels = Record<string, string>;

export interface MetricPoint {
  name: string;
  labels: MetricLabels;
  value: number;
}

export interface LatencyPoint {
  name: string;
  labels: MetricLabels;
  count: number;
  sum: number;
  p50: number;
  p95: number;
  max: number;
}

export interface MetricsData {
  counters: MetricPoint[];
  gauges: MetricPoint[];
  latencies: LatencyPoint[];
}

type CounterEntry = MetricPoint;
type GaugeEntry = MetricPoint;
interface SampleEntry {
  name: string;
  labels: MetricLabels;
  values: number[];
}

function key(name: string, labels: MetricLabels): string {
  const suffix = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
  return suffix ? `${name}{${suffix}}` : name;
}

export class Metrics {
  private readonly counters = new Map<string, CounterEntry>();
  private readonly gauges = new Map<string, GaugeEntry>();
  private readonly samples = new Map<string, SampleEntry>();

  inc(name: string, value = 1, labels: MetricLabels = {}): void {
    const k = key(name, labels);
    const existing = this.counters.get(k);
    if (existing) {
      existing.value += value;
    } else {
      this.counters.set(k, { name, labels: { ...labels }, value });
    }
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    const k = key(name, labels);
    const existing = this.gauges.get(k);
    if (existing) {
      existing.value = value;
    } else {
      this.gauges.set(k, { name, labels: { ...labels }, value });
    }
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const k = key(name, labels);
    const existing = this.samples.get(k);
    if (existing) {
      existing.values.push(value);
    } else {
      this.samples.set(k, { name, labels: { ...labels }, values: [value] });
    }
  }

  /** Structured export used by Prometheus and report writers. */
  exportData(): MetricsData {
    const latencies: LatencyPoint[] = [];
    for (const entry of this.samples.values()) {
      const sorted = [...entry.values].sort((a, b) => a - b);
      latencies.push({
        name: entry.name,
        labels: entry.labels,
        count: sorted.length,
        sum: sorted.reduce((sum, value) => sum + value, 0),
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1] ?? 0,
      });
    }
    return {
      counters: [...this.counters.values()],
      gauges: [...this.gauges.values()],
      latencies,
    };
  }

  snapshot(): {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    latencies: Record<string, { count: number; sum: number; p50: number; p95: number; max: number }>;
  } {
    const data = this.exportData();
    return {
      counters: Object.fromEntries(data.counters.map((point) => [key(point.name, point.labels), point.value])),
      gauges: Object.fromEntries(data.gauges.map((point) => [key(point.name, point.labels), point.value])),
      latencies: Object.fromEntries(
        data.latencies.map((point) => [
          key(point.name, point.labels),
          { count: point.count, sum: point.sum, p50: point.p50, p95: point.p95, max: point.max },
        ])
      ),
    };
  }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}
