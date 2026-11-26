<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{ label: string, min: number, max: number }>()
const value = defineModel<number>({ required: true })
const readoutId = useId()
const progress = computed(() => 100 * (Math.min(props.max, Math.max(props.min, value.value)) - props.min) / (props.max - props.min))
</script>

<template>
  <div class="percent-control">
    <div
      class="slider"
      dir="ltr"
      :style="{ '--progress': `${progress}%` }"
    >
      <input
        v-model.number="value"
        :aria-describedby="readoutId"
        :aria-label="label"
        :aria-valuetext="`${value}%`"
        :max="max"
        :min="min"
        step="1"
        type="range"
      >
      <div
        aria-hidden="true"
        class="rail"
      >
        <span class="fill" /><span class="thumb" />
      </div>
    </div>
    <span
      :id="readoutId"
      aria-hidden="true"
      class="percent-value"
    >{{ value }}%</span>
  </div>
</template>

<style scoped>
.percent-control {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
}
.slider {
  --thumb-size: 16px;
  position: relative;
  width: clamp(65px, 17vw, 150px);
  height: 32px;
}
.slider input {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  appearance: none;
  -webkit-appearance: none;
  opacity: 0;
  cursor: pointer;
  touch-action: none;
}
.slider input::-webkit-slider-runnable-track {
  height: var(--thumb-size);
  border: 0;
  padding: 0;
}
.slider input::-webkit-slider-thumb {
  box-sizing: border-box;
  width: var(--thumb-size);
  height: var(--thumb-size);
  margin: 0;
  border: 0;
  -webkit-appearance: none;
}
.slider input::-moz-range-track {
  height: var(--thumb-size);
  border: 0;
  padding: 0;
}
.slider input::-moz-range-thumb {
  box-sizing: border-box;
  width: var(--thumb-size);
  height: var(--thumb-size);
  border: 0;
}
.rail {
  position: absolute;
  top: 50%;
  inset-inline: calc(var(--thumb-size) / 2);
  height: 4px;
  transform: translateY(-50%);
  border-radius: 9px;
  background: var(--settings-line);
  pointer-events: none;
}
.fill {
  display: block;
  width: var(--progress);
  height: 100%;
  border-radius: inherit;
  background: var(--settings-accent);
}
.thumb {
  position: absolute;
  top: 50%;
  left: var(--progress);
  box-sizing: border-box;
  width: var(--thumb-size);
  height: var(--thumb-size);
  transform: translate(-50%, -50%);
  border: 2px solid var(--settings-accent);
  border-radius: 50%;
  background: var(--settings-surface);
}
.slider input:focus-visible + .rail .thumb {
  outline: 2px solid var(--settings-accent);
  outline-offset: 3px;
}
.slider input:active + .rail .thumb {
  background: var(--settings-selected);
}
.percent-value {
  min-width: 38px;
  color: var(--settings-muted);
  font-variant-numeric: tabular-nums;
  text-align: end;
}
</style>
