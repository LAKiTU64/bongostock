<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { resolveResource } from '@tauri-apps/api/path'
import { readDir } from '@tauri-apps/plugin-fs'
import { error as logError } from '@tauri-apps/plugin-log'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import type { ImportedSkin } from '@/skins/skinService'
import type { CatSkin } from '@/stores/cat'

import { skinAssetUrl } from '@/skins/skinService'
import { getBuiltinSkin } from '@/stores/skin'
import { join } from '@/utils/path'

type Live2d = typeof import('@/utils/live2d').default
interface Live2dCore {
  Version?: {
    csmGetVersion?: () => number
  }
}

const props = defineProps<{
  count: number
  leftPawDown: boolean
  rightPawDown: boolean
  mouseLeftDown: boolean
  mouseRightDown: boolean
  pressedKeys: string[]
  skin: CatSkin
  importedSkin?: ImportedSkin
}>()

const emit = defineEmits<{
  menu: [event: MouseEvent]
}>()

const formattedCount = computed(() => new Intl.NumberFormat('en-US')
  .format(props.count)
  .replaceAll(',', ' '))
const canvas = ref<HTMLCanvasElement>()
const container = ref<HTMLElement>()
const scene = ref<HTMLElement>()
const builtinModelSize = ref<{ width: number, height: number }>()
const builtinSkin = computed(() => getBuiltinSkin(props.skin))
const isBuiltinSkin = computed(() => Boolean(builtinSkin.value))
const sceneHeight = computed(() => isBuiltinSkin.value ? '76.5%' : '68.7%')
const backgroundUrl = ref('')
const keyOverlayUrls = ref<{ left: Record<string, string>, right: Record<string, string> }>({ left: {}, right: {} })
const importedAssets = computed(() => {
  if (!props.importedSkin) return undefined

  return {
    leftIdle: skinAssetUrl(props.importedSkin.leftIdlePath),
    leftPunch: skinAssetUrl(props.importedSkin.leftPunchPath),
    rightIdle: skinAssetUrl(props.importedSkin.rightIdlePath),
    rightPunch: skinAssetUrl(props.importedSkin.rightPunchPath),
  }
})
const importedLayerStyle = computed(() => ({
  top: props.importedSkin?.layout.top ?? '-49%',
  left: props.importedSkin?.layout.left ?? '-12%',
  width: props.importedSkin?.layout.width ?? '107%',
}))
const activeKeyOverlayUrls = computed(() => {
  const urls: string[] = []

  // BongoCat keeps at most one highlighted key per paw. When another key for
  // the same paw is pressed, the newer key replaces the previous overlay.
  for (const side of ['left', 'right'] as const) {
    for (let index = props.pressedKeys.length - 1; index >= 0; index -= 1) {
      const url = keyOverlayUrls.value[side][props.pressedKeys[index]]

      if (!url) continue

      urls.push(url)
      break
    }
  }

  return urls
})
let loadVersion = 0
let live2d: Live2d | undefined
let live2dLoad: Promise<Live2d> | undefined
let live2dCoreLoad: Promise<void> | undefined

function getLive2dCore() {
  return (globalThis as typeof globalThis & { Live2DCubismCore?: Live2dCore }).Live2DCubismCore
}

function isLive2dCoreReady() {
  const getVersion = getLive2dCore()?.Version?.csmGetVersion

  if (typeof getVersion !== 'function') return false

  try {
    getVersion()
    return true
  } catch {
    return false
  }
}

function loadLive2dCoreScript() {
  if (getLive2dCore()) return Promise.resolve()

  live2dCoreLoad ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-bongostock-live2d-core]')
    const script = existing ?? document.createElement('script')

    if (!existing) {
      script.dataset.bongostockLive2dCore = 'true'
      script.src = '/js/live2dcubismcore.min.js'
      script.async = true
    }

    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error('Live2D core failed to load')), { once: true })

    if (!existing) document.head.append(script)
  })

  return live2dCoreLoad
}

async function loadLive2dCore() {
  if (isLive2dCoreReady()) return

  await loadLive2dCoreScript()

  const deadline = Date.now() + 5_000

  while (!isLive2dCoreReady() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 16))
  }

  if (!isLive2dCoreReady()) throw new Error('Live2D core is not ready')
}

async function loadLive2d() {
  if (live2d) return Promise.resolve(live2d)

  live2dLoad ??= (async () => {
    await loadLive2dCore()
    const module = await import('@/utils/live2d')

    live2d = module.default
    return module.default
  })()

  return live2dLoad
}

async function loadBuiltinSkin() {
  const version = ++loadVersion

  try {
    await nextTick()

    const skin = builtinSkin.value
    if (!canvas.value || !scene.value || !skin) return

    const modelPath = await resolveResource(skin.modelPath)
    const runtime = await loadLive2d()
    const { width, height } = await runtime.load(modelPath, canvas.value)

    if (version !== loadVersion || !builtinSkin.value) {
      runtime.destroy()
      return
    }

    builtinModelSize.value = { width, height }
    backgroundUrl.value = convertFileSrc(join(modelPath, 'resources', 'background.png'))
    keyOverlayUrls.value = await loadKeyOverlays(modelPath, skin.keyResources)
    void resizeBuiltinSkin()
    void syncBuiltinInput()
  } catch (error) {
    logError(`[skin] Failed to load BongoCat model: ${String(error)}`)
  }
}

async function loadKeyOverlays(modelPath: string, allowed: { left: string[], right: string[] }) {
  const result: { left: Record<string, string>, right: Record<string, string> } = { left: {}, right: {} }

  for (const side of ['left', 'right'] as const) {
    const directory = join(modelPath, 'resources', `${side}-keys`)
    const files = await readDir(directory).catch(() => [])

    for (const file of files) {
      if (!file.name?.toLowerCase().endsWith('.png')) continue
      const key = file.name.slice(0, -4)
      if (!allowed[side].includes(key)) continue
      result[side][key] = convertFileSrc(join(directory, file.name))
    }
  }

  return result
}

async function resizeBuiltinSkin() {
  if (!builtinModelSize.value || !scene.value) return

  const bounds = scene.value.getBoundingClientRect()
  const runtime = await loadLive2d()

  runtime.resizeModel(builtinModelSize.value, {
    centerX: bounds.left + bounds.width * 0.5,
    centerY: bounds.top + bounds.height * 0.5,
    fitHeight: bounds.height,
    fitWidth: bounds.width,
  })
}

async function syncBuiltinInput() {
  if (!isBuiltinSkin.value) return

  const runtime = await loadLive2d()
  if (!isBuiltinSkin.value) return

  // Match upstream BongoCat: keyboard resources decide which paw moves, while
  // mouse buttons use the model's dedicated mouse parameters. The alternating
  // pulse props are retained only for BongoStock's imported bitmap skins.
  const leftDown = props.pressedKeys.some(key => key in keyOverlayUrls.value.left)
  const rightDown = props.pressedKeys.some(key => key in keyOverlayUrls.value.right)

  runtime.setParameterValue('CatParamLeftHandDown', leftDown)
  runtime.setParameterValue('CatParamRightHandDown', rightDown)
  runtime.setParameterValue('ParamMouseLeftDown', props.mouseLeftDown)
  runtime.setParameterValue('ParamMouseRightDown', props.mouseRightDown)
}

function handleResize() {
  void resizeBuiltinSkin()
}

watch([() => props.skin, () => props.importedSkin], ([skin]) => {
  if (getBuiltinSkin(skin)) {
    backgroundUrl.value = ''
    keyOverlayUrls.value = { left: {}, right: {} }
    void loadBuiltinSkin()
    return
  }

  ++loadVersion
  builtinModelSize.value = undefined
  backgroundUrl.value = ''
  keyOverlayUrls.value = { left: {}, right: {} }
  live2d?.destroy()
})

watch(() => [
  props.leftPawDown,
  props.rightPawDown,
  props.mouseLeftDown,
  props.mouseRightDown,
  props.pressedKeys,
], () => {
  void syncBuiltinInput()
}, { deep: true })

onMounted(() => {
  globalThis.addEventListener('resize', handleResize)

  if (isBuiltinSkin.value) void loadBuiltinSkin()
})

onUnmounted(() => {
  ++loadVersion
  globalThis.removeEventListener('resize', handleResize)
  live2d?.destroy()
})
</script>

<template>
  <div
    ref="container"
    aria-label="BongoStock click counter cat"
    class="compact-cat"
    role="img"
    :style="{ '--scene-height': sceneHeight }"
  >
    <div
      v-if="isBuiltinSkin"
      ref="scene"
      class="builtin-scene"
    >
      <img
        v-if="backgroundUrl"
        alt=""
        class="builtin-background"
        draggable="false"
        :src="backgroundUrl"
      >
    </div>

    <canvas
      v-show="isBuiltinSkin"
      ref="canvas"
      class="github-cat-layer"
    />

    <img
      v-for="url in activeKeyOverlayUrls"
      :key="url"
      alt=""
      class="builtin-key-layer"
      draggable="false"
      :src="url"
    >

    <img
      v-if="importedAssets"
      alt=""
      class="cat-layer"
      :class="{ 'is-punching': leftPawDown }"
      draggable="false"
      :src="leftPawDown ? importedAssets.leftPunch : importedAssets.leftIdle"
      :style="importedLayerStyle"
    >
    <img
      v-if="importedAssets"
      alt=""
      class="cat-layer"
      :class="{ 'is-punching': rightPawDown }"
      draggable="false"
      :src="rightPawDown ? importedAssets.rightPunch : importedAssets.rightIdle"
      :style="importedLayerStyle"
    >

    <div class="counter-box">
      {{ formattedCount }}
    </div>

    <button
      aria-label="打开菜单"
      class="menu-button"
      type="button"
      @click.stop="emit('menu', $event)"
      @pointerdown.stop
    >
      <svg
        aria-hidden="true"
        class="menu-icon"
        viewBox="0 0 24 24"
      >
        <rect
          height="2.625"
          rx="1.3125"
          width="14.25"
          x="4.875"
          y="4.9375"
        />
        <rect
          height="2.625"
          rx="1.3125"
          width="14.25"
          x="4.875"
          y="10.6875"
        />
        <rect
          height="2.625"
          rx="1.3125"
          width="14.25"
          x="4.875"
          y="16.4375"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.compact-cat {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: visible;
  user-select: none;
}

.builtin-scene,
.builtin-key-layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: var(--scene-height);
}

.builtin-scene {
  z-index: 0;
  overflow: hidden;
}

.builtin-background,
.builtin-key-layer {
  object-fit: cover;
  pointer-events: none;
  user-select: none;
}

.builtin-background {
  width: 100%;
  height: 100%;
}

.builtin-key-layer {
  z-index: 2;
  height: var(--scene-height);
}

.cat-layer {
  position: absolute;
  z-index: 1;
  top: -49%;
  left: -12%;
  width: 107%;
  height: auto;
  pointer-events: none;
  user-select: none;
}

.github-cat-layer {
  position: fixed;
  z-index: 1;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.cat-layer.is-punching {
  /* StrayRogue's lowered paw must overlap the counter/menu frames. */
  z-index: 5;
}

.counter-box,
.menu-button {
  position: absolute;
  z-index: 4;
  top: calc(var(--scene-height) + 2px);
  box-sizing: border-box;
  height: calc(100% - var(--scene-height) - 2px);
  border: calc(3px * var(--pet-scale, 1)) solid rgb(95 73 73);
  border-radius: 0;
  background: rgb(216 224 233);
}

.counter-box {
  display: grid;
  left: 3.3%;
  width: 66%;
  place-items: center;
  color: #171717;
  font-family: 'SFMono-Regular', Menlo, Monaco, 'Cascadia Mono', Consolas, 'Liberation Mono', monospace;
  font-size: calc(11px * var(--pet-scale, 1));
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: calc(0.15px * var(--pet-scale, 1));
  line-height: 1;
  white-space: nowrap;
}

.menu-button {
  display: grid;
  left: 74.2%;
  width: 22.12%;
  aspect-ratio: 1;
  place-items: center;
  padding: 0;
  color: rgb(95 73 73);
  cursor: pointer;
  outline: none;
  transition: background-color 80ms ease;
}

.menu-button:active {
  background: rgb(198 210 221);
}

.menu-icon {
  width: 100%;
  height: 100%;
  fill: currentcolor;
  pointer-events: none;
}
</style>
