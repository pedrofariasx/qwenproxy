import chalk from 'chalk'

export async function statusCommand(options: { port: number; json?: boolean }): Promise<void> {
  const baseUrl = `http://localhost:${options.port}`

  try {
    const res = await fetch(`${baseUrl}/admin/api/overview`)

    if (res.status === 401) {
      console.error(chalk.red('Error: Authentication required. Server is running but requires admin password.'))
      process.exit(1)
    }

    if (!res.ok) {
      console.error(chalk.red(`Error: Server responded with status ${res.status}`))
      process.exit(1)
    }

    const data = await res.json() as Record<string, unknown>

    if (options.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    console.log(chalk.bold('\n  QwenProxy Status\n'))

    if (data.uptime != null) {
      const uptime = Number(data.uptime)
      const hours = Math.floor(uptime / 3600)
      const minutes = Math.floor((uptime % 3600) / 60)
      const seconds = Math.floor(uptime % 60)
      console.log(`  ${chalk.gray('Uptime:')}       ${hours}h ${minutes}m ${seconds}s`)
    }

    if (data.totalRequests != null) {
      console.log(`  ${chalk.gray('Requests:')}     ${data.totalRequests}`)
    }

    if (data.errorRate != null) {
      const rate = Number(data.errorRate)
      const color = rate > 0.1 ? chalk.red : rate > 0.05 ? chalk.yellow : chalk.green
      console.log(`  ${chalk.gray('Error Rate:')}   ${color(`${(rate * 100).toFixed(1)}%`)}`)
    }

    if (data.activeStreams != null) {
      console.log(`  ${chalk.gray('Streams:')}      ${data.activeStreams}`)
    }

    if (data.sessions != null) {
      console.log(`  ${chalk.gray('Sessions:')}     ${data.sessions}`)
    }

    if (data.memoryUsage != null) {
      const mem = data.memoryUsage as Record<string, number>
      if (mem.rss != null) {
        console.log(`  ${chalk.gray('Memory:')}       ${(mem.rss / 1024 / 1024).toFixed(1)} MB`)
      }
    }

    if (data.accounts != null) {
      const accounts = data.accounts as Record<string, unknown>
      const total = accounts.total ?? 0
      const active = accounts.active ?? 0
      console.log(`  ${chalk.gray('Accounts:')}     ${active}/${total} active`)
    }

    console.log()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      console.error(chalk.red(`Error: Cannot connect to QwenProxy on port ${options.port}. Is the server running?`))
    } else {
      console.error(chalk.red(`Error: ${message}`))
    }
    process.exit(1)
  }
}
