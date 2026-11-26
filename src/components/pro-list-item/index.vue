<script setup lang="ts">
defineProps<{
  title: string
  description?: string
  vertical?: boolean
}>()
</script>

<template>
  <div
    class="settings-row"
    :class="{ 'settings-row-vertical': vertical }"
  >
    <div class="settings-row-label">
      <span>{{ title }}</span>
      <div
        v-if="description || $slots.description"
        class="settings-row-detail"
      >
        <slot name="description">
          {{ description }}
        </slot>
      </div>
    </div>
    <slot />
  </div>
</template>
