<script setup lang="ts">
interface Card {
  title: string
  description?: string
  url: string
}

defineProps<{
  heading: string
  cards?: Card[]
}>()
</script>

<template>
  <div class="link">
    <h1>{{ heading }}</h1>
    <ul>
      <li v-for="(card, index) in cards ?? []" :key="index">
        <a :href="card.url">{{ card.title }}</a>
        <span>{{ card.description }}</span>
      </li>
    </ul>
    <slot />
  </div>
</template>
