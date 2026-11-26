import { isMac, isWindows } from './platform'

export interface Key {
  eventKey: string
  tauriKey?: string
  symbol?: string
}

export const modifierKeys: Key[] = [
  {
    eventKey: 'Shift',
    symbol: isMac ? '⇧' : 'Shift',
  },
  {
    eventKey: 'Control',
    symbol: isMac ? '⌃' : 'Ctrl',
  },
  {
    eventKey: 'Alt',
    symbol: isMac ? '⌥' : 'Alt',
  },
  {
    eventKey: 'Command',
    symbol: isMac ? '⌘' : 'Super',
  },
].map((item) => {
  return { ...item, tauriKey: item.eventKey }
})

export const standardKeys: Key[] = [
  // 第一排
  {
    eventKey: 'Escape',
    symbol: isMac ? '⎋' : 'Esc',
  },
  ...Array.from({ length: isMac ? 20 : 24 }, (_, index) => ({
    eventKey: `F${index + 1}`,
  })),
  // 第二排
  {
    eventKey: 'Backquote',
    symbol: '`',
  },
  {
    eventKey: 'Digit1',
  },
  {
    eventKey: 'Digit2',
  },
  {
    eventKey: 'Digit3',
  },
  {
    eventKey: 'Digit4',
  },
  {
    eventKey: 'Digit5',
  },
  {
    eventKey: 'Digit6',
  },
  {
    eventKey: 'Digit7',
  },
  {
    eventKey: 'Digit8',
  },
  {
    eventKey: 'Digit9',
  },
  {
    eventKey: 'Digit0',
  },
  {
    eventKey: 'Minus',
    tauriKey: '-',
    symbol: '-',
  },
  {
    eventKey: 'Equal',
    tauriKey: '=',
    symbol: '=',
  },
  {
    eventKey: 'Backspace',
    symbol: isMac ? '⌫' : void 0,
  },
  // 第三排
  {
    eventKey: 'Tab',
    symbol: isMac ? '⇥' : void 0,
  },
  {
    eventKey: 'KeyQ',
  },
  {
    eventKey: 'KeyW',
  },
  {
    eventKey: 'KeyE',
  },
  {
    eventKey: 'KeyR',
  },
  {
    eventKey: 'KeyT',
  },
  {
    eventKey: 'KeyY',
  },
  {
    eventKey: 'KeyU',
  },
  {
    eventKey: 'KeyI',
  },
  {
    eventKey: 'KeyO',
  },
  {
    eventKey: 'KeyP',
  },
  {
    eventKey: 'BracketLeft',
    symbol: '[',
  },
  {
    eventKey: 'BracketRight',
    symbol: ']',
  },
  {
    eventKey: 'Backslash',
    symbol: '\\',
  },
  // 第四排
  {
    eventKey: 'KeyA',
  },
  {
    eventKey: 'KeyS',
  },
  {
    eventKey: 'KeyD',
  },
  {
    eventKey: 'KeyF',
  },
  {
    eventKey: 'KeyG',
  },
  {
    eventKey: 'KeyH',
  },
  {
    eventKey: 'KeyJ',
  },
  {
    eventKey: 'KeyK',
  },
  {
    eventKey: 'KeyL',
  },
  {
    eventKey: 'Semicolon',
    symbol: ';',
  },
  {
    eventKey: 'Quote',
    symbol: '\'',
  },
  {
    eventKey: 'Enter',
    symbol: isMac ? '↩︎' : void 0,
  },
  // 第五排
  {
    eventKey: 'KeyZ',
  },
  {
    eventKey: 'KeyX',
  },
  {
    eventKey: 'KeyC',
  },
  {
    eventKey: 'KeyV',
  },
  {
    eventKey: 'KeyB',
  },
  {
    eventKey: 'KeyN',
  },
  {
    eventKey: 'KeyM',
  },
  {
    eventKey: 'Comma',
    symbol: ',',
  },
  {
    eventKey: 'Period',
    symbol: '.',
  },
  {
    eventKey: 'Slash',
    symbol: '/',
  },
  // 第六排
  {
    eventKey: 'Space',
    symbol: isMac ? '␣' : void 0,
  },
  // Extended PC keyboard. Keep keypad digits distinct from the typing row.
  { eventKey: 'Insert' },
  { eventKey: 'PrintScreen' },
  { eventKey: 'CapsLock' },
  { eventKey: 'NumLock' },
  ...(!isMac
    ? [
        { eventKey: 'ScrollLock' },
        { eventKey: 'Pause' },
      ]
    : []),
  ...Array.from({ length: 10 }, (_, index) => ({
    eventKey: `Numpad${index}`,
  })),
  ...['Add', 'Subtract', 'Multiply', 'Divide', 'Decimal'].map(operation => ({
    eventKey: `Numpad${operation}`,
  })),
  // The Win32 hotkey backend aliases keypad Enter and Equal to Return and E.
  ...(!isWindows
    ? [
        { eventKey: 'NumpadEnter' },
        { eventKey: 'NumpadEqual' },
      ]
    : []),
  ...['Home', 'End', 'PageUp', 'PageDown', 'Delete'].map(eventKey => ({ eventKey })),
  // 方向键
  {
    eventKey: 'ArrowUp',
    symbol: '↑',
  },
  {
    eventKey: 'ArrowDown',
    symbol: '↓',
  },
  {
    eventKey: 'ArrowLeft',
    symbol: '←',
  },
  {
    eventKey: 'ArrowRight',
    symbol: '→',
  },
].map((item: Key) => {
  const { eventKey } = item

  item.symbol ??= eventKey
  item.tauriKey ??= eventKey

  if (eventKey.startsWith('Digit') || eventKey.startsWith('Key')) {
    item.tauriKey = item.symbol = eventKey.slice(-1)
  }

  return item
})

export const keys = modifierKeys.concat(standardKeys)

// AppKit identifies the PC Insert position as Help. Prefer the physical code
// when available, as some PC keyboards deliver the top cluster as F13–F15.
export function findShortcutKey(event: KeyboardEvent) {
  let code = event.code
  if (!code || code === 'Unidentified') {
    // Never fall back to a layout-dependent letter or digit.
    if (/^F\d+$/.test(event.key) || ['PrintScreen', 'Help', 'Insert', 'Pause', 'ScrollLock'].includes(event.key)) {
      code = event.key
    }
  }
  if (isMac && code === 'Help') code = 'Insert'
  return standardKeys.find(key => key.eventKey === code)
}
