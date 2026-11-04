<script setup lang="ts">
defineProps<{
  heading: string
  description?: string
}>()
const accent = `${import.meta.env.BASE_URL}theme/sample.png`
</script>

<template>
  <div class="section">
    <h1 class="section-title">
      {{ heading }}
    </h1>
    <img class="section-accent" :src="accent" alt="" width="120" height="8">
    <p class="section-description">
      {{ description }}
    </p>
    <slot />
  </div>
</template>

<style scoped>
/* 装飾の CSS animation だけを持つ（data-pptx-animation の明示指定は無い）。 */
.section-title,
.section-description {
  animation: section-rise 0.8s ease both;
}

.section-accent {
  display: block;
  width: 120px;
  height: 8px;
  animation: section-grow 0.8s ease forwards;
}

@keyframes section-rise {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@keyframes section-grow {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}
</style>
