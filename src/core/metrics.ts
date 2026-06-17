import { EventEmitter } from 'events'
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
      ['requests.errors', 'counter', 'Total request errors'],
      ['latency.request', 'histogram', 'Request latency (ms)'],
      ['streams.active', 'gauge', 'Active SSE streams'],
      ['streams.errors', 'counter', 'Stream errors'],
      ['memory.heap.used', 'gauge', 'Heap memory used (bytes)'],
      ['memory.heap.total', 'gauge', 'Heap memory total (bytes)'],
      ['cache.set', 'counter', 'Cache set operations'],
      ['cache.hit', 'counter', 'Cache hits'],
      ['cache.miss', 'counter', 'Cache misses'],
      ['cache.deleted', 'counter', 'Cache deletions'],
      ['cache.flushed', 'counter', 'Cache flushes'],
      ['cache.value.size', 'histogram', 'Cache value size (bytes)'],
      ['cache.get.latency', 'histogram', 'Cache get latency (ms)'],
      ['watchdog.ram.status', 'gauge', 'Watchdog RAM status (0=ok, 1=warning, 2=critical)'],
      ['watchdog.overall', 'gauge', 'Watchdog overall status (0=healthy, 1=degraded, 2=unhealthy)'],
      ['watchdog.recovery.triggered', 'counter', 'Recovery attempts triggered'],
      ['watchdog.recovery.success', 'counter', 'Successful recoveries'],
      ['watchdog.recovery.failed', 'counter', 'Failed recoveries'],
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
        output += `${metric.name}${labelsStr} ${point.value} ${point.timestamp}\n`
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
