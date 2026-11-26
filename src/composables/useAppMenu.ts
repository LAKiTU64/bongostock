import { CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu'
import { exit, relaunch } from '@tauri-apps/plugin-process'
import { range } from 'es-toolkit'
import { useI18n } from 'vue-i18n'

import { flushWindowStateBeforeExit } from '@/composables/useWindowState'
import { WINDOW_LABEL } from '@/constants'
import { showWindow } from '@/plugins/window'
import { reportWindowRecoveryError, requestWindowRecovery } from '@/plugins/windowRecovery'
import { useCatStore } from '@/stores/cat'
import { isMac } from '@/utils/platform'

export function useAppMenu() {
  const catStore = useCatStore()
  const { t } = useI18n()

  const getOpacityMenuItems = async () => {
    const options = range(25, 101, 25)

    const items = options.map((item) => {
      return CheckMenuItem.new({
        text: `${item}%`,
        checked: catStore.window.opacity === item,
        action: () => {
          catStore.window.opacity = item
        },
      })
    })

    if (!options.includes(catStore.window.opacity)) {
      items.unshift(CheckMenuItem.new({
        text: `${catStore.window.opacity}%`,
        checked: true,
        enabled: false,
      }))
    }

    return Promise.all(items)
  }

  const getBaseMenu = async () => {
    return await Promise.all([
      MenuItem.new({
        text: t('composables.useAppMenu.labels.preference'),
        accelerator: isMac ? 'Cmd+,' : '',
        action: () => showWindow(WINDOW_LABEL.PREFERENCE),
      }),
      MenuItem.new({
        text: catStore.window.visible ? t('composables.useAppMenu.labels.hideCat') : t('composables.useAppMenu.labels.showCat'),
        action: () => {
          catStore.window.visible = !catStore.window.visible
        },
      }),
      MenuItem.new({
        text: t('composables.useAppMenu.labels.recoverWindows'),
        action: requestWindowRecovery,
      }),
      PredefinedMenuItem.new({ item: 'Separator' }),
      CheckMenuItem.new({
        text: t('composables.useAppMenu.labels.passThrough'),
        checked: catStore.window.passThrough,
        action: () => {
          catStore.window.passThrough = !catStore.window.passThrough
        },
      }),
      Submenu.new({
        text: t('composables.useAppMenu.labels.opacity'),
        items: await getOpacityMenuItems(),
      }),
    ])
  }

  const getExitMenu = async () => {
    return await Promise.all([
      MenuItem.new({
        text: t('composables.useAppMenu.labels.restartApp'),
        action: async () => {
          await flushWindowStateBeforeExit().catch(reportWindowRecoveryError)
          await relaunch()
        },
      }),
      MenuItem.new({
        text: t('composables.useAppMenu.labels.quitApp'),
        accelerator: isMac ? 'Cmd+Q' : '',
        action: async () => {
          await flushWindowStateBeforeExit().catch(reportWindowRecoveryError)
          await exit(0)
        },
      }),
    ])
  }

  return {
    getBaseMenu,
    getExitMenu,
  }
}
