import { EventEmitter } from 'events'
import { config } from './config.js'
import { metrics } from './metrics.js'

interface HealthStatus {
  ram: 'ok' | 'warning' | 'critical'
  websocket: 'ok' | 'congested' | 'blocked'
  overall: 'healthy' | 'degraded' | 'unhealthy'
}

export class Watchdog extends EventEmitter {
  private checkInterval: NodeJS.Timeout | null = null
  private consecutiveFailures: number = 0
  private recoveryInProgress: boolean = false

  start(): void {
    if (this.checkInterval) return

    this.checkInterval = setInterval(() => {
      this.performHealthCheck().catch(error => {
        this.emit('check:error', error)
        this.consecutiveFailures++
      })
    }, config.watchdog.checkInterval)

    this.emit('started')
  }

  private async performHealthCheck(): Promise<void> {
    if (this.recoveryInProgress) return;
    const status: HealthStatus = {
      ram: this.checkRAM(),
      websocket: this.checkWebSocket(),
      overall: 'healthy',
    }

    status.overall = this.calculateOverall(status)

    if (status.overall === 'unhealthy') {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= config.watchdog.consecutiveFailuresThreshold && !this.recoveryInProgress) {
        await this.triggerRecovery(status)
      }
    } else {
      this.consecutiveFailures = 0
    }

    this.emit('health:check', status)
    metrics.gauge('watchdog.ram.status', status.ram === 'ok' ? 0 : status.ram === 'warning' ? 1 : 2)
    metrics.gauge('watchdog.overall', status.overall === 'healthy' ? 0 : status.overall === 'degraded' ? 1 : 2)
  }

  private checkRAM(): 'ok' | 'warning' | 'critical' {
    const mem = process.memoryUsage()
    // Use RSS (Resident Set Size — actual physical memory) instead of heap ratio.
    // heapUsed/heapTotal is misleading: Node.js pre-allocates heap so the ratio
    // easily hits 80-95% even with low actual memory usage.
    const rssMB = Math.round(mem.rss / (1024 * 1024))
    const heapUsedMB = Math.round(mem.heapUsed / (1024 * 1024))
    const heapTotalMB = Math.round(mem.heapTotal / (1024 * 1024))
    const externalMB = Math.round(mem.external / (1024 * 1024))

    // Always report actual MB values on every tick, even when status is
    // warning or critical — losing visibility at the worst time is dangerous.
    metrics.gauge('watchdog.ram.rss_mb', rssMB)
    metrics.gauge('watchdog.ram.heap_used_mb', heapUsedMB)
    metrics.gauge('watchdog.ram.heap_total_mb', heapTotalMB)
    metrics.gauge('watchdog.ram.external_mb', externalMB)

    // Combined: critical if RSS exceeds threshold OR heap is near limit
    const criticalRssMB = config.watchdog.ram.criticalThreshold
    const warningRssMB = config.watchdog.ram.warningThreshold

    // Also check heap fragmentation: if heapUsed > 90% of heapTotal AND heapTotal > 500MB
    const heapUsageRatio = heapUsedMB / Math.max(heapTotalMB, 1)
    const heapConstrained = heapUsageRatio > 0.90 && heapTotalMB > 500

    if (rssMB > criticalRssMB || heapConstrained) return 'critical'
    if (rssMB > warningRssMB) return 'warning'

    return 'ok'
  }

  private checkWebSocket(): 'ok' | 'congested' | 'blocked' {
    const activeStreams = metrics.get('streams.active')?.value || 0
    if (activeStreams > config.watchdog.websocket.criticalThreshold) return 'blocked'
    if (activeStreams > config.watchdog.websocket.warningThreshold) return 'congested'
    return 'ok'
  }

  private calculateOverall(status: HealthStatus): 'healthy' | 'degraded' | 'unhealthy' {
    const critical = ['critical', 'blocked']
    const warning = ['warning', 'congested']

    const values = Object.values(status).filter(v => typeof v === 'string') as string[]
    if (values.some(v => critical.includes(v))) return 'unhealthy'
    if (values.some(v => warning.includes(v))) return 'degraded'
    return 'healthy'
  }

  private async triggerRecovery(status: HealthStatus): Promise<void> {
    if (this.recoveryInProgress) return
    this.recoveryInProgress = true

    this.emit('recovery:start', status)
    metrics.increment('watchdog.recovery.triggered')

    try {
      if (status.ram === 'critical') {
        await this.recoverRAM()
      }
      if (status.websocket === 'blocked') {
        await this.recoverWebSocket()
      }

      this.emit('recovery:complete')
      metrics.increment('watchdog.recovery.success')
    } catch (error: any) {
      this.emit('recovery:error', error)
      metrics.increment('watchdog.recovery.failed')
    } finally {
      this.recoveryInProgress = false
    }
  }

  private async recoverRAM(): Promise<void> {
    if (global.gc) global.gc()
    await new Promise(resolve => setTimeout(resolve, 100))
    this.emit('recovery:ram:freed')
  }

  private async recoverWebSocket(): Promise<void> {
    this.emit('recovery:websocket:throttled')
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
    this.emit('stopped')
  }

  getStatus(): Promise<HealthStatus> {
    const status: HealthStatus = {
      ram: this.checkRAM(),
      websocket: this.checkWebSocket(),
      overall: 'healthy',
    }
    status.overall = this.calculateOverall(status)
    return Promise.resolve(status)
  }
}
