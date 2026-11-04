<script setup lang="ts">
defineProps<{
  heading: string
}>()
</script>

<template>
  <div class="marked">
    <h1>{{ heading }}</h1>
    <div class="marker-frame">
      <slot />
    </div>
  </div>
</template>
