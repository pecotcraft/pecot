<script setup lang="ts">
defineProps<{
  heading: string
  message?: string
}>()
</script>

<template>
  <div class="end">
    <h1>{{ heading }}</h1>
    <p>{{ message }}</p>
    <slot />
  </div>
</template>
