<script setup lang="ts">
defineProps<{
  heading: string
  subtitle?: string
}>()
</script>

<template>
  <div class="cover">
    <h1>{{ heading }}</h1>
    <p>{{ subtitle }}</p>
    <slot />
  </div>
</template>
