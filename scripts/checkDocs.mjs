import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function read(relativePath) {
  return readFileSync(join(projectRoot, relativePath), 'utf8')
}

const packageJson = JSON.parse(read('package.json'))
const version = packageJson.version
const scriptNames = new Set(Object.keys(packageJson.scripts))

// 1. 版本号：package.json 是唯一事实来源，其余位置必须与之一致。
const cargoVersion = read('src-tauri/Cargo.toml').match(/^version = "(.+)"$/m)?.[1]

if (cargoVersion !== version)
  failures.push(`src-tauri/Cargo.toml 的 version 是 ${cargoVersion}，package.json 是 ${version}`)

const versionClaims = [
  ['README.md', /^- 当前版本：`(.+?)`$/m],
  ['docs/PROJECT_HANDOFF.md', /^- 应用版本：`(.+?)`$/m],
  ['HANDOFF_PROMPT.md', /^版本：(.+)$/m],
]

for (const [file, pattern] of versionClaims) {
  const claimed = read(file).match(pattern)?.[1]

  if (claimed === undefined) failures.push(`${file} 找不到版本号声明，模式：${pattern}`)
  else if (claimed !== version) failures.push(`${file} 声明版本 ${claimed}，package.json 是 ${version}`)
}

if (!read('CHANGELOG.md').includes(`## ${version} `))
  failures.push(`CHANGELOG.md 缺少 ${version} 的条目`)

// 2. 文档里写的 pnpm 脚本必须真实存在，避免脚本改名后文档留下死命令。
const docFiles = ['README.md', 'HANDOFF_PROMPT.md', 'CHANGELOG.md', 'docs/CLIENT_DEPLOYMENT.md', 'docs/PROJECT_HANDOFF.md', 'docs/DEVICE_TRANSFER_CHECKLIST.md']
const scriptReference = /\bpnpm (?:run )?([a-z][\w:-]*)/g
// pnpm 的内置命令和直通命令不是 package.json 脚本。
const passthrough = new Set(['install', 'exec', 'tauri', 'run', 'add', 'remove', 'up', 'why', 'store', 'dlx', 'create', 'test'])

for (const file of docFiles) {
  if (!existsSync(join(projectRoot, file))) {
    failures.push(`文档 ${file} 不存在`)
    continue
  }

  for (const [, name] of read(file).matchAll(scriptReference)) {
    if (passthrough.has(name) || scriptNames.has(name)) continue

    failures.push(`${file} 引用了不存在的 pnpm 脚本 ${name}`)
  }
}

// 3. 默认外接服务地址：代码与协议文档必须一致。
const defaultBaseUrl = read('src/stores/market.ts').match(/DEFAULT_BASE_URL = '(.+?)'/)?.[1]
const documentedBaseUrl = read('docs/EXTERNAL_MARKET_API_V1.md').match(/默认示例为 `(.+?)`/)?.[1]

if (!defaultBaseUrl) failures.push('src/stores/market.ts 找不到 DEFAULT_BASE_URL')
else if (defaultBaseUrl !== documentedBaseUrl)
  failures.push(`默认服务地址不一致：代码 ${defaultBaseUrl}，EXTERNAL_MARKET_API_V1.md ${documentedBaseUrl}`)

// 4. 默认地址不得指向个人服务器：公开仓库不应内置任何真实主机。
if (defaultBaseUrl && !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(defaultBaseUrl))
  failures.push(`默认服务地址 ${defaultBaseUrl} 不是本机地址，公开仓库不应内置真实主机`)

if (failures.length > 0) {
  console.error('文档一致性检查未通过：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`文档一致性检查通过：版本 ${version}，默认服务地址 ${defaultBaseUrl}`)
