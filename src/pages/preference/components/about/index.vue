<script setup lang="ts">
import { getTauriVersion } from '@tauri-apps/api/app'
import { appLogDir } from '@tauri-apps/api/path'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { openPath } from '@tauri-apps/plugin-opener'
import { arch, platform, version } from '@tauri-apps/plugin-os'
import { message } from 'antdv-next'
import { useI18n } from 'vue-i18n'

import ProList from '@/components/pro-list/index.vue'
import { BONGOCAT_UPSTREAM_LINK, BONGOSTOCK_REPOSITORY_LINK } from '@/constants'
import { useAppStore } from '@/stores/app'

import license from '../../../../../LICENSE?raw'

const app = useAppStore()
const { t } = useI18n()
const repositoryName = new URL(BONGOSTOCK_REPOSITORY_LINK).pathname.slice(1)
const links = [
  { label: 'BongoCat · ayangweb', href: BONGOCAT_UPSTREAM_LINK },
  { label: 'Awesome-BongoCat · MMmmmoko', href: 'https://github.com/ayangweb/Awesome-BongoCat' },
]

async function copyInfo() {
  try {
    await writeText(JSON.stringify({
      appName: app.name,
      appVersion: app.version,
      tauriVersion: await getTauriVersion(),
      platform: platform(),
      platformArch: arch(),
      platformVersion: version(),
    }, null, 2))
    message.success(t('pages.preference.about.hints.copySuccess'))
  } catch (error) {
    message.error(String(error))
  }
}

async function openLogs() {
  try {
    await openPath(await appLogDir())
  } catch (error) {
    message.error(String(error))
  }
}
</script>

<template>
  <section class="settings-group about-app">
    <img
      alt=""
      src="/logo.png"
    >
    <div class="about-identity">
      <strong>{{ app.name }}</strong>
      <span>v{{ app.version }}</span>
    </div>
    <button
      :aria-label="t('pages.preference.about.buttons.copy')"
      class="settings-button"
      :title="t('pages.preference.about.buttons.copy')"
      type="button"
      @click="copyInfo"
    >
      <i
        aria-hidden="true"
        class="i-lucide:copy"
      />
    </button>
  </section>
  <div class="settings-group about-tools">
    <a
      class="settings-row about-link"
      :href="BONGOSTOCK_REPOSITORY_LINK"
    >
      <span class="about-source">
        {{ t('pages.preference.about.labels.source') }}
        <small class="settings-row-detail">{{ repositoryName }}</small>
      </span>
      <i
        aria-hidden="true"
        class="i-lucide:arrow-up-right"
      />
    </a>
    <button
      class="settings-row about-link"
      type="button"
      @click="openLogs"
    >
      {{ t('pages.preference.about.labels.appLog') }}
      <i
        aria-hidden="true"
        class="i-lucide:folder-open"
      />
    </button>
  </div>
  <ProList :title="t('pages.preference.about.labels.licenses')">
    <details class="about-license">
      <summary class="settings-row about-link">
        MIT License
        <i
          aria-hidden="true"
          class="i-lucide:chevron-right"
        />
      </summary>
      <pre>{{ license.trim() }}</pre>
    </details>
    <a
      v-for="item in links"
      :key="item.href"
      class="settings-row about-link"
      :href="item.href"
    >
      {{ item.label }}
      <i
        aria-hidden="true"
        class="i-lucide:arrow-up-right"
      />
    </a>
    <a
      class="settings-row about-link"
      :href="`${BONGOSTOCK_REPOSITORY_LINK}/blob/HEAD/THIRD_PARTY_NOTICES.md`"
    >
      {{ t('pages.preference.about.labels.thirdParty') }}
      <i
        aria-hidden="true"
        class="i-lucide:arrow-up-right"
      />
    </a>
  </ProList>
</template>

<style scoped>
.about-app {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 15px;
}
.about-app img {
  box-sizing: border-box;
  border: 1px solid var(--settings-line);
  border-radius: 9px;
  width: 42px;
  height: 42px;
  object-fit: contain;
}
.about-identity {
  display: grid;
  flex: 1;
}
.about-identity strong {
  font-size: 18px;
}
.about-identity span {
  color: var(--settings-muted);
  font-variant-numeric: tabular-nums;
}
.about-tools {
  margin: 12px 0 22px;
}
.about-source {
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
}
.about-source small {
  margin: 0;
}
.about-link {
  width: 100%;
  border: 0;
  color: var(--settings-ink);
  background: var(--settings-surface);
  font: inherit;
  text-align: start;
  text-decoration: none;
  cursor: pointer;
}
.about-link + .about-link,
.about-license + .about-link {
  border-top: 1px solid var(--settings-line);
}
.about-link:hover {
  background: var(--settings-subtle);
}
.about-link i {
  width: 15px;
  height: 15px;
  color: var(--settings-muted);
}
.about-license summary {
  list-style: none;
}
.about-license summary::-webkit-details-marker {
  display: none;
}
.about-license[open] summary i {
  transform: rotate(90deg);
}
.about-license pre {
  margin: 0;
  padding: 3px 15px 15px;
  color: var(--settings-muted);
  white-space: pre-wrap;
  font:
    12px/1.5 ui-monospace,
    monospace;
  user-select: text;
}
</style>
