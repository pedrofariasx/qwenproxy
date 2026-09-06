import chalk from 'chalk'

interface AccountOptions {
  port: number
  json?: boolean
}

export async function listAccounts(options: AccountOptions): Promise<void> {
  const baseUrl = `http://localhost:${options.port}`

  try {
    const res = await fetch(`${baseUrl}/admin/api/accounts`)

    if (res.status === 401) {
      console.error(chalk.red('Error: Authentication required.'))
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

    const accounts = (data.accounts ?? data) as Array<Record<string, unknown>>

    if (!Array.isArray(accounts) || accounts.length === 0) {
      console.log(chalk.yellow('No accounts configured.'))
      return
    }

    console.log(chalk.bold('\n  Accounts\n'))
    console.log(`  ${chalk.gray('ID'.padEnd(38))} ${chalk.gray('Email'.padEnd(30))} ${chalk.gray('Status')}`)
    console.log(`  ${'─'.repeat(38)} ${'─'.repeat(30)} ${'─'.repeat(10)}`)

    for (const account of accounts) {
      const id = String(account.id ?? '').slice(0, 36).padEnd(38)
      const email = String(account.email ?? '').slice(0, 28).padEnd(30)
      const status = String(account.status ?? 'unknown')
      const statusColor = status === 'active' ? chalk.green : status === 'error' ? chalk.red : chalk.yellow
      console.log(`  ${id} ${email} ${statusColor(status)}`)
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

export async function addAccount(options: AccountOptions & { email: string; password: string }): Promise<void> {
  const baseUrl = `http://localhost:${options.port}`

  try {
    const res = await fetch(`${baseUrl}/admin/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: options.email, password: options.password })
    })

    if (res.status === 401) {
      console.error(chalk.red('Error: Authentication required.'))
      process.exit(1)
    }

    if (!res.ok) {
      const body = await res.text()
      console.error(chalk.red(`Error: ${body || `Server responded with status ${res.status}`}`))
      process.exit(1)
    }

    const data = await res.json() as Record<string, unknown>

    if (options.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    console.log(chalk.green(`Account added: ${options.email}`))
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

export async function removeAccount(options: AccountOptions & { id: string }): Promise<void> {
  const baseUrl = `http://localhost:${options.port}`

  try {
    const res = await fetch(`${baseUrl}/admin/api/accounts/${options.id}`, {
      method: 'DELETE'
    })

    if (res.status === 401) {
      console.error(chalk.red('Error: Authentication required.'))
      process.exit(1)
    }

    if (!res.ok) {
      const body = await res.text()
      console.error(chalk.red(`Error: ${body || `Server responded with status ${res.status}`}`))
      process.exit(1)
    }

    if (options.json) {
      console.log(JSON.stringify({ success: true, id: options.id }))
      return
    }

    console.log(chalk.green(`Account removed: ${options.id}`))
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
