<script setup lang="ts" generic="T extends string">
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, ref, useId, watch } from 'vue'

const props = defineProps<{
  modelValue: T
  options: readonly (readonly [T, string])[]
  label: string
  alignEnd?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()
const menuId = useId()
const root = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const menu = ref<HTMLElement>()
const open = ref(false)
const activeIndex = ref(0)
const menuMaxHeight = ref(160)
const selectedLabel = computed(() => props.options.find(([value]) => value === props.modelValue)?.[1] ?? props.label)

function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus) trigger.value?.focus({ preventScroll: true })
}

async function focusOption(index: number) {
  activeIndex.value = index
  await nextTick()
  if (!open.value) return
  const option = menu.value?.querySelectorAll<HTMLButtonElement>('[role="option"]')[index]
  option?.focus({ preventScroll: true })
  option?.scrollIntoView({ block: 'nearest' })
}

function show(edge?: 'first' | 'last') {
  if (!props.options.length) return
  const bounds = root.value?.getBoundingClientRect()
  const panel = root.value?.closest('.news-panel')?.getBoundingClientRect()
  if (bounds && panel && root.value?.offsetHeight) {
    const scale = bounds.height / root.value.offsetHeight
    menuMaxHeight.value = Math.max(24, Math.floor((panel.bottom - bounds.bottom - 6) / scale))
  }
  open.value = true
  const selected = props.options.findIndex(([value]) => value === props.modelValue)
  void focusOption(edge === 'first' ? 0 : edge === 'last' ? props.options.length - 1 : Math.max(0, selected))
}

function choose(value: T) {
  close(true)
  emit('update:modelValue', value)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    event.stopPropagation()
    close(true)
    return
  }
  if (event.key === 'Tab' && open.value) {
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
  const count = props.options.length
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (activeIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
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
useEventListener(window, 'resize', () => close())
watch(() => props.options, () => close())
</script>

<template>
  <div
    ref="root"
    class="news-filter-select"
    @click.stop
    @focusout="onFocusout"
    @keydown="onKeydown"
    @pointerdown.stop
    @wheel.stop
  >
    <button
      ref="trigger"
      :aria-controls="open ? menuId : undefined"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-label="`${label}：${selectedLabel}`"
      class="filter-trigger"
      :title="label"
      type="button"
      @click="open ? close() : show()"
    >
      <span>{{ selectedLabel }}</span>
      <svg
        aria-hidden="true"
        :class="{ open }"
        viewBox="0 0 12 12"
      ><path d="m3 4.5 3 3 3-3" /></svg>
    </button>
    <div
      v-if="open"
      :id="menuId"
      ref="menu"
      :aria-label="label"
      class="filter-options"
      :class="{ 'align-end': alignEnd }"
      role="listbox"
      :style="{ maxHeight: `${menuMaxHeight}px` }"
    >
      <button
        v-for="([value, text], index) in options"
        :key="value"
        :aria-selected="value === modelValue"
        class="filter-option"
        role="option"
        tabindex="-1"
        type="button"
        @click="choose(value)"
        @focus="activeIndex = index"
      >
        <span>{{ text }}</span>
        <svg
          aria-hidden="true"
          :class="{ selected: value === modelValue }"
          viewBox="0 0 12 12"
        ><path d="m2 6 3 3 5-6" /></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.news-filter-select {
  position: relative;
  min-width: 0;
  height: 19px;
  color: #655b5c;
  font-size: 9px;
}
.filter-trigger,
.filter-option {
  display: flex;
  box-sizing: border-box;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 3px;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.filter-trigger {
  height: 19px;
  padding: 0 4px;
  border: 1px solid rgb(68 61 62 / 12%);
  border-radius: 5px;
  background: rgb(255 255 255 / 65%);
}
.filter-trigger > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.filter-trigger svg,
.filter-option svg {
  width: 9px;
  height: 9px;
  flex: none;
  fill: none;
  stroke: currentcolor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.4;
}
.filter-trigger svg.open {
  transform: rotate(180deg);
}
.filter-options {
  position: absolute;
  z-index: 5;
  top: calc(100% + 4px);
  left: 0;
  box-sizing: border-box;
  min-width: 72px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 3px;
  border: 1px solid rgb(68 61 62 / 16%);
  border-radius: 6px;
  background: #fffaf3;
  box-shadow: 0 2px 7px rgb(68 61 62 / 12%);
  scrollbar-color: #b7ada8 transparent;
  scrollbar-width: thin;
}
.filter-options.align-end {
  right: 0;
  left: auto;
}
.filter-option {
  min-height: 23px;
  padding: 4px 5px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  white-space: nowrap;
}
.filter-option svg {
  visibility: hidden;
}
.filter-option svg.selected {
  visibility: visible;
}
.filter-option[aria-selected='true'] {
  background: rgb(68 61 62 / 8%);
  font-weight: 600;
}
.filter-trigger:hover,
.filter-trigger[aria-expanded='true'],
.filter-option:hover {
  background: rgb(68 61 62 / 12%);
}
.filter-trigger:focus-visible,
.filter-option:focus {
  box-shadow: inset 0 0 0 2px #817576;
}
</style>
