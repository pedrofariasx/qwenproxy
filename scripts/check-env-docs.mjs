import fs from 'node:fs'

const config = fs.readFileSync('src/core/config.ts', 'utf8')
const example = fs.readFileSync('.env.example', 'utf8')
const schemaKeys = [...config.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map(match => match[1])
const documentedKeys = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]))
const missing = schemaKeys.filter(key => !documentedKeys.has(key))

if (missing.length > 0) {
  console.error(`Missing configuration keys in .env.example: ${missing.join(', ')}`)
  process.exit(1)
}

console.log(`Configuration documentation is complete (${schemaKeys.length} schema keys).`)
