<script setup lang="ts">
defineProps<{
  heading: string
  body?: string
}>()
</script>

<template>
  <div class="plain">
    <h1>{{ heading }}</h1>
    <p>{{ body }}</p>
    <slot />
  </div>
</template>
