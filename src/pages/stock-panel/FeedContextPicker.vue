<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, ref, useId, watch } from 'vue'

const props = defineProps<{
  folders: readonly { id: string, title: string }[]
  selectedId?: string
  disabled?: boolean
  label?: string
  triggerTitle?: string
}>()
const emit = defineEmits<{ select: [id: string] }>()
const menuId = useId()
const root = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const menu = ref<HTMLElement>()
const open = ref(false)
const activeIndex = ref(0)
const pickerLabel = computed(() => props.label || '收藏夹')
const selectedTitle = computed(() => props.triggerTitle || props.folders.find(folder => folder.id === props.selectedId)?.title || pickerLabel.value)

function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus) trigger.value?.focus({ preventScroll: true })
}

async function focusOption(index: number) {
  activeIndex.value = index
  await nextTick()
  if (!open.value) return
  const option = menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[index]
  option?.focus({ preventScroll: true })
  option?.scrollIntoView({ block: 'nearest' })
}

function show(edge?: 'first' | 'last') {
  if (props.disabled || !props.folders.length) return
  open.value = true
  const selected = props.folders.findIndex(folder => folder.id === props.selectedId)
  void focusOption(edge === 'first' ? 0 : edge === 'last' ? props.folders.length - 1 : Math.max(0, selected))
}

function choose(id: string) {
  close(true)
  emit('select', id)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    // The window also handles Escape; dismiss only this menu on the first press.
    event.stopPropagation()
    close(true)
    return
  }
  if (event.key === 'Tab' && open.value) {
    // Resume normal tab order from the trigger, not from an about-to-be-removed item.
    close(true)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  if (!open.value) {
    show(event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined)
    return
  }
  const count = props.folders.length
  const index = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? count - 1
      : (activeIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
  void focusOption(index)
}

function onFocusout(event: FocusEvent) {
  if (!(event.relatedTarget instanceof Node) || !root.value?.contains(event.relatedTarget)) close()
}

useEventListener(document, 'pointerdown', (event) => {
  if (event.target instanceof Node && !root.value?.contains(event.target)) close()
}, { capture: true })
useEventListener(document, 'visibilitychange', () => {
  if (document.hidden) close()
})
useEventListener(window, 'blur', () => close())
watch(() => props.disabled, (disabled) => {
  if (disabled) close()
})
watch(() => props.folders, () => {
  if (open.value) close(true)
})
</script>

<template>
  <div
    ref="root"
    class="folder-picker"
    @focusout="onFocusout"
    @keydown="onKeydown"
    @wheel.stop
  >
    <button
      ref="trigger"
      :aria-controls="open ? menuId : undefined"
      :aria-expanded="open"
      aria-haspopup="menu"
      :aria-label="`${pickerLabel}：${selectedTitle}`"
      class="folder-trigger"
      :disabled="disabled"
      type="button"
      @click="open ? close() : show()"
    >
      <span class="folder-name">{{ selectedTitle }}</span>
      <svg
        aria-hidden="true"
        class="folder-chevron"
        :class="{ open }"
        viewBox="0 0 12 12"
      ><path d="m3 7 3-3 3 3" /></svg>
    </button>
    <div
      v-if="open"
      :id="menuId"
      ref="menu"
      :aria-label="pickerLabel"
      class="folder-menu"
      role="menu"
    >
      <button
        v-for="(folder, index) in folders"
        :key="folder.id"
        :aria-checked="folder.id === selectedId"
        class="folder-option"
        role="menuitemradio"
        tabindex="-1"
        type="button"
        @click="choose(folder.id)"
        @focus="activeIndex = index"
      >
        <span class="folder-option-name">{{ folder.title }}</span>
        <svg
          aria-hidden="true"
          class="folder-check"
          :class="{ selected: folder.id === selectedId }"
          viewBox="0 0 12 12"
        ><path d="m2 6 3 3 5-6" /></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.folder-picker {
  min-width: 0;
  max-width: 100%;
  height: 20px;
  flex: 1;
  color: #443d3e;
}

.folder-trigger,
.folder-option {
  display: flex;
  box-sizing: border-box;
  align-items: center;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.folder-trigger {
  max-width: 100%;
  height: 20px;
  gap: 4px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 20px;
}

.folder-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-chevron,
.folder-check {
  width: 10px;
  height: 10px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.4;
}

.folder-chevron.open {
  transform: rotate(180deg);
}

/* The containing .list is positioned: the popup overlays cards, never the footer
   or source tabs, and its size is bounded by that same list at any window size. */
.folder-menu {
  position: absolute;
  z-index: 2;
  right: 4px;
  bottom: calc(var(--video-footer-height) + 4px);
  left: 4px;
  box-sizing: border-box;
  max-height: calc(100% - var(--video-footer-height) - 8px);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 3px;
  border: 1px solid rgb(68 61 62 / 16%);
  border-radius: 7px;
  background: #fffaf3;
  box-shadow: 0 2px 7px rgb(68 61 62 / 12%);
  scrollbar-color: #b7ada8 transparent;
  scrollbar-width: thin;
}

.folder-option {
  width: 100%;
  min-height: 25px;
  justify-content: space-between;
  gap: 7px;
  padding: 5px 7px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 14px;
}

.folder-option-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.folder-check {
  visibility: hidden;
}

.folder-check.selected {
  visibility: visible;
}

.folder-option[aria-checked='true'] {
  background: rgb(68 61 62 / 8%);
  font-weight: 600;
}

.folder-trigger:hover:not(:disabled),
.folder-trigger[aria-expanded='true'],
.folder-option:hover {
  background: rgb(68 61 62 / 12%);
}

.folder-trigger:focus-visible,
.folder-option:focus-visible {
  outline: 2px solid #817576;
  outline-offset: -2px;
}

.folder-trigger:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
