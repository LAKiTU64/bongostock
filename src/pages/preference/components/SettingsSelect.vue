<script setup lang="ts" generic="T extends string">
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, ref, useId, watch } from 'vue'

const props = defineProps<{
  id?: string
  label: string
  options: readonly { label: string, value: T }[]
}>()
const value = defineModel<T>({ required: true })
const listId = useId()
const trigger = ref<HTMLButtonElement>()
const menu = ref<HTMLUListElement>()
const open = ref(false)
const active = ref(0)
const popupStyle = ref<{ right: string, top?: string, bottom?: string, minWidth: string, maxHeight: string }>()
const selected = computed(() => props.options.findIndex(option => option.value === value.value))
let prefix = ''
let lastTyped = 0

function close(restore = false) {
  open.value = false
  prefix = ''
  if (restore) trigger.value?.focus({ preventScroll: true })
}

function position() {
  if (!open.value || !trigger.value) return
  const rect = trigger.value.getBoundingClientRect()
  const pane = trigger.value.closest('.preferences-pane')?.getBoundingClientRect()
  if (rect.bottom <= Math.max(0, pane?.top ?? 0) || rect.top >= Math.min(window.innerHeight, pane?.bottom ?? Infinity)) {
    close()
    return
  }
  const gap = 4
  const margin = 8
  const down = window.innerHeight - rect.bottom - gap - margin
  const up = rect.top - gap - margin
  const above = down < (menu.value?.scrollHeight || props.options.length * 34 + 8) && up > down
  const minWidth = Math.min(rect.width, window.innerWidth - 2 * margin)
  const right = Math.max(margin, Math.min(window.innerWidth - rect.right, window.innerWidth - minWidth - margin))
  popupStyle.value = {
    right: `${right}px`,
    ...(above ? { bottom: `${window.innerHeight - rect.top + gap}px` } : { top: `${rect.bottom + gap}px` }),
    minWidth: `${minWidth}px`,
    maxHeight: `${Math.max(0, above ? up : down)}px`,
  }
}

function highlight(index: number) {
  active.value = Math.max(0, Math.min(index, props.options.length - 1))
  void nextTick(() => {
    if (open.value) menu.value?.children[active.value]?.scrollIntoView({ block: 'nearest' })
  })
}

function show() {
  if (!props.options.length) return
  open.value = true
  trigger.value?.focus({ preventScroll: true })
  position()
  highlight(selected.value)
  void nextTick(position)
}

function choose(index: number, restore = true) {
  const option = props.options[index]
  if (option) value.value = option.value
  close(restore)
}

function keydown(event: KeyboardEvent) {
  if (event.isComposing || event.metaKey || event.ctrlKey) return
  const key = event.key
  if (key === 'Tab') {
    if (open.value) choose(active.value, false)
    return
  }
  if (key === 'Escape') {
    if (!open.value) return
    close(true)
  } else if (key === 'Enter' || key === ' ') {
    if (open.value) choose(active.value)
    else show()
  } else if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End') {
    const wasOpen = open.value
    if (!wasOpen) show()
    if (key === 'Home') highlight(0)
    else if (key === 'End') highlight(props.options.length - 1)
    else if (event.altKey && key === 'ArrowUp') choose(active.value)
    else if (wasOpen && !event.altKey) highlight(active.value + (key === 'ArrowDown' ? 1 : -1))
  } else if (!event.altKey && key.length === 1) {
    const now = performance.now()
    const char = key.toLocaleLowerCase()
    prefix = now - lastTyped < 750 ? prefix + char : char
    lastTyped = now
    const repeated = [...prefix].every(letter => letter === char)
    const text = repeated ? char : prefix
    const from = (open.value ? active.value : selected.value) + (repeated ? 1 : 0)
    const ordered = props.options.map((_, i) => (from + i + props.options.length) % props.options.length)
    const next = ordered.find(i => props.options[i]!.label.toLocaleLowerCase().startsWith(text))
    if (next !== undefined) {
      if (open.value) highlight(next)
      else value.value = props.options[next]!.value
    }
  } else {
    return
  }
  event.preventDefault()
  event.stopPropagation()
}

watch(selected, () => {
  if (open.value) highlight(selected.value)
})
useEventListener(document, 'pointerdown', (event) => {
  const target = event.target as Node
  if (open.value && !trigger.value?.contains(target) && !menu.value?.contains(target)) close()
}, { capture: true })
useEventListener(window, 'resize', position)
useEventListener(document, 'scroll', (event) => {
  if (!menu.value?.contains(event.target as Node)) position()
}, { capture: true, passive: true })
useEventListener(window, 'blur', () => close())
</script>

<template>
  <button
    :id="id"
    ref="trigger"
    :aria-activedescendant="open ? `${listId}-${active}` : undefined"
    :aria-controls="open ? listId : undefined"
    :aria-expanded="open"
    aria-haspopup="listbox"
    :aria-label="label"
    class="settings-input select-trigger"
    role="combobox"
    type="button"
    @blur="close()"
    @click="open ? close(true) : show()"
    @keydown="keydown"
  >
    <span>{{ options[selected]?.label }}</span><i
      aria-hidden="true"
      class="i-lucide:chevron-down"
    />
  </button>
  <Teleport to="body">
    <ul
      v-if="open"
      :id="listId"
      ref="menu"
      :aria-label="label"
      class="select-menu"
      role="listbox"
      :style="popupStyle"
      @mousedown.prevent
    >
      <li
        v-for="(option, index) in options"
        :id="`${listId}-${index}`"
        :key="option.value"
        :aria-selected="option.value === value"
        :class="{ active: index === active }"
        role="option"
        @click="choose(index)"
        @pointermove="active = index"
      >
        <span>{{ option.label }}</span><i
          v-if="option.value === value"
          aria-hidden="true"
          class="i-lucide:check"
        />
      </li>
    </ul>
  </Teleport>
</template>

<style scoped>
.select-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: min(128px, 48%);
  max-width: 55%;
  text-align: start;
  cursor: pointer;
}
.select-trigger span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.select-trigger i,
.select-menu i {
  flex: none;
  width: 15px;
  height: 15px;
}
.select-trigger i {
  color: var(--settings-muted);
}
.select-trigger[aria-expanded='true'] {
  border-color: var(--settings-accent);
}
.select-menu {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  width: max-content;
  max-width: calc(100vw - 16px);
  margin: 0;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid var(--settings-line);
  border-radius: 8px;
  background: var(--settings-surface);
  color: var(--settings-ink);
  box-shadow: 0 4px 16px rgb(0 0 0 / 12%);
  font: 14px/1.45 var(--font-ui, system-ui);
  list-style: none;
  overscroll-behavior: contain;
}
.select-menu li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  min-height: 31px;
  padding: 4px 8px;
  border-radius: 5px;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.select-menu li.active {
  background: var(--settings-selected);
}
.select-menu i {
  color: var(--settings-accent);
}
</style>
