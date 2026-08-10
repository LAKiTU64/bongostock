import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

if (process.platform !== 'darwin') {
  throw new Error('The macOS debug signer can only run on macOS')
}

const cargoTargetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : resolve('src-tauri/target')
const appPath = resolve(cargoTargetDir, 'debug/bundle/macos/BongoStock.app')

execFileSync('codesign', [
  '--force',
  '--deep',
  '--sign',
  '-',
  '--identifier',
  'com.bongostock.desktop',
  '--requirements',
  '=designated => identifier "com.bongostock.desktop"',
  appPath,
], { stdio: 'inherit' })

execFileSync('codesign', [
  '--verify',
  '--deep',
  '--strict',
  '--verbose=2',
  appPath,
], { stdio: 'inherit' })
