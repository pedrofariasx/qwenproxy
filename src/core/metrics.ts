import { EventEmitter } from 'events'
import os from 'os'
import { config } from './config.js'

interface MetricPoint {
  value: number
  timestamp: number
  labels?: Record<string, string>
}

type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary'

interface MetricDefinition {
  name: string
  type: MetricType
  help: string
  values: Map<string, MetricPoint>
  histogramBuckets?: number[]
}

export class Metrics extends EventEmitter {
  private metrics: Map<string, MetricDefinition> = new Map()
  private collectionInterval: NodeJS.Timeout | null = null
  private exportCallback: ((metrics: Map<string, MetricDefinition>) => void) | null = null

  constructor() {
    super()
    this.registerDefaults()
  }

  private registerDefaults(): void {
    const defaults: Array<[string, MetricType, string]> = [
      ['requests.total', 'counter', 'Total requests processed'],
      ['requests.errors', 'counter', 'Requests answered with 4xx/5xx status'],
      ['requests.4xx', 'counter', 'Requests answered with 4xx status'],
      ['requests.5xx', 'counter', 'Requests answered with 5xx status'],
      ['requests.by_status', 'counter', 'Requests by HTTP status code'],
      ['requests.completions', 'counter', 'Chat completions requests'],
      ['latency.request', 'histogram', 'Request latency (ms)'],
      ['latency.completion', 'histogram', 'Completion latency to response start (ms)'],
      ['streams.active', 'gauge', 'Active SSE streams'],
      ['streams.by.account', 'gauge', 'Active SSE streams per account'],
      ['streams.errors', 'counter', 'Stream errors'],
      ['toolcalls.malformed', 'counter', 'Malformed tool call blocks dropped by the parser'],
      ['memory.heap.used', 'gauge', 'Heap memory used (bytes)'],
      ['memory.heap.total', 'gauge', 'Heap memory total (bytes)'],
      ['memory.rss', 'gauge', 'Resident set size (bytes) — real memory footprint'],
      ['memory.system.total', 'gauge', 'Total system memory (bytes)'],
      ['cache.set', 'counter', 'Cache set operations'],
      ['cache.hit', 'counter', 'Cache hits'],
      ['cache.miss', 'counter', 'Cache misses'],
      ['cache.deleted', 'counter', 'Cache deletions'],
      ['cache.flushed', 'counter', 'Cache flushes'],
      ['cache.evicted', 'counter', 'Cache evictions'],
      ['cache.value.size', 'histogram', 'Cache value size (bytes)'],
      ['cache.get.latency', 'histogram', 'Cache get latency (ms)'],
      ['watchdog.ram.status', 'gauge', 'Watchdog RAM status (0=ok, 1=warning, 2=critical)'],
      ['watchdog.overall', 'gauge', 'Watchdog overall status (0=healthy, 1=degraded, 2=unhealthy)'],
      ['watchdog.recovery.triggered', 'counter', 'Recovery attempts triggered'],
      ['watchdog.recovery.success', 'counter', 'Successful recoveries'],
      ['watchdog.recovery.failed', 'counter', 'Failed recoveries'],
      ['accounts.stale_slots_swept', 'counter', 'Concurrency slots force-released by the stale-slot sweeper'],
    ]

    for (const [name, type, help] of defaults) {
      this.metrics.set(name, {
        name,
        type,
        help,
        values: new Map(),
        histogramBuckets: type === 'histogram' ? [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] : undefined,
      })
    }
  }

  increment(name: string, value: number = 1, labels?: Record<string, string>): void {
    const metric = this.metrics.get(name)
    if (!metric || metric.type !== 'counter') return

    const key = labels ? JSON.stringify(labels) : 'default'
    const current = metric.values.get(key)?.value || 0
    metric.values.set(key, { value: current + value, timestamp: Date.now(), labels })
    this.emit('metric', { name, type: 'counter', value: current + value, labels })
  }

  decrement(name: string, labels?: Record<string, string>): void {
    this.increment(name, -1, labels)
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const metric = this.metrics.get(name)
    if (!metric || metric.type !== 'gauge') return

    const key = labels ? JSON.stringify(labels) : 'default'
    metric.values.set(key, { value, timestamp: Date.now(), labels })
    this.emit('metric', { name, type: 'gauge', value, labels })
  }

  histogram(name: string, value: number, labels?: Record<string, string>): void {
    const metric = this.metrics.get(name)
    if (!metric || metric.type !== 'histogram') return

    const key = labels ? JSON.stringify(labels) : 'default'
    const existing = metric.values.get(key)
    const data = existing?.value || { count: 0, sum: 0, buckets: new Map<number, number>() }

    if (typeof data === 'object' && data !== null) {
      data.count++
      data.sum += value
      for (const bucket of metric.histogramBuckets || []) {
        data.buckets.set(bucket, (data.buckets.get(bucket) || 0) + (value <= bucket ? 1 : 0))
      }
    }

    metric.values.set(key, { value: data as any, timestamp: Date.now(), labels })
    this.emit('metric', { name, type: 'histogram', value, labels })
  }

  startCollection(): void {
    if (this.collectionInterval) return

    this.collectionInterval = setInterval(() => {
      this.collectSystemMetrics()
      if (this.exportCallback) {
        this.exportCallback(this.metrics)
      }
    }, config.metrics.interval)
  }

  private collectSystemMetrics(): void {
    const mem = process.memoryUsage()
    this.gauge('memory.heap.used', mem.heapUsed)
    this.gauge('memory.heap.total', mem.heapTotal)
    this.gauge('memory.rss', mem.rss)
    this.gauge('memory.system.total', os.totalmem())
  }

  setExportCallback(callback: (metrics: Map<string, MetricDefinition>) => void): void {
    this.exportCallback = callback
  }

  get(name: string, labels?: Record<string, string>): MetricPoint | null {
    const metric = this.metrics.get(name)
    if (!metric) return null
    const key = labels ? JSON.stringify(labels) : 'default'
    return metric.values.get(key) || null
  }

  getAll(): Map<string, MetricDefinition> {
    return new Map(this.metrics)
  }

  formatPrometheus(): string {
    let output = ''
    for (const metric of this.metrics.values()) {
      output += `# HELP ${metric.name} ${metric.help}\n`
      output += `# TYPE ${metric.name} ${metric.type}\n`

      for (const [, point] of metric.values) {
        const labelsStr = point.labels
          ? `{${Object.entries(point.labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
          : ''

        if (metric.type === 'histogram' && typeof point.value === 'object' && point.value !== null) {
          const data = point.value as { count: number; sum: number; buckets: Map<number, number> }
          const buckets = metric.histogramBuckets || []
          let cumulative = 0
          for (const bucket of buckets) {
            cumulative += data.buckets.get(bucket) || 0
            const bucketLabels = point.labels
              ? `{${Object.entries(point.labels).map(([k, v]) => `${k}="${v}"`).join(',')},le="${bucket}"}`
              : `{le="${bucket}"}`
            output += `${metric.name}_bucket${bucketLabels} ${cumulative}\n`
          }
          const infLabels = point.labels
            ? `{${Object.entries(point.labels).map(([k, v]) => `${k}="${v}"`).join(',')},le="+Inf"}`
            : '{le="+Inf"}'
          output += `${metric.name}_bucket${infLabels} ${data.count}\n`
          output += `${metric.name}_sum${labelsStr} ${data.sum}\n`
          output += `${metric.name}_count${labelsStr} ${data.count}\n`
        } else {
          output += `${metric.name}${labelsStr} ${point.value} ${point.timestamp}\n`
        }
      }
    }
    return output
  }

  reset(): void {
    for (const metric of this.metrics.values()) {
      metric.values.clear()
    }
  }

  stopCollection(): void {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval)
      this.collectionInterval = null
    }
  }
}

export const metrics = new Metrics()
