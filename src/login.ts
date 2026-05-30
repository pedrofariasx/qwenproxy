import { addAccount, removeAccount, listAccounts, getAccountCredentials, QwenAccount } from './core/accounts.ts'
import { initPlaywrightForAccount, closePlaywrightForAccount, BrowserType, launchManualLoginAccount, extractAccountInfoFromContext } from './services/playwright.ts'
import * as readline from 'readline'
import * as dotenv from 'dotenv'
import { Logger } from './core/logger.js'

const logger = new Logger('info', 'Login')

dotenv.config()

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function askQuestion(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim())
    })
  })
}

function clear() {
  process.stdout.write('\x1Bc')
}

async function showMenu() {
  let browserType: BrowserType = 'chromium'
  const browserArg = process.argv.find(arg => arg.startsWith('--browser='))
  if (browserArg) {
    browserType = browserArg.split('=')[1] as BrowserType
  } else if (process.env.BROWSER) {
    browserType = process.env.BROWSER as BrowserType
  }

  while (true) {
    const accounts = listAccounts()
    clear()
    logger.info('=== QwenProxy Account Manager ===\n')

    if (accounts.length > 0) {
      logger.info(`Configured accounts (${accounts.length}):\n`)
      for (let i = 0; i < accounts.length; i++) {
        logger.info(`  [${i + 1}] ${accounts[i].email} (ID: ${accounts[i].id})`)
      }
    } else {
      logger.info('No accounts configured yet.\n')
    }

    logger.info('\nOptions:')
    logger.info('  [A] Add account (with credentials)')
    logger.info('  [M] Add account (manual browser login)')
    if (accounts.length > 0) {
      logger.info('  [R] Remove an account')
      logger.info('  [L] Login all accounts')
    }
    logger.info('  [Q] Quit\n')

    const choice = (await askQuestion('Select an option: ')).toUpperCase()

    if (choice === 'Q') {
      rl.close()
      process.exit(0)
    }

    if (choice === 'A') {
      await addAccountFlow()
      continue
    }

    if (choice === 'M') {
      await addAccountManualFlow(browserType)
      continue
    }

    if (choice === 'R' && accounts.length > 0) {
      await removeAccountFlow()
      continue
    }

    if (choice === 'L' && accounts.length > 0) {
      await loginAllAccounts(browserType)
      rl.close()
      return
    }
  }
}

async function addAccountFlow() {
  clear()
  logger.info('=== Add New Account ===\n')
  const email = await askQuestion('Email: ')
  if (!email) {
    logger.info('Email is required.')
    await askQuestion('Press Enter to continue...')
    return
  }
  const password = await askQuestion('Password: ')
  if (!password) {
    logger.info('Password is required.')
    await askQuestion('Press Enter to continue...')
    return
  }

  try {
    const account = addAccount(email, password)
    logger.info(`\nAccount added: ${account.email} (${account.id})`)
  } catch (err: any) {
    logger.info(`\nError: ${err.message}`)
  }

  await askQuestion('Press Enter to continue...')
}

async function removeAccountFlow() {
  const accounts = listAccounts()
  if (accounts.length === 0) return

  clear()
  logger.info('=== Remove Account ===\n')

  for (let i = 0; i < accounts.length; i++) {
    logger.info(`  [${i + 1}] ${accounts[i].email} (ID: ${accounts[i].id})`)
  }

  const input = await askQuestion('\nSelect account number to remove (or 0 to cancel): ')
  const idx = parseInt(input) - 1

  if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
    logger.info(input !== '0' ? 'Invalid selection.' : 'Cancelled.')
    await askQuestion('Press Enter to continue...')
    return
  }

  const account = accounts[idx]
  const confirm = await askQuestion(`\nRemove ${account.email}? (y/N): `)
  if (confirm.toLowerCase() === 'y') {
    if (removeAccount(account.id)) {
      logger.info(`Account ${account.email} removed.`)
    } else {
      logger.info('Failed to remove account.')
    }
  } else {
    logger.info('Cancelled.')
  }

  await askQuestion('Press Enter to continue...')
}

async function loginAllAccounts(browserType: BrowserType) {
  const accounts = listAccounts()
  if (accounts.length === 0) return

  clear()
  logger.info(`Logging in ${accounts.length} account(s) using ${browserType}...\n`)

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]
    const creds = getAccountCredentials(account.id)
    if (!creds || creds.password === '***') {
      logger.info(`Skipping ${account.email} - no credentials available`)
      continue
    }
    logger.info(`Processing account: ${account.email}`)
    try {
      const fullAccount: QwenAccount = {
        id: creds.id,
        email: creds.email,
        password: creds.password,
      }
      await initPlaywrightForAccount(fullAccount, true, browserType)
      logger.info(`Account ${account.email} session saved.`)
      await closePlaywrightForAccount(account.id)
    } catch (err: any) {
      logger.error(`Failed to login ${account.email}: ${err.message}`)
    }
  }

  logger.info('All accounts processed.')
  await askQuestion('Press Enter to continue...')
}

async function addAccountManualFlow(browserType: BrowserType) {
  clear()
  logger.info('=== Add Account (Manual Login) ===\n')
  logger.info('A browser window will open. Please login to Qwen manually.')
  logger.info('Once logged in, close the browser window or press Ctrl+C here.\n')
  await askQuestion('Press Enter to open the browser...')

  const crypto = await import('crypto')
  const accountId = crypto.randomUUID()

  const { context, page } = await launchManualLoginAccount(accountId, browserType)

  logger.info('\nBrowser opened. Waiting for you to login...')
  
  let loggedIn = false
  while (!loggedIn) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const { hasSession } = await extractAccountInfoFromContext(page)
    if (hasSession) {
      loggedIn = true
    }
  }

  logger.info('\nLogin detected! Extracting account info...')
  
  const extractedEmail = await askQuestion('Enter the email for this account: ')
  if (!extractedEmail) {
    logger.info('Email is required.')
    await context.close()
    await askQuestion('Press Enter to continue...')
    return
  }

  try {
    const account = addAccount(extractedEmail, '', accountId)
    logger.info(`\nAccount added: ${account.email} (${account.id})`)
  } catch (err: any) {
    logger.info(`\nError: ${err.message}`)
  }

  await context.close()
  await askQuestion('Press Enter to continue...')
}

showMenu().catch(err => {
  logger.error('Fatal error: ' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
})
