<script setup lang="ts">
import { decorate } from 'pecotv-test-theme-dep'

const props = defineProps<{
  heading: string
  caption?: string
}>()
const sample = `${import.meta.env.BASE_URL}theme/sample.svg`
const decorated = decorate(props.heading)
</script>

<template>
  <div class="panel">
    <h1>{{ decorated }}</h1>
    <img :src="sample" alt="" width="400" height="300">
    <p>{{ caption }}</p>
  </div>
</template>
