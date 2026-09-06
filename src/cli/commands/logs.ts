import chalk from 'chalk'

interface LogsOptions {
  port: number
  follow?: boolean
  level?: string
}

export async function logsCommand(options: LogsOptions): Promise<void> {
  const baseUrl = `http://localhost:${options.port}`

  if (options.follow) {
    await followLogs(baseUrl, options.level)
    return
  }

  try {
    const params = new URLSearchParams()
    if (options.level) params.set('level', options.level)
    const query = params.toString()
    const url = `${baseUrl}/admin/api/logs${query ? `?${query}` : ''}`

    const res = await fetch(url)

    if (res.status === 401) {
      console.error(chalk.red('Error: Authentication required.'))
      process.exit(1)
    }

    if (!res.ok) {
      console.error(chalk.red(`Error: Server responded with status ${res.status}`))
      process.exit(1)
    }

    const raw = await res.json() as unknown
    const logs = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>).logs as Array<Record<string, unknown>>) ?? []

    if (logs.length === 0) {
      console.log(chalk.yellow('No logs available.'))
      return
    }

    for (const entry of logs) {
      printLogEntry(entry)
    }
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

async function followLogs(baseUrl: string, level?: string): Promise<void> {
  const params = new URLSearchParams()
  if (level) params.set('level', level)
  const query = params.toString()
  const url = `${baseUrl}/admin/api/logs/live${query ? `?${query}` : ''}`

  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' }
    })

    if (res.status === 401) {
      console.error(chalk.red('Error: Authentication required.'))
      process.exit(1)
    }

    if (!res.ok) {
      console.error(chalk.red(`Error: Server responded with status ${res.status}`))
      process.exit(1)
    }

    if (!res.body) {
      console.error(chalk.red('Error: No response body for SSE stream.'))
      process.exit(1)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const entry = JSON.parse(line.slice(6)) as Record<string, unknown>
            printLogEntry(entry)
          } catch {
            // ignore malformed SSE data
          }
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      console.error(chalk.red(`Error: Cannot connect to QwenProxy on port ${baseUrl.split(':')[2]?.split('/')[0] ?? 'unknown'}. Is the server running?`))
    } else {
      console.error(chalk.red(`Error: ${message}`))
    }
    process.exit(1)
  }
}

function printLogEntry(entry: Record<string, unknown>): void {
  const timestamp = entry.timestamp ?? entry.time ?? ''
  const level = String(entry.level ?? 'info').toUpperCase().padEnd(5)
  const message = entry.message ?? entry.msg ?? ''

  let levelColor: (s: string) => string
  switch (String(entry.level ?? 'info').toLowerCase()) {
    case 'error': levelColor = chalk.red; break
    case 'warn': levelColor = chalk.yellow; break
    case 'debug': levelColor = chalk.gray; break
    default: levelColor = chalk.cyan
  }

  console.log(`${chalk.gray(String(timestamp))} ${levelColor(level)} ${message}`)
}
