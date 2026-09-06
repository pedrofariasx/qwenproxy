#!/usr/bin/env node
import { Command } from 'commander'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgPath = path.resolve(__dirname, '..', 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

const program = new Command()

program
  .name('qwenproxy')
  .description('QwenProxy CLI - OpenAI-compatible proxy for Qwen')
  .version(pkg.version)
  .option('--port <port>', 'Port to run the server on')
  .option('--browser <browser>', 'Browser to use (chromium or firefox)')
  .option('--config <path>', 'Path to config file')
  .option('--verbose', 'Enable verbose output')
  .option('--quiet', 'Suppress startup banner')
  .option('--json', 'Output in JSON format')

program
  .command('status')
  .description('Check server health and status')
  .action(async () => {
    const opts = program.opts()
    const port = parseInt(opts.port || process.env.PORT || '3000', 10)
    const { statusCommand } = await import('../dist/cli/commands/status.js')
    await statusCommand({ port, json: opts.json })
  })

const accountsCmd = program
  .command('accounts')
  .description('Manage accounts')

accountsCmd
  .command('list')
  .description('List all accounts')
  .action(async () => {
    const opts = program.opts()
    const port = parseInt(opts.port || process.env.PORT || '3000', 10)
    const { listAccounts } = await import('../dist/cli/commands/accounts.js')
    await listAccounts({ port, json: opts.json })
  })

accountsCmd
  .command('add <email> <password>')
  .description('Add a new account')
  .action(async (email, password) => {
    const opts = program.opts()
    const port = parseInt(opts.port || process.env.PORT || '3000', 10)
    const { addAccount } = await import('../dist/cli/commands/accounts.js')
    await addAccount({ port, email, password, json: opts.json })
  })

accountsCmd
  .command('remove <id>')
  .description('Remove an account')
  .action(async (id) => {
    const opts = program.opts()
    const port = parseInt(opts.port || process.env.PORT || '3000', 10)
    const { removeAccount } = await import('../dist/cli/commands/accounts.js')
    await removeAccount({ port, id, json: opts.json })
  })

program
  .command('logs')
  .description('View server logs')
  .option('--follow', 'Follow log output in real-time')
  .option('--level <level>', 'Filter by log level')
  .action(async (cmdOpts) => {
    const opts = program.opts()
    const port = parseInt(opts.port || process.env.PORT || '3000', 10)
    const { logsCommand } = await import('../dist/cli/commands/logs.js')
    await logsCommand({ port, follow: cmdOpts.follow, level: cmdOpts.level })
  })

program
  .command('tui')
  .description('Interactive terminal UI')
  .action(async () => {
    const opts = program.opts()
    const port = parseInt(opts.port || process.env.PORT || '3000', 10)
    const { tuiCommand } = await import('../dist/cli/commands/tui.js')
    await tuiCommand({ port })
  })

program
  .action(async () => {
    const opts = program.opts()
    const overrides = {}
    if (opts.port) overrides.port = parseInt(opts.port, 10)
    if (opts.browser) overrides.browser = opts.browser
    if (opts.quiet) overrides.quiet = true

    const script = path.join(__dirname, '..', 'dist', 'index.js')
    const mod = await import(script)
    if (mod.run) {
      await mod.run(overrides)
    }
  })

program.parse()
