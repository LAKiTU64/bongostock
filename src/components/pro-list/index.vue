<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <section class="settings-section">
    <h2 class="settings-section-title">
      {{ title }}
    </h2>
    <div class="settings-group">
      <slot />
    </div>
  </section>
</template>
