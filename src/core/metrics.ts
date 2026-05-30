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
    const defaultBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
    const toolDurationBuckets = [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30]

    interface MetricEntry {
      name: string
      type: MetricType
      help: string
      buckets?: number[]
    }

    const defaults: MetricEntry[] = [
      { name: 'requests.total', type: 'counter', help: 'Total requests processed' },
      { name: 'requests.errors', type: 'counter', help: 'Total request errors' },
      { name: 'latency.request', type: 'histogram', help: 'Request latency (ms)' },
      { name: 'streams.active', type: 'gauge', help: 'Active SSE streams' },
      { name: 'streams.errors', type: 'counter', help: 'Stream errors' },
      { name: 'memory.heap.used', type: 'gauge', help: 'Heap memory used (bytes)' },
      { name: 'memory.heap.total', type: 'gauge', help: 'Heap memory total (bytes)' },
      { name: 'cache.set', type: 'counter', help: 'Cache set operations' },
      { name: 'cache.hit', type: 'counter', help: 'Cache hits' },
      { name: 'cache.miss', type: 'counter', help: 'Cache misses' },
      { name: 'cache.deleted', type: 'counter', help: 'Cache deletions' },
      { name: 'cache.flushed', type: 'counter', help: 'Cache flushes' },
      { name: 'cache.value.size', type: 'histogram', help: 'Cache value size (bytes)' },
      { name: 'cache.get.latency', type: 'histogram', help: 'Cache get latency (ms)' },
      { name: 'watchdog.ram.status', type: 'gauge', help: 'Watchdog RAM status (0=ok, 1=warning, 2=critical)' },
      { name: 'watchdog.overall', type: 'gauge', help: 'Watchdog overall status (0=healthy, 1=degraded, 2=unhealthy)' },
      { name: 'watchdog.recovery.triggered', type: 'counter', help: 'Recovery attempts triggered' },
      { name: 'watchdog.recovery.success', type: 'counter', help: 'Successful recoveries' },
      { name: 'watchdog.recovery.failed', type: 'counter', help: 'Failed recoveries' },
      // Tool call metrics
      { name: 'tools_parsed_total', type: 'counter', help: 'Total tool calls parsed (labels: method=streaming|non-streaming)' },
      { name: 'tools_parse_errors_total', type: 'counter', help: 'Tool call parse errors' },
      { name: 'tools_executed_total', type: 'counter', help: 'Total tool executions (labels: tool_name)' },
      { name: 'tools_execution_duration_seconds', type: 'histogram', help: 'Tool execution duration (seconds)', buckets: toolDurationBuckets },
    ]

    for (const { name, type, help, buckets } of defaults) {
      this.metrics.set(name, {
        name,
        type,
        help,
        values: new Map(),
        histogramBuckets: buckets || (type === 'histogram' ? defaultBuckets : undefined),
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

      for (const [key, point] of metric.values) {
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
