export const BONGOCAT_UPSTREAM_LINK = 'https://github.com/ayangweb/BongoCat'
export const BONGOSTOCK_REPOSITORY_LINK = 'https://github.com/LAKiTU64/bongostock'

export const LISTEN_KEY = {
  SHOW_WINDOW: 'show-window',
  HIDE_WINDOW: 'hide-window',
  CLOSE_STOCK_PANEL: 'close-stock-panel',
  DEVICE_CHANGED: 'device-changed',
  GAMEPAD_CHANGED: 'gamepad-changed',
  WATCHLIST_CHANGED: 'watchlist-changed',
  STOCK_PANEL_SETTINGS_CHANGED: 'stock-panel-settings-changed',
  STOCK_PANEL_PIN_CHANGED: 'stock-panel-pin-changed',
  MARKET_SETTINGS_CHANGED: 'market-settings-changed',
  SKIN_CHANGED: 'skin-changed',
  START_MOTION: 'start-motion',
  SET_EXPRESSION: 'set-expression',
}

export const INVOKE_KEY = {
  COPY_DIR: 'copy_dir',
  START_DEVICE_LISTENING: 'start_device_listening',
  REQUEST_INPUT_MONITORING_ACCESS: 'request_input_monitoring_access',
  SET_MOUSE_MOVE_ENABLED: 'set_mouse_move_enabled',
  OPEN_MACOS_ACCESSIBILITY_SETTINGS: 'open_macos_accessibility_settings',
  START_GAMEPAD_LISTING: 'start_gamepad_listing',
  STOP_GAMEPAD_LISTING: 'stop_gamepad_listing',
  MARKET_REQUEST: 'market_request',
  IMPORT_SKIN_PACK: 'import_skin_pack',
  LIST_IMPORTED_SKINS: 'list_imported_skins',
  DELETE_IMPORTED_SKIN: 'delete_imported_skin',
}

export const LANGUAGE = {
  ZH_CN: 'zh-CN',
  ZH_TW: 'zh-TW',
  EN_US: 'en-US',
  VI_VN: 'vi-VN',
  PT_BR: 'pt-BR',
} as const

export const WINDOW_LABEL = {
  MAIN: 'main',
  PREFERENCE: 'preference',
  STOCK_PANEL: 'stock-panel',
} as const
