import 'dotenv/config'
import { startServer, serverPort, type ServerOverrides } from './api/server.js'
import { tuiCommand } from './cli/commands/tui.js'

export async function run(overrides?: ServerOverrides): Promise<void> {
  startServer({ ...overrides, quiet: true }).catch(console.error)

  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (serverPort > 0) {
        clearInterval(check)
        resolve()
      }
    }, 50)
  })

  await tuiCommand({ port: serverPort }).catch(console.error)
}

run().catch(error => {
  console.error('Failed to start:', error)
  process.exit(1)
})
