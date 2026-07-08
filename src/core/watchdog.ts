import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import { config } from './config.js'
import { metrics } from './metrics.js'

interface HealthStatus {
  ram: 'ok' | 'warning' | 'critical'
  streams: 'ok' | 'congested' | 'blocked'
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
    const status: HealthStatus = {
      ram: this.checkRAM(),
      streams: this.checkStreams(),
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
    const usagePercent = this.getMemoryUsagePercent()

    if (usagePercent > config.watchdog.ram.criticalThreshold) return 'critical'
    if (usagePercent > config.watchdog.ram.warningThreshold) return 'warning'
    return 'ok'
  }

  private readNumberFile(filePath: string): number | null {
    try {
      const value = fs.readFileSync(filePath, 'utf8').trim()
      if (!value || value === 'max') return null
      const parsed = Number.parseInt(value, 10)
      return Number.isFinite(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private getMemoryUsagePercent(): number {
    const cgroupCurrent = this.readNumberFile('/sys/fs/cgroup/memory.current')
      ?? this.readNumberFile('/sys/fs/cgroup/memory/memory.usage_in_bytes')
    const cgroupMax = this.readNumberFile('/sys/fs/cgroup/memory.max')
      ?? this.readNumberFile('/sys/fs/cgroup/memory/memory.limit_in_bytes')

    if (cgroupCurrent && cgroupMax && cgroupMax > 0) {
      return (cgroupCurrent / cgroupMax) * 100
    }

    const mem = process.memoryUsage()
    return (mem.rss / os.totalmem()) * 100
  }

  private checkStreams(): 'ok' | 'congested' | 'blocked' {
    const activeStreams = metrics.get('streams.active')?.value || 0
    if (activeStreams > config.watchdog.streams.criticalThreshold) return 'blocked'
    if (activeStreams > config.watchdog.streams.warningThreshold) return 'congested'
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
      if (status.streams === 'blocked') {
        await this.recoverStreams()
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

  private async recoverStreams(): Promise<void> {
    this.emit('recovery:streams:throttled')
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
      streams: this.checkStreams(),
      overall: 'healthy',
    }
    status.overall = this.calculateOverall(status)
    return Promise.resolve(status)
  }
}
