<script setup lang="ts">
defineProps<{
  heading: string
}>()
</script>

<template>
  <div class="scratch">
    <h1>{{ heading }}</h1>
    <slot />
  </div>
</template>
