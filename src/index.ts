import 'dotenv/config'
import { startServer, serverPort, type ServerOverrides } from './api/server.js'
import { tuiCommand } from './cli/commands/tui.js'

export async function run(overrides?: ServerOverrides): Promise<void> {
  await startServer({ ...overrides, quiet: true })
  await tuiCommand({ port: serverPort })
}

run().catch(error => {
  console.error('Failed to start:', error)
  process.exit(1)
})
