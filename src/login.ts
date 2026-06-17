import type { QwenAccount } from './core/accounts.js';
import { addAccount, removeAccount, listAccounts, getAccountCredentials } from './core/accounts.js'
import type { BrowserType} from './services/playwright.js';
import { initPlaywrightForAccount, closePlaywrightForAccount, launchManualLoginAccount, extractAccountInfoFromContext } from './services/playwright.js'
import * as readline from 'readline'
import * as dotenv from 'dotenv'

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
    console.log('=== QwenProxy Account Manager ===\n')

    if (accounts.length > 0) {
      console.log(`Configured accounts (${accounts.length}):\n`)
      for (let i = 0; i < accounts.length; i++) {
        console.log(`  [${i + 1}] ${accounts[i].email} (ID: ${accounts[i].id})`)
      }
    } else {
      console.log('No accounts configured yet.\n')
    }

    console.log('\nOptions:')
    console.log('  [A] Add account (with credentials)')
    console.log('  [M] Add account (manual browser login)')
    if (accounts.length > 0) {
      console.log('  [R] Remove an account')
      console.log('  [L] Login all accounts')
    }
    console.log('  [Q] Quit\n')

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
  console.log('=== Add New Account ===\n')
  const email = await askQuestion('Email: ')
  if (!email) {
    console.log('Email is required.')
    await askQuestion('Press Enter to continue...')
    return
  }
  const password = await askQuestion('Password: ')
  if (!password) {
    console.log('Password is required.')
    await askQuestion('Press Enter to continue...')
    return
  }

  try {
    const account = addAccount(email, password)
    console.log(`\nAccount added: ${account.email} (${account.id})`)
  } catch (err: any) {
    console.log(`\nError: ${err.message}`)
  }

  await askQuestion('Press Enter to continue...')
}

async function removeAccountFlow() {
  const accounts = listAccounts()
  if (accounts.length === 0) return

  clear()
  console.log('=== Remove Account ===\n')

  for (let i = 0; i < accounts.length; i++) {
    console.log(`  [${i + 1}] ${accounts[i].email} (ID: ${accounts[i].id})`)
  }

  const input = await askQuestion('\nSelect account number to remove (or 0 to cancel): ')
  const idx = parseInt(input) - 1

  if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
    console.log(input !== '0' ? 'Invalid selection.' : 'Cancelled.')
    await askQuestion('Press Enter to continue...')
    return
  }

  const account = accounts[idx]
  const confirm = await askQuestion(`\nRemove ${account.email}? (y/N): `)
  if (confirm.toLowerCase() === 'y') {
    if (removeAccount(account.id)) {
      console.log(`Account ${account.email} removed.`)
    } else {
      console.log('Failed to remove account.')
    }
  } else {
    console.log('Cancelled.')
  }

  await askQuestion('Press Enter to continue...')
}

async function loginAllAccounts(browserType: BrowserType) {
  const accounts = listAccounts()
  if (accounts.length === 0) return

  clear()
  console.log(`Logging in ${accounts.length} account(s) using ${browserType}...\n`)

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]
    const creds = getAccountCredentials(account.id)
    if (!creds || creds.password === '***') {
      console.log(`[Login] Skipping ${account.email} - no credentials available`)
      continue
    }
    console.log(`[Login] Processing account: ${account.email}`)
    try {
      const fullAccount: QwenAccount = {
        id: creds.id,
        email: creds.email,
        password: creds.password,
      }
      await initPlaywrightForAccount(fullAccount, true, browserType)
      console.log(`[Login] Account ${account.email} session saved.`)
      await closePlaywrightForAccount(account.id)
    } catch (err: any) {
      console.error(`[Login] Failed to login ${account.email}: ${err.message}`)
    }
  }

  console.log('\n[Login] All accounts processed.')
  await askQuestion('Press Enter to continue...')
}

async function addAccountManualFlow(browserType: BrowserType) {
  clear()
  console.log('=== Add Account (Manual Login) ===\n')
  console.log('A browser window will open. Please login to Qwen manually.')
  console.log('Once logged in, close the browser window or press Ctrl+C here.\n')
  await askQuestion('Press Enter to open the browser...')

  const crypto = await import('crypto')
  const accountId = crypto.randomUUID()

  const { context, page } = await launchManualLoginAccount(accountId, browserType)

  console.log('\nBrowser opened. Waiting for you to login...')
  
  let loggedIn = false
  while (!loggedIn) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const { hasSession } = await extractAccountInfoFromContext(page)
    if (hasSession) {
      loggedIn = true
    }
  }

  console.log('\nLogin detected! Extracting account info...')
  
  const extractedEmail = await askQuestion('Enter the email for this account: ')
  if (!extractedEmail) {
    console.log('Email is required.')
    await context.close()
    await askQuestion('Press Enter to continue...')
    return
  }

  try {
    const account = addAccount(extractedEmail, '', accountId)
    console.log(`\nAccount added: ${account.email} (${account.id})`)
  } catch (err: any) {
    console.log(`\nError: ${err.message}`)
  }

  await context.close()
  await askQuestion('Press Enter to continue...')
}

showMenu().catch(err => {
  console.error(err)
  process.exit(1)
})
