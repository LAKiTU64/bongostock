// Match the canonical names emitted by the macOS HID monitor. The labels
// follow familiar PC key legends so a saved binding is easy to recognize.
const shortcutHidLabels = {
  LaunchApp2: 'CAL',
  PrintScreen: 'Print Screen',
  ScrollLock: 'Scroll Lock',
  Pause: 'Pause',
  ContextMenu: 'Menu',
  LaunchApp1: 'My Computer',
  LaunchFileBrowser: 'File Manager',
  LaunchMail: 'Mail',
  BrowserHome: 'Home Page',
  LaunchWebBrowser: 'Browser',
  BrowserSearch: 'Search',
  BrowserFavorites: 'Favorites',
  MediaSelect: 'Media',
} as const
export type ShortcutHidKey = keyof typeof shortcutHidLabels

export function isShortcutHidKey(value: string): value is ShortcutHidKey {
  return Object.prototype.hasOwnProperty.call(shortcutHidLabels, value)
}

export function shortcutHidLabel(key: ShortcutHidKey) {
  return shortcutHidLabels[key]
}

// A PC keyboard can send both a raw usage and a macOS function-key event
// for one press. Prevent assigning that press to two different actions.
export function shortcutAlias(value: string) {
  if (value === 'PrintScreen') return 'F13'
  if (value === 'ScrollLock') return 'F14'
  if (value === 'Pause') return 'F15'
  return value
}

export function isPcFunctionAlias(value: string) {
  return value === 'F13' || value === 'F14' || value === 'F15'
}
