import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const projectRoot = new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, match => match.slice(1))
const forbidden = /steam-bongocat|catleftpunch|catrightpunch/i
const roots = ['dist', 'src-tauri/assets']
const matches = []

function walk(root) {
  if (!existsSync(root)) return

  for (const name of readdirSync(root)) {
    const path = join(root, name)
    const rel = relative(projectRoot, path)
    if (forbidden.test(name) || forbidden.test(rel)) matches.push(rel)
    if (statSync(path).isDirectory()) walk(path)
    else if (statSync(path).size < 2 * 1024 * 1024) {
      const text = readFileSync(path, 'utf8')
      if (forbidden.test(text)) matches.push(`${rel} (content)`)
    }
  }
}

for (const root of roots) walk(join(projectRoot, root))

if (matches.length > 0) {
  console.error('Release asset audit failed:')
  for (const match of matches) console.error(`- ${match}`)
  process.exit(1)
}

console.log('Release asset audit passed: no local-only Steam skin assets found.')
